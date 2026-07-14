import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { redactSecrets } from "../../redact.js";
import { canonicalizeProviderHome } from "../task-key.js";

export const CLAUDE_AGENT_SDK_PINNED_VERSION = "0.3.207";
export const CLAUDE_SESSION_HELPER_DEFAULT_LIMIT = 50;
export const CLAUDE_SESSION_HELPER_MAX_LIMIT = 200;
export const CLAUDE_SESSION_HELPER_MAX_OFFSET = 1_000_000;
export const CLAUDE_SESSION_HELPER_DEFAULT_TIMEOUT_MS = 10_000;
export const CLAUDE_SESSION_HELPER_MAX_TIMEOUT_MS = 60_000;
export const CLAUDE_SESSION_HELPER_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const CLAUDE_SESSION_HELPER_MAX_STDERR_BYTES = 32 * 1024;
export const CLAUDE_SESSION_HELPER_MAX_STDIN_BYTES = 64 * 1024;
export const CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES = 4_096;
export const CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES = 4;

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_TEXT_CHARS = 32_768;
const MAX_TITLE_CHARS = 1_024;
const MAX_PATH_CHARS = 16_384;
const SDK_ENTRYPOINT = createRequire(import.meta.url).resolve(
  "@anthropic-ai/claude-agent-sdk",
);

export type ClaudeSessionHelperErrorCode =
  | "ABORTED"
  | "CAPACITY"
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "PROCESS_FAILED"
  | "PROTOCOL_FAULT"
  | "SDK_FAILED"
  | "TIMEOUT";

export class ClaudeSessionHelperError extends Error {
  readonly code: ClaudeSessionHelperErrorCode;

  constructor(code: ClaudeSessionHelperErrorCode, message: string) {
    super(message);
    this.name = "ClaudeSessionHelperError";
    this.code = code;
    Object.freeze(this);
  }
}

export interface ClaudeSessionSummarySnapshot {
  readonly sessionId: string;
  readonly title: string | null;
  readonly summary: string;
  readonly cwd: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string;
  readonly fileSize: number | null;
}

export interface ClaudeSessionTextMessageSnapshot {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export interface ClaudeSessionMessagesSnapshot {
  readonly messages: readonly ClaudeSessionTextMessageSnapshot[];
  readonly limit: number;
  readonly offset: number;
  /** Number of raw SDK rows consumed, including valid rows with no text projection. */
  readonly rawCount: number;
}

export interface ClaudeSessionHelperInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface ClaudeSessionHelperProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ClaudeSessionHelperProcessRunner = (
  invocation: ClaudeSessionHelperInvocation,
  signal?: AbortSignal,
) => Promise<ClaudeSessionHelperProcessResult>;

export interface ClaudeSessionHelpersOptions {
  readonly configHome: string;
  readonly cwd: string;
  readonly scope?: "project" | "all-projects";
  readonly canonicalizePath?: (value: string) => string;
  readonly runProcess?: ClaudeSessionHelperProcessRunner;
  readonly timeoutMs?: number;
}

export interface ClaudeSessionHelperCallOptions {
  readonly signal?: AbortSignal;
}

export interface ClaudeSessionListOptions extends ClaudeSessionHelperCallOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export interface ClaudeSessionForkOptions extends ClaudeSessionHelperCallOptions {
  readonly upToMessageId?: string;
}

const helperError = (
  code: ClaudeSessionHelperErrorCode,
  message: string,
): ClaudeSessionHelperError => new ClaudeSessionHelperError(code, message);

let activeHelperProcesses = 0;

const acquireHelperProcessCapacity = (): boolean => {
  if (activeHelperProcesses >= CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES) return false;
  activeHelperProcesses += 1;
  return true;
};

const releaseHelperProcessCapacity = (): void => {
  activeHelperProcesses -= 1;
};

class ProcessRunnerFailure extends Error {
  constructor(readonly kind: "ABORTED" | "FAILED" | "TIMEOUT") {
    super("Claude session helper process failed");
  }
}

const CHILD_SCRIPT = String.raw`
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";
const PINNED_VERSION = "0.3.207";
const MAX_INPUT = 65536;
const MAX_OUTPUT = 2097152;

const exactKeys = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT) throw new Error("input");
  }
  const request = JSON.parse(input);
  if (!exactKeys(request, ["version", "sdkVersion", "method", "args"]) ||
      request.version !== 1 || request.sdkVersion !== PINNED_VERSION ||
      !Array.isArray(request.args)) throw new Error("request");

  const sdkEntry = process.argv[1];
  if (typeof sdkEntry !== "string" || !path.isAbsolute(sdkEntry)) throw new Error("sdk");
  const resolved = pathToFileURL(sdkEntry).href;
  let cursor = path.dirname(sdkEntry);
  let version = null;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(cursor, "package.json"), "utf8"));
      if (manifest.name === SDK_SPECIFIER) {
        version = manifest.version;
        break;
      }
    } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (version !== PINNED_VERSION) throw new Error("version");
  const sdk = await import(resolved);
  let value;
  switch (request.method) {
    case "listSessions":
      value = await sdk.listSessions(...request.args);
      break;
    case "getSessionInfo":
      value = await sdk.getSessionInfo(...request.args);
      break;
    case "getSessionMessages":
      value = await sdk.getSessionMessages(...request.args);
      break;
    case "renameSession":
      value = await sdk.renameSession(...request.args);
      break;
    case "forkSession":
      value = await sdk.forkSession(...request.args);
      break;
    case "deleteSession":
      value = await sdk.deleteSession(...request.args);
      break;
    default:
      throw new Error("method");
  }
  const output = JSON.stringify({ ok: true, value: value === undefined ? null : value });
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT) throw new Error("output");
  process.stdout.write(output + "\n");
} catch {
  process.stdout.write('{"ok":false,"code":"SDK_FAILURE"}\n');
}
`;

const isolatedProcessRunner: ClaudeSessionHelperProcessRunner = (
  invocation,
  signal,
) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new ProcessRunnerFailure("ABORTED"));
    return;
  }
  let child;
  try {
    child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    reject(new ProcessRunnerFailure("FAILED"));
    return;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = (): void => {
    if (timer) clearTimeout(timer);
    try {
      signal?.removeEventListener("abort", onAbort);
    } catch {
      // The process is already terminal; hostile listener cleanup cannot revive it.
    }
  };
  const finishFailure = (kind: "ABORTED" | "FAILED" | "TIMEOUT"): void => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort containment after logical ownership has ended.
    }
    reject(new ProcessRunnerFailure(kind));
  };
  const onAbort = (): void => finishFailure("ABORTED");

  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) return;
    const buffer = Buffer.from(chunk);
    stdoutBytes += buffer.byteLength;
    if (stdoutBytes > invocation.maxStdoutBytes) {
      finishFailure("FAILED");
      return;
    }
    stdout.push(buffer);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (settled) return;
    const buffer = Buffer.from(chunk);
    stderrBytes += buffer.byteLength;
    if (stderrBytes > invocation.maxStderrBytes) {
      finishFailure("FAILED");
      return;
    }
    stderr.push(buffer);
  });
  child.once("error", () => finishFailure("FAILED"));
  child.once("close", (exitCode) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
  try {
    timer = setTimeout(() => finishFailure("TIMEOUT"), invocation.timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!settled) child.stdin.end(invocation.stdin, "utf8");
  } catch {
    finishFailure("FAILED");
  }
});

/** @internal Exported so the real, capacity-gated isolation boundary can be integration-tested. */
export const runClaudeSessionHelperProcess: ClaudeSessionHelperProcessRunner = async (
  invocation,
  signal,
) => {
  if (!acquireHelperProcessCapacity()) {
    throw helperError("CAPACITY", "Claude session helper process capacity is exhausted");
  }
  try {
    return await isolatedProcessRunner(invocation, signal);
  } finally {
    releaseHelperProcessCapacity();
  }
};

const validSessionId = (value: unknown): value is string =>
  typeof value === "string" && SESSION_UUID.test(value);

const sessionId = (value: unknown): string => {
  if (!validSessionId(value)) {
    throw helperError("INVALID_INPUT", "Claude session id is invalid");
  }
  return value;
};

const responseSessionId = (value: unknown): string => {
  if (!validSessionId(value)) {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  return value;
};

const messageId = (value: unknown): string => {
  if (!validSessionId(value)) {
    throw helperError("INVALID_INPUT", "Claude session message id is invalid");
  }
  return value;
};

const pagination = (
  limitValue: unknown,
  offsetValue: unknown,
): { readonly limit: number; readonly offset: number } => {
  const limit = limitValue ?? CLAUDE_SESSION_HELPER_DEFAULT_LIMIT;
  const offset = offsetValue ?? 0;
  if (
    typeof limit !== "number" || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > CLAUDE_SESSION_HELPER_MAX_LIMIT ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) ||
    offset < 0 || offset > CLAUDE_SESSION_HELPER_MAX_OFFSET
  ) {
    throw helperError("INVALID_INPUT", "Claude session pagination is invalid");
  }
  return Object.freeze({ limit, offset });
};

const safeText = (value: unknown, maximum = MAX_TEXT_CHARS): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maximum || value.includes("\u0000")) {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  return redactSecrets(value);
};

const safeRequiredText = (value: unknown): string => {
  const text = safeText(value);
  if (text === null) throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  return text;
};

const safePath = (value: unknown): string | null => safeText(value, MAX_PATH_CHARS);

const safeTimestamp = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  try {
    const date = typeof value === "number" ? new Date(value) : new Date(safeRequiredText(value));
    if (!Number.isFinite(date.valueOf())) throw new Error();
    return date.toISOString();
  } catch {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
};

const jsonRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  return value as Record<string, unknown>;
};

const summarySnapshot = (value: unknown): Readonly<ClaudeSessionSummarySnapshot> => {
  const raw = jsonRecord(value);
  const id = responseSessionId(raw.sessionId);
  const summary = safeRequiredText(raw.summary);
  const title = safeText(raw.customTitle) ?? summary;
  const cwd = safePath(raw.cwd);
  let fileSize: number | null = null;
  if (raw.fileSize !== undefined) {
    if (
      typeof raw.fileSize !== "number" || !Number.isSafeInteger(raw.fileSize) ||
      raw.fileSize < 0
    ) {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
    fileSize = raw.fileSize;
  }
  if (
    typeof raw.lastModified !== "number" ||
    !Number.isSafeInteger(raw.lastModified) ||
    raw.lastModified < 0 ||
    (raw.createdAt !== undefined && (
      typeof raw.createdAt !== "number" ||
      !Number.isSafeInteger(raw.createdAt) ||
      raw.createdAt < 0
    ))
  ) {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  const createdAt = safeTimestamp(raw.createdAt);
  const updatedAt = safeTimestamp(raw.lastModified)!;
  return Object.freeze({
    sessionId: id,
    title,
    summary,
    cwd,
    createdAt,
    updatedAt,
    fileSize,
  });
};

const sessionArray = (value: unknown, limit: number): readonly ClaudeSessionSummarySnapshot[] => {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(jsonRecord(value).sessions)
      ? jsonRecord(value).sessions as unknown[]
      : null;
  if (!raw || raw.length > limit) {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  return Object.freeze(raw.map(summarySnapshot));
};

const messageArray = (
  value: unknown,
  limit: number,
  expectedSessionId: string,
): Readonly<{
  readonly messages: readonly ClaudeSessionTextMessageSnapshot[];
  readonly rawCount: number;
}> => {
  const rawMessages = Array.isArray(value)
    ? value
    : Array.isArray(jsonRecord(value).messages)
      ? jsonRecord(value).messages as unknown[]
      : null;
  if (!rawMessages || rawMessages.length > limit) {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  const projected: ClaudeSessionTextMessageSnapshot[] = [];
  for (const rawValue of rawMessages) {
    const raw = jsonRecord(rawValue);
    if (raw.session_id !== expectedSessionId) {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
    const roleValue = raw.type;
    if (roleValue !== "user" && roleValue !== "assistant" && roleValue !== "system") continue;
    const id = responseSessionId(raw.uuid);
    let message: Record<string, unknown>;
    if (raw.message === undefined) {
      message = raw;
    } else if (raw.message !== null && typeof raw.message === "object" && !Array.isArray(raw.message)) {
      message = raw.message as Record<string, unknown>;
    } else if (roleValue === "system") {
      continue;
    } else {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
    if (message.role !== undefined && message.role !== roleValue) {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
    const content = message.content ?? raw.content;
    let text: string;
    if (typeof content === "string") {
      text = safeRequiredText(content);
    } else {
      if (!Array.isArray(content)) {
        if (roleValue === "system") continue;
        throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
      }
      if (content.length > CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES) {
        throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
      }
      const parts: string[] = [];
      let joinedLength = 0;
      for (const blockValue of content) {
        if (blockValue === null || typeof blockValue !== "object" || Array.isArray(blockValue)) {
          if (roleValue === "system") continue;
          throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
        }
        const block = blockValue as Record<string, unknown>;
        if (block.type !== "text") continue;
        const part = safeRequiredText(block.text);
        const nextLength = joinedLength + (parts.length === 0 ? 0 : 1) + part.length;
        if (nextLength > MAX_TEXT_CHARS) {
          throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
        }
        parts.push(part);
        joinedLength = nextLength;
      }
      if (parts.length === 0) continue;
      text = safeRequiredText(parts.join("\n"));
    }
    projected.push(Object.freeze({ id, role: roleValue, text }));
    if (projected.length > CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES) {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
  }
  return Object.freeze({
    messages: Object.freeze(projected),
    rawCount: rawMessages.length,
  });
};

const parseResponse = (result: ClaudeSessionHelperProcessResult): unknown => {
  if (
    typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
    Buffer.byteLength(result.stdout, "utf8") > CLAUDE_SESSION_HELPER_MAX_STDOUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > CLAUDE_SESSION_HELPER_MAX_STDERR_BYTES
  ) {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  if (result.exitCode !== 0) {
    throw helperError("PROCESS_FAILED", "Claude session helper process failed");
  }
  if (!/^[^\r\n]*\n$/u.test(result.stdout)) {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.slice(0, -1));
  } catch {
    throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }
  const response = jsonRecord(parsed);
  const keys = Object.keys(response);
  if (response.ok === true) {
    if (keys.length !== 2 || !keys.includes("value")) {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
    return response.value;
  }
  if (
    response.ok === false && response.code === "SDK_FAILURE" &&
    keys.length === 2 && keys.includes("code")
  ) {
    throw helperError("SDK_FAILED", "Claude Agent SDK session helper failed");
  }
  throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
};

export class ClaudeSessionHelpers {
  private readonly configHome: string;
  private readonly cwd: string;
  private readonly sdkScopeOptions: Readonly<{ readonly dir?: string }>;
  private readonly runProcess: ClaudeSessionHelperProcessRunner;
  private readonly timeoutMs: number;

  constructor(options: ClaudeSessionHelpersOptions) {
    const canonicalize = options?.canonicalizePath ?? canonicalizeProviderHome;
    let configHome: string;
    let cwd: string;
    try {
      configHome = typeof options?.configHome === "string" ? canonicalize(options.configHome) : "";
      cwd = typeof options?.cwd === "string" ? canonicalize(options.cwd) : "";
    } catch {
      throw helperError("INVALID_CONFIGURATION", "Claude session helper configuration is invalid");
    }
    const scope = options?.scope === undefined ? "project" : options.scope;
    if (
      typeof options?.configHome !== "string" || configHome !== options.configHome ||
      typeof options.cwd !== "string" || cwd !== options.cwd ||
      !path.isAbsolute(configHome) || !path.isAbsolute(cwd) ||
      configHome.includes("\u0000") || cwd.includes("\u0000") ||
      (scope !== "project" && scope !== "all-projects") ||
      (options.runProcess !== undefined && typeof options.runProcess !== "function")
    ) {
      throw helperError("INVALID_CONFIGURATION", "Claude session helper configuration is invalid");
    }
    const timeoutMs = options.timeoutMs ?? CLAUDE_SESSION_HELPER_DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > CLAUDE_SESSION_HELPER_MAX_TIMEOUT_MS
    ) {
      throw helperError("INVALID_CONFIGURATION", "Claude session helper configuration is invalid");
    }
    this.configHome = configHome;
    this.cwd = cwd;
    this.sdkScopeOptions = Object.freeze(scope === "project" ? { dir: cwd } : {});
    this.runProcess = options.runProcess ?? isolatedProcessRunner;
    this.timeoutMs = timeoutMs;
  }

  async listSessions(options: ClaudeSessionListOptions = {}): Promise<readonly ClaudeSessionSummarySnapshot[]> {
    const page = pagination(options.limit, options.offset);
    const value = await this.call("listSessions", [{
      ...this.sdkScopeOptions,
      includeProgrammatic: true,
      limit: page.limit,
      offset: page.offset,
    }], options.signal);
    return sessionArray(value, page.limit);
  }

  async getSessionInfo(
    rawSessionId: string,
    options: ClaudeSessionHelperCallOptions = {},
  ): Promise<Readonly<ClaudeSessionSummarySnapshot> | null> {
    const id = sessionId(rawSessionId);
    const value = await this.call("getSessionInfo", [id, this.sdkScopeOptions], options.signal);
    if (value === null) return null;
    const summary = summarySnapshot(value);
    if (summary.sessionId !== id) {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
    return summary;
  }

  async getSessionMessages(
    rawSessionId: string,
    options: ClaudeSessionListOptions = {},
  ): Promise<Readonly<ClaudeSessionMessagesSnapshot>> {
    const id = sessionId(rawSessionId);
    const page = pagination(options.limit, options.offset);
    const value = await this.call("getSessionMessages", [id, {
      ...this.sdkScopeOptions,
      includeSystemMessages: true,
      limit: page.limit,
      offset: page.offset,
    }], options.signal);
    const projected = messageArray(value, page.limit, id);
    return Object.freeze({
      messages: projected.messages,
      limit: page.limit,
      offset: page.offset,
      rawCount: projected.rawCount,
    });
  }

  async renameSession(
    rawSessionId: string,
    rawTitle: string,
    options: ClaudeSessionHelperCallOptions = {},
  ): Promise<void> {
    const id = sessionId(rawSessionId);
    if (
      typeof rawTitle !== "string" || rawTitle.trim().length === 0 ||
      rawTitle.length > MAX_TITLE_CHARS || /[\u0000-\u001f\u007f]/u.test(rawTitle)
    ) throw helperError("INVALID_INPUT", "Claude session title is invalid");
    const value = await this.call(
      "renameSession",
      [id, rawTitle.trim(), this.sdkScopeOptions],
      options.signal,
    );
    if (value !== null) throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }

  async forkSession(
    rawSessionId: string,
    options: ClaudeSessionForkOptions = {},
  ): Promise<string> {
    const id = sessionId(rawSessionId);
    const upToMessageId = options.upToMessageId === undefined
      ? undefined
      : messageId(options.upToMessageId);
    const forkOptions = upToMessageId === undefined
      ? this.sdkScopeOptions
      : { ...this.sdkScopeOptions, upToMessageId };
    const value = await this.call("forkSession", [id, forkOptions], options.signal);
    let forked: Record<string, unknown>;
    try {
      forked = jsonRecord(value);
    } catch {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
    if (Object.keys(forked).length !== 1 || !validSessionId(forked.sessionId)) {
      throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
    }
    return forked.sessionId;
  }

  async deleteSession(
    rawSessionId: string,
    options: ClaudeSessionHelperCallOptions = {},
  ): Promise<void> {
    const id = sessionId(rawSessionId);
    const value = await this.call("deleteSession", [id, this.sdkScopeOptions], options.signal);
    if (value !== null) throw helperError("PROTOCOL_FAULT", "Claude session helper response is invalid");
  }

  private async call(
    method: "listSessions" | "getSessionInfo" | "getSessionMessages" |
      "renameSession" | "forkSession" | "deleteSession",
    args: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw helperError("ABORTED", "Claude session helper call was aborted");
    const stdin = `${JSON.stringify({
      version: 1,
      sdkVersion: CLAUDE_AGENT_SDK_PINNED_VERSION,
      method,
      args,
    })}\n`;
    if (Buffer.byteLength(stdin, "utf8") > CLAUDE_SESSION_HELPER_MAX_STDIN_BYTES) {
      throw helperError("INVALID_INPUT", "Claude session helper request is too large");
    }
    const invocation: ClaudeSessionHelperInvocation = Object.freeze({
      executable: process.execPath,
      args: Object.freeze(["--input-type=module", "--eval", CHILD_SCRIPT, SDK_ENTRYPOINT]),
      cwd: this.cwd,
      env: Object.freeze({
        CLAUDE_CONFIG_DIR: this.configHome,
        LANG: "C.UTF-8",
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      }),
      stdin,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: CLAUDE_SESSION_HELPER_MAX_STDOUT_BYTES,
      maxStderrBytes: CLAUDE_SESSION_HELPER_MAX_STDERR_BYTES,
    });
    if (!acquireHelperProcessCapacity()) {
      throw helperError("CAPACITY", "Claude session helper process capacity is exhausted");
    }
    let result: ClaudeSessionHelperProcessResult;
    try {
      result = await this.runProcess(invocation, signal);
    } catch (error) {
      if (signal?.aborted || (error instanceof ProcessRunnerFailure && error.kind === "ABORTED")) {
        throw helperError("ABORTED", "Claude session helper call was aborted");
      }
      if (error instanceof ProcessRunnerFailure && error.kind === "TIMEOUT") {
        throw helperError("TIMEOUT", "Claude session helper call timed out");
      }
      throw helperError("PROCESS_FAILED", "Claude session helper process failed");
    } finally {
      releaseHelperProcessCapacity();
    }
    return parseResponse(result);
  }
}
