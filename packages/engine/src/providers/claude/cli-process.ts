import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "../../redact.js";
import { canonicalizeProviderHome } from "../task-key.js";

export const CLAUDE_CLI_DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const CLAUDE_CLI_DEFAULT_STDERR_BYTES = 256 * 1024;

export interface ClaudeCliIngressLimits {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly pauseItems: number;
  readonly pauseBytes: number;
  readonly resumeItems: number;
  readonly resumeBytes: number;
}

export const CLAUDE_CLI_DEFAULT_INGRESS_LIMITS: Readonly<ClaudeCliIngressLimits> = Object.freeze({
  maxItems: 1_024,
  maxBytes: 32 * 1024 * 1024,
  pauseItems: 768,
  pauseBytes: 24 * 1024 * 1024,
  resumeItems: 512,
  resumeBytes: 16 * 1024 * 1024,
});

export interface ClaudeCliOutboundLimits {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxFrameBytes: number;
}

export const CLAUDE_CLI_DEFAULT_OUTBOUND_LIMITS: Readonly<ClaudeCliOutboundLimits> = Object.freeze({
  maxItems: 1_024,
  maxBytes: 32 * 1024 * 1024,
  maxFrameBytes: CLAUDE_CLI_DEFAULT_MAX_FRAME_BYTES,
});

export type ClaudeCliProcessPhase =
  | "idle"
  | "starting"
  | "ready"
  | "terminal"
  | "stopping"
  | "stopped";

export type ClaudeCliProcessErrorCode =
  | "SPAWN_FAILED"
  | "SPAWN_OUTCOME_TIMEOUT"
  | "INIT_TIMEOUT"
  | "CHILD_ERROR"
  | "CHILD_EXIT"
  | "CHILD_CLOSE"
  | "STDIN_ERROR"
  | "STDOUT_ERROR"
  | "STDERR_ERROR"
  | "STDOUT_EOF"
  | "MALFORMED_FRAME"
  | "FRAME_TOO_LARGE"
  | "TRUNCATED_FRAME"
  | "INGRESS_OVERFLOW"
  | "OUTBOUND_OVERFLOW"
  | "OUTBOUND_FRAME_TOO_LARGE"
  | "TIMER_ERROR"
  | "ENVELOPE_HANDLER_ERROR"
  | "ENVELOPE_HANDLER_TIMEOUT"
  | "WRITE_FAILED"
  | "NOT_READY"
  | "TERMINAL"
  | "SHUTDOWN";

export class ClaudeCliProcessError extends Error {
  readonly code: ClaudeCliProcessErrorCode;

  constructor(code: ClaudeCliProcessErrorCode, message: string) {
    super(message);
    this.name = "ClaudeCliProcessError";
    this.code = code;
  }
}

export interface ClaudeCliReadable {
  on(event: string, listener: (...args: any[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(): unknown;
}

export interface ClaudeCliWritable {
  readonly writable?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  end(): void;
}

export interface ClaudeCliChild {
  readonly stdin: ClaudeCliWritable;
  readonly stdout: ClaudeCliReadable;
  readonly stderr: ClaudeCliReadable;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export interface ClaudeCliSpawnOptions {
  readonly cwd: string;
  readonly shell: false;
  readonly detached: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export type ClaudeCliSpawn = (
  executable: string,
  args: readonly string[],
  options: ClaudeCliSpawnOptions,
) => ClaudeCliChild;

export type ClaudeCliSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type ClaudeCliClearTimeout = (handle: unknown) => void;
export type ClaudeEnvelopeHandler = (
  envelope: Readonly<Record<string, unknown>>,
) => void | Promise<void>;

export interface ClaudeCliTerminalResult {
  readonly kind: "shutdown" | "failure";
  readonly intentional: boolean;
  readonly exitSeen: boolean;
  readonly closeSeen: boolean;
  readonly error: ClaudeCliProcessError | null;
}

export interface ClaudeCliStderrRetention {
  readonly pendingBytes: number;
  readonly ownedBytes: number;
  readonly segmentCount: number;
}

export type ClaudeCliEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudeCliPermissionMode = "manual" | "acceptEdits" | "auto" | "dontAsk" | "plan";
export type ClaudeCliLaunch =
  | { readonly kind: "new"; readonly sessionId: string }
  | { readonly kind: "resume"; readonly sessionId: string };

export interface ClaudeCliProcessOptions {
  readonly executable: string;
  readonly configHome: string;
  readonly cwd: string;
  readonly launch?: ClaudeCliLaunch;
  readonly model?: string;
  readonly effort?: ClaudeCliEffort;
  readonly permissionMode?: ClaudeCliPermissionMode;
  readonly permissionPromptStdio?: boolean;
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly canonicalizeHome?: (home: string) => string;
  readonly spawnFn?: ClaudeCliSpawn;
  readonly onEnvelope?: ClaudeEnvelopeHandler;
  readonly maxFrameBytes?: number;
  readonly stderrMaxBytes?: number;
  readonly ingressLimits?: ClaudeCliIngressLimits;
  readonly outboundLimits?: ClaudeCliOutboundLimits;
  readonly setTimeoutFn?: ClaudeCliSetTimeout;
  readonly clearTimeoutFn?: ClaudeCliClearTimeout;
  readonly gracefulTimeoutMs?: number;
  readonly sigintTimeoutMs?: number;
  readonly sigtermTimeoutMs?: number;
  readonly sigkillTimeoutMs?: number;
  readonly exitDrainTimeoutMs?: number;
  readonly envelopeHandlerTimeoutMs?: number;
  readonly spawnOutcomeTimeoutMs?: number;
}

const BASE_ARGS = Object.freeze([
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--include-hook-events",
  "--replay-user-messages",
  "--setting-sources", "user,project,local",
] as const);

const DEFAULT_GRACEFUL_TIMEOUT_MS = 2_000;
const DEFAULT_SIGINT_TIMEOUT_MS = 2_000;
const DEFAULT_SIGTERM_TIMEOUT_MS = 1_000;
const DEFAULT_SIGKILL_TIMEOUT_MS = 1_000;
const DEFAULT_EXIT_DRAIN_TIMEOUT_MS = 1_000;
const DEFAULT_ENVELOPE_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_SPAWN_OUTCOME_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EFFORTS = new Set<ClaudeCliEffort>(["low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODES = new Set<ClaudeCliPermissionMode>([
  "manual",
  "acceptEdits",
  "auto",
  "dontAsk",
  "plan",
]);

const processError = (
  code: ClaudeCliProcessErrorCode,
  message: string,
): ClaudeCliProcessError => new ClaudeCliProcessError(code, message);

const nonEmpty = (name: string, value: string): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
};

const launchProfile = (value: unknown): Readonly<ClaudeCliLaunch> | null => {
  if (value === undefined) return null;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => typeof key !== "string" || (key !== "kind" && key !== "sessionId"))
    ) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ["kind", "sessionId"] as const) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
    }
    const kind = descriptors.kind!.value;
    const sessionId = descriptors.sessionId!.value;
    if ((kind !== "new" && kind !== "resume") ||
      typeof sessionId !== "string" || !UUID.test(sessionId)) throw new Error();
    return Object.freeze({ kind, sessionId });
  } catch {
    throw new TypeError("launch must be an exact native new or resume profile");
  }
};

const modelValue = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new TypeError("model must be a safe non-empty model identifier");
  return value;
};

const effortValue = (value: unknown): ClaudeCliEffort | null => {
  if (value === undefined) return null;
  if (typeof value !== "string" || !EFFORTS.has(value as ClaudeCliEffort)) {
    throw new TypeError("effort must be a supported Claude effort");
  }
  return value as ClaudeCliEffort;
};

const permissionModeValue = (value: unknown): ClaudeCliPermissionMode | null => {
  if (value === undefined) return null;
  if (typeof value !== "string" || !PERMISSION_MODES.has(value as ClaudeCliPermissionMode)) {
    throw new TypeError("permission mode must be a supported safe Claude permission mode");
  }
  return value as ClaudeCliPermissionMode;
};

const positiveSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
};

const nonNegativeSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
};

const snapshotIngressLimits = (
  value: ClaudeCliIngressLimits,
): Readonly<ClaudeCliIngressLimits> => {
  const limits = Object.freeze({
    maxItems: positiveSafeInteger("ingress maxItems", value.maxItems),
    maxBytes: positiveSafeInteger("ingress maxBytes", value.maxBytes),
    pauseItems: positiveSafeInteger("ingress pauseItems", value.pauseItems),
    pauseBytes: positiveSafeInteger("ingress pauseBytes", value.pauseBytes),
    resumeItems: nonNegativeSafeInteger("ingress resumeItems", value.resumeItems),
    resumeBytes: nonNegativeSafeInteger("ingress resumeBytes", value.resumeBytes),
  });
  if (limits.resumeItems > limits.pauseItems || limits.pauseItems > limits.maxItems) {
    throw new RangeError("ingress item watermarks must satisfy resume <= pause <= max");
  }
  if (limits.resumeBytes > limits.pauseBytes || limits.pauseBytes > limits.maxBytes) {
    throw new RangeError("ingress byte watermarks must satisfy resume <= pause <= max");
  }
  return limits;
};

const snapshotOutboundLimits = (
  value: ClaudeCliOutboundLimits,
): Readonly<ClaudeCliOutboundLimits> => Object.freeze({
  maxItems: positiveSafeInteger("outbound maxItems", value.maxItems),
  maxBytes: positiveSafeInteger("outbound maxBytes", value.maxBytes),
  maxFrameBytes: positiveSafeInteger("outbound maxFrameBytes", value.maxFrameBytes),
});

const encodeOutboundEnvelope = (value: unknown): Buffer => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Claude envelope must be a finite JSON object");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_key, item: unknown) => {
      if (
        item === undefined ||
        typeof item === "function" ||
        typeof item === "symbol" ||
        typeof item === "bigint" ||
        (typeof item === "number" && !Number.isFinite(item))
      ) {
        throw new TypeError("non-JSON value");
      }
      return item;
    });
  } catch {
    throw new TypeError("Claude envelope must be a finite JSON object");
  }
  if (json === undefined) throw new TypeError("Claude envelope must be a finite JSON object");
  const encoded: unknown = JSON.parse(json);
  if (!encoded || typeof encoded !== "object" || Array.isArray(encoded)) {
    throw new TypeError("Claude envelope must be a finite JSON object");
  }
  return Buffer.from(`${json}\n`, "utf8");
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const newestUtf8Suffix = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let offset = bytes.length - maxBytes;
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  return bytes.subarray(offset).toString("utf8");
};

const STDERR_SCAN_BYTES = 4 * 1024;
const STDERR_STRING_SLICE_CHARS = 1024;
const STDERR_OMITTED_LINE = "[stderr line omitted]\n";

class BoundedRedactedStderr {
  readonly maxBytes: number;
  private committed = "";
  private pendingStorage = Buffer.alloc(0);
  private pendingBytes = 0;
  private discardingLine = false;
  private pendingStringHighSurrogate = "";
  private finished = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  append(chunk: string | Uint8Array): void {
    if (this.finished) return;
    if (typeof chunk === "string") {
      this.appendString(chunk);
      return;
    }
    this.flushPendingStringSurrogate();
    for (let offset = 0; offset < chunk.byteLength; offset += STDERR_SCAN_BYTES) {
      this.ingestBytes(chunk.subarray(offset, Math.min(chunk.byteLength, offset + STDERR_SCAN_BYTES)));
    }
  }

  finish(): void {
    if (this.finished) return;
    this.flushPendingStringSurrogate();
    this.finished = true;
  }

  snapshot(): string {
    return newestUtf8Suffix(
      `${this.committed}${redactSecrets(this.decodePending())}`,
      this.maxBytes,
    );
  }

  get retention(): Readonly<ClaudeCliStderrRetention> {
    return Object.freeze({
      pendingBytes: this.pendingBytes,
      ownedBytes: Buffer.byteLength(this.committed, "utf8") + this.pendingStorage.length,
      segmentCount: this.pendingStorage.length === 0 ? 0 : 1,
    });
  }

  private appendString(value: string): void {
    let input = `${this.pendingStringHighSurrogate}${value}`;
    this.pendingStringHighSurrogate = "";
    if (input.length > 0) {
      const last = input.charCodeAt(input.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.pendingStringHighSurrogate = input.slice(-1);
        input = input.slice(0, -1);
      }
    }
    let offset = 0;
    while (offset < input.length) {
      let end = Math.min(input.length, offset + STDERR_STRING_SLICE_CHARS);
      if (end < input.length) {
        const last = input.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      }
      if (end <= offset) end = Math.min(input.length, offset + 1);
      this.ingestBytes(Buffer.from(input.slice(offset, end), "utf8"));
      offset = end;
    }
  }

  private flushPendingStringSurrogate(): void {
    if (this.pendingStringHighSurrogate.length === 0) return;
    const pending = this.pendingStringHighSurrogate;
    this.pendingStringHighSurrogate = "";
    this.ingestBytes(Buffer.from(pending, "utf8"));
  }

  private ingestBytes(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      let newline = -1;
      for (let index = offset; index < bytes.byteLength; index += 1) {
        if (bytes[index] === 0x0a) {
          newline = index;
          break;
        }
      }

      if (this.discardingLine) {
        if (newline === -1) return;
        this.discardingLine = false;
        offset = newline + 1;
        continue;
      }

      const end = newline === -1 ? bytes.byteLength : newline;
      const segmentBytes = end - offset;
      if (this.pendingBytes + segmentBytes > this.maxBytes) {
        this.clearPending();
        this.commit(STDERR_OMITTED_LINE);
        if (newline === -1) {
          this.discardingLine = true;
          return;
        }
        offset = newline + 1;
        continue;
      }

      if (segmentBytes > 0) {
        this.ensurePendingCapacity(this.pendingBytes + segmentBytes);
        this.pendingStorage.set(bytes.subarray(offset, end), this.pendingBytes);
        this.pendingBytes += segmentBytes;
      }
      if (newline === -1) return;
      this.commitPendingLine();
      offset = newline + 1;
    }
  }

  private commit(value: string): void {
    this.committed = newestUtf8Suffix(`${this.committed}${value}`, this.maxBytes);
  }

  private commitPendingLine(): void {
    const decoded = this.decodePending();
    this.clearPending();
    this.commit(`${redactSecrets(decoded)}\n`);
  }

  private decodePending(): string {
    if (this.pendingBytes === 0) return "";
    return new StringDecoder("utf8").write(this.pendingStorage.subarray(0, this.pendingBytes));
  }

  private clearPending(): void {
    this.pendingStorage.fill(0, 0, this.pendingBytes);
    this.pendingStorage = Buffer.alloc(0);
    this.pendingBytes = 0;
  }

  private ensurePendingCapacity(requiredBytes: number): void {
    if (requiredBytes <= this.pendingStorage.length) return;
    const doubled = this.pendingStorage.length === 0 ? 64 : this.pendingStorage.length * 2;
    const desired = Math.min(this.maxBytes, Math.max(requiredBytes, doubled));
    const committedBytes = Buffer.byteLength(this.committed, "utf8");
    const available = this.maxBytes - committedBytes;
    const capacity = available >= requiredBytes
      ? Math.min(desired, available)
      : requiredBytes;
    this.committed = newestUtf8Suffix(this.committed, this.maxBytes - capacity);
    const next = Buffer.allocUnsafe(capacity);
    if (this.pendingBytes > 0) {
      this.pendingStorage.copy(next, 0, 0, this.pendingBytes);
    }
    this.pendingStorage = next;
  }
}

interface WriteEntry {
  readonly bytes: Buffer;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

const createWriteEntry = (bytes: Buffer): WriteEntry => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { bytes, promise, resolve, reject, settled: false };
};

interface DelayWaiter {
  handle: unknown;
  readonly resolve: () => void;
  settled: boolean;
}

const isProtocolError = (error: ClaudeCliProcessError): boolean =>
  error.code === "MALFORMED_FRAME" ||
  error.code === "FRAME_TOO_LARGE" ||
  error.code === "TRUNCATED_FRAME" ||
  error.code === "INGRESS_OVERFLOW" ||
  error.code === "ENVELOPE_HANDLER_ERROR" ||
  error.code === "ENVELOPE_HANDLER_TIMEOUT";

export class ClaudeCliProcess {
  readonly executable: string;
  readonly configHome: string;
  readonly cwd: string;
  readonly terminated: Promise<ClaudeCliTerminalResult>;

  private readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  private readonly cliArgs: readonly string[];
  private readonly expectedSessionId: string | null;
  private readonly spawnFn: ClaudeCliSpawn;
  private readonly onEnvelope?: ClaudeEnvelopeHandler;
  private readonly maxFrameBytes: number;
  private readonly ingressLimits: Readonly<ClaudeCliIngressLimits>;
  private readonly outboundLimits: Readonly<ClaudeCliOutboundLimits>;
  private readonly stderr: BoundedRedactedStderr;
  private readonly setTimeoutFn: ClaudeCliSetTimeout;
  private readonly clearTimeoutFn: ClaudeCliClearTimeout;
  private readonly gracefulTimeoutMs: number;
  private readonly sigintTimeoutMs: number;
  private readonly sigtermTimeoutMs: number;
  private readonly sigkillTimeoutMs: number;
  private readonly exitDrainTimeoutMs: number;
  private readonly envelopeHandlerTimeoutMs: number;
  private readonly spawnOutcomeTimeoutMs: number;
  private readonly terminalDeferred = createDeferred<ClaudeCliTerminalResult>();
  private readonly stdoutBoundary = createDeferred<void>();
  private readonly spawnOutcome = createDeferred<"spawned" | "failed">();
  private readonly delayWaiters = new Set<DelayWaiter>();
  private readonly writes: WriteEntry[] = [];
  private readonly ingressQueue: Buffer[] = [];
  private readonly ingressIdleWaiters = new Set<() => void>();

  private _phase: ClaudeCliProcessPhase = "idle";
  private child: ClaudeCliChild | null = null;
  private startDeferred: Deferred<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private startSettled = false;
  private spawned = false;
  private spawnFailed = false;
  private spawnOutcomeSettled = false;
  private spawnOutcomeTimedOut = false;
  private spawnOutcomeTimer: unknown;
  private spawnOutcomeTimerSet = false;
  private initIdentityTimer: unknown;
  private initIdentityTimerSet = false;
  private shutdownRequested = false;
  private shutdownPromise: Promise<ClaudeCliTerminalResult> | null = null;
  private cleanupPromise: Promise<ClaudeCliTerminalResult> | null = null;
  private terminalValue: ClaudeCliTerminalResult | null = null;
  private _terminalError: ClaudeCliProcessError | null = null;
  private _sessionId: string | null = null;
  private exitSeen = false;
  private closeSeen = false;
  private stdinEnded = false;
  private stdoutBoundarySeen = false;
  private stdoutFinishRequested = false;
  private stdoutFaulted = false;
  private stdoutPending = Buffer.alloc(0);
  private stdoutFinishPromise: Promise<void> | null = null;
  private ingressItems = 0;
  private ingressBytes = 0;
  private ingressPaused = false;
  private drainingIngress = false;
  private pumpingWrites = false;
  private outboundItems = 0;
  private outboundBytes = 0;
  private activeWrite: WriteEntry | null = null;
  private activeRawWriteReject: ((reason: ClaudeCliProcessError) => void) | null = null;

  constructor(options: ClaudeCliProcessOptions) {
    this.executable = nonEmpty("executable", options.executable);
    if (!path.isAbsolute(this.executable)) {
      throw new TypeError("executable must be absolute");
    }
    this.configHome = nonEmpty("config home", options.configHome);
    if (!path.isAbsolute(this.configHome)) {
      throw new TypeError("config home must be absolute");
    }
    const canonicalizeHome = options.canonicalizeHome ?? canonicalizeProviderHome;
    if (canonicalizeHome(this.configHome) !== this.configHome) {
      throw new TypeError("config home must already be canonical");
    }
    this.cwd = nonEmpty("cwd", options.cwd);
    if (!path.isAbsolute(this.cwd)) throw new TypeError("cwd must be absolute");

    const launch = launchProfile(options.launch);
    const model = modelValue(options.model);
    const effort = effortValue(options.effort);
    const permissionMode = permissionModeValue(options.permissionMode);
    if (
      options.permissionPromptStdio !== undefined &&
      typeof options.permissionPromptStdio !== "boolean"
    ) throw new TypeError("permission prompt stdio must be a boolean");
    const args: string[] = [...BASE_ARGS];
    if (effort !== null) args.push("--effort", effort);
    if (model !== null) args.push("--model", model);
    if (options.permissionPromptStdio === true) {
      args.push("--permission-prompt-tool", "stdio");
    }
    if (permissionMode !== null) args.push("--permission-mode", permissionMode);
    if (launch?.kind === "new") args.push("--session-id", launch.sessionId);
    if (launch?.kind === "resume") args.push("--resume", launch.sessionId);
    this.cliArgs = Object.freeze(args);
    this.expectedSessionId = launch?.sessionId ?? null;

    this.baseEnv = Object.freeze({ ...(options.baseEnv ?? process.env) });
    this.spawnFn = options.spawnFn ?? ((executable, args, spawnOptions) =>
      nodeSpawn(executable, [...args], spawnOptions as any) as unknown as ClaudeCliChild);
    this.onEnvelope = options.onEnvelope;
    this.maxFrameBytes = positiveSafeInteger(
      "maxFrameBytes",
      options.maxFrameBytes ?? CLAUDE_CLI_DEFAULT_MAX_FRAME_BYTES,
    );
    this.ingressLimits = snapshotIngressLimits(
      options.ingressLimits ?? CLAUDE_CLI_DEFAULT_INGRESS_LIMITS,
    );
    this.outboundLimits = snapshotOutboundLimits(
      options.outboundLimits ?? CLAUDE_CLI_DEFAULT_OUTBOUND_LIMITS,
    );
    const stderrMaxBytes = positiveSafeInteger(
      "stderrMaxBytes",
      options.stderrMaxBytes ?? CLAUDE_CLI_DEFAULT_STDERR_BYTES,
    );
    this.stderr = new BoundedRedactedStderr(stderrMaxBytes);
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.gracefulTimeoutMs = positiveSafeInteger(
      "gracefulTimeoutMs",
      options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS,
    );
    this.sigintTimeoutMs = positiveSafeInteger(
      "sigintTimeoutMs",
      options.sigintTimeoutMs ?? DEFAULT_SIGINT_TIMEOUT_MS,
    );
    this.sigtermTimeoutMs = positiveSafeInteger(
      "sigtermTimeoutMs",
      options.sigtermTimeoutMs ?? DEFAULT_SIGTERM_TIMEOUT_MS,
    );
    this.sigkillTimeoutMs = positiveSafeInteger(
      "sigkillTimeoutMs",
      options.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS,
    );
    this.exitDrainTimeoutMs = positiveSafeInteger(
      "exitDrainTimeoutMs",
      options.exitDrainTimeoutMs ?? DEFAULT_EXIT_DRAIN_TIMEOUT_MS,
    );
    this.envelopeHandlerTimeoutMs = positiveSafeInteger(
      "envelopeHandlerTimeoutMs",
      options.envelopeHandlerTimeoutMs ?? DEFAULT_ENVELOPE_HANDLER_TIMEOUT_MS,
    );
    this.spawnOutcomeTimeoutMs = positiveSafeInteger(
      "spawnOutcomeTimeoutMs",
      options.spawnOutcomeTimeoutMs ?? DEFAULT_SPAWN_OUTCOME_TIMEOUT_MS,
    );
    this.terminated = this.terminalDeferred.promise;
  }

  get phase(): ClaudeCliProcessPhase {
    return this._phase;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get terminalError(): ClaudeCliProcessError | null {
    return this._terminalError;
  }

  get stderrDiagnostics(): string {
    return this.stderr.snapshot();
  }

  get stderrRetention(): Readonly<ClaudeCliStderrRetention> {
    return this.stderr.retention;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.shutdownRequested || this.terminalValue) {
      this.startPromise = Promise.reject(processError("SHUTDOWN", "Claude CLI is stopped"));
      return this.startPromise;
    }

    this.startDeferred = createDeferred<void>();
    this.startPromise = this.startDeferred.promise;
    this._phase = "starting";
    let child: ClaudeCliChild;
    try {
      const env: NodeJS.ProcessEnv = { ...this.baseEnv };
      delete env.CLAUDE_UI_CLAUDE_BIN;
      env.CLAUDE_CONFIG_DIR = this.configHome;
      child = this.spawnFn(this.executable, this.cliArgs, {
        cwd: this.cwd,
        shell: false,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.freeze(env),
      });
    } catch {
      this.settleSpawnOutcome("failed");
      this.beginFailure(processError("SPAWN_FAILED", "Claude CLI spawn failed"));
      return this.startPromise;
    }

    this.child = child;
    this.installListeners(child);
    this.armSpawnOutcomeDeadline();
    return this.startPromise;
  }

  writeEnvelope(value: unknown): Promise<void> {
    if (this._phase !== "ready" || !this.child || this._terminalError || this.shutdownRequested) {
      return Promise.reject(processError(
        this._phase === "ready" ? "TERMINAL" : "NOT_READY",
        "Claude CLI stdin is unavailable",
      ));
    }

    let bytes: Buffer;
    try {
      bytes = encodeOutboundEnvelope(value);
    } catch {
      return Promise.reject(new TypeError("Claude envelope must be a finite JSON object"));
    }
    if (bytes.length - 1 > this.outboundLimits.maxFrameBytes) {
      return Promise.reject(processError(
        "OUTBOUND_FRAME_TOO_LARGE",
        `Claude outbound JSONL frame exceeds ${this.outboundLimits.maxFrameBytes} bytes`,
      ));
    }
    if (
      this.outboundItems + 1 > this.outboundLimits.maxItems ||
      this.outboundBytes + bytes.length > this.outboundLimits.maxBytes
    ) {
      return Promise.reject(processError(
        "OUTBOUND_OVERFLOW",
        "Claude outbound queue exceeded its retention bound",
      ));
    }

    const entry = createWriteEntry(bytes);
    this.outboundItems += 1;
    this.outboundBytes += bytes.length;
    this.writes.push(entry);
    void this.pumpWrites();
    return entry.promise;
  }

  shutdown(): Promise<ClaudeCliTerminalResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.terminalValue) {
      this.shutdownPromise = Promise.resolve(this.terminalValue);
      return this.shutdownPromise;
    }
    this.shutdownRequested = true;
    this.clearInitIdentityDeadline();
    if (!this._terminalError) this._phase = "stopping";
    this.rejectStart(processError("SHUTDOWN", "Claude CLI shutdown requested"));
    const unavailable = processError("TERMINAL", "Claude CLI shutdown requested");
    this.abortActiveRawWrite(unavailable);
    this.rejectWrites(unavailable);
    this.shutdownPromise = this.ensureCleanup();
    return this.shutdownPromise;
  }

  private installListeners(child: ClaudeCliChild): void {
    child.on("spawn", () => this.onSpawn());
    child.on("error", () => {
      if (!this.spawned) this.settleSpawnOutcome("failed");
      if (!this.shutdownRequested) {
        this.beginFailure(processError("CHILD_ERROR", "Claude CLI child failed"));
      }
    });
    child.on("exit", () => this.onExit());
    child.on("close", () => this.onChildClose());

    child.stdin.on("error", () => {
      if (!this.shutdownRequested) {
        this.beginFailure(processError("STDIN_ERROR", "Claude CLI stdin failed"));
      }
    });
    child.stdin.on("close", () => {
      if (!this.stdinEnded && !this.shutdownRequested && !this.exitSeen && !this.closeSeen) {
        this.beginFailure(processError("STDIN_ERROR", "Claude CLI stdin closed"));
      }
    });

    child.stdout.on("data", (chunk: string | Uint8Array) => this.queueStdout(chunk));
    child.stdout.on("error", () => {
      if (!this.shutdownRequested) {
        this.beginFailure(processError("STDOUT_ERROR", "Claude CLI stdout failed"));
      }
    });
    child.stdout.on("end", () => this.onStdoutBoundary("STDOUT_EOF"));
    child.stdout.on("close", () => this.onStdoutBoundary("STDOUT_EOF"));

    child.stderr.on("data", (chunk: string | Uint8Array) => this.stderr.append(chunk));
    child.stderr.on("error", () => {
      if (!this.shutdownRequested) {
        this.beginFailure(processError("STDERR_ERROR", "Claude CLI stderr failed"));
      }
    });
    child.stderr.on("end", () => this.stderr.finish());
    child.stderr.on("close", () => this.stderr.finish());
  }

  private onSpawn(): void {
    if (this.spawned) return;
    this.spawned = true;
    this.settleSpawnOutcome("spawned");
    if (this.spawnOutcomeTimedOut || this.terminalValue) {
      this.sendSignal("SIGKILL");
      return;
    }
    if (this._terminalError || this.shutdownRequested) return;
    if (this.expectedSessionId === null) {
      this._phase = "ready";
      this.resolveStart();
      return;
    }
    if (this._sessionId === this.expectedSessionId) {
      this.confirmExpectedSessionIdentity();
      return;
    }
    this.armInitIdentityDeadline();
  }

  private onExit(): void {
    if (this.exitSeen) return;
    if (!this.spawned) this.settleSpawnOutcome("failed");
    this.exitSeen = true;
    this.resolveDelayWaiters();
    if (!this.shutdownRequested) {
      this.beginFailure(processError("CHILD_EXIT", "Claude CLI child exited"), true);
    } else {
      void this.ensureCleanup();
    }
  }

  private onChildClose(): void {
    if (!this.spawned) this.settleSpawnOutcome("failed");
    if (!this.closeSeen) {
      this.closeSeen = true;
      this.resolveDelayWaiters();
    }
    this.markStdoutBoundary();
    void this.requestStdoutFinish().then(() => {
      if (!this.shutdownRequested && !this._terminalError) {
        this.beginFailure(processError("CHILD_CLOSE", "Claude CLI child closed"));
      } else {
        void this.ensureCleanup();
      }
    });
  }

  private onStdoutBoundary(code: "STDOUT_EOF"): void {
    this.markStdoutBoundary();
    void this.requestStdoutFinish().then(() => {
      if (!this.shutdownRequested && !this._terminalError) {
        this.beginFailure(processError(code, "Claude CLI stdout ended"));
      } else {
        void this.ensureCleanup();
      }
    });
  }

  private markStdoutBoundary(): void {
    if (this.stdoutBoundarySeen) return;
    this.stdoutBoundarySeen = true;
    this.stdoutBoundary.resolve(undefined);
  }

  private queueStdout(chunk: string | Uint8Array): void {
    if (this.stdoutFinishRequested || this.stdoutFaulted) return;
    const byteLength = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    if (byteLength === 0) return;
    if (
      this.ingressItems + 1 > this.ingressLimits.maxItems ||
      this.ingressBytes + byteLength > this.ingressLimits.maxBytes
    ) {
      this.faultStdout(processError(
        "INGRESS_OVERFLOW",
        "Claude CLI stdout ingress exceeded its retention bound",
      ));
      return;
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.ingressQueue.push(bytes);
    this.ingressItems += 1;
    this.ingressBytes += bytes.length;
    this.maybePauseIngress();
    void this.drainIngress();
  }

  private async drainIngress(): Promise<void> {
    if (this.drainingIngress) return;
    this.drainingIngress = true;
    try {
      while (!this.stdoutFaulted) {
        const bytes = this.ingressQueue.shift();
        if (!bytes) break;
        try {
          await this.ingestStdout(bytes);
        } catch (error) {
          this.faultStdout(error instanceof ClaudeCliProcessError
            ? error
            : processError("MALFORMED_FRAME", "Claude CLI emitted an invalid JSONL frame"));
        } finally {
          this.releaseIngress(bytes.length);
        }
      }
    } finally {
      this.drainingIngress = false;
      this.resolveIngressIdleIfNeeded();
    }
  }

  private async ingestStdout(bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.stdoutFaulted) return;
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        this.appendStdoutPartial(bytes.subarray(offset));
        return;
      }

      const segment = bytes.subarray(offset, newline);
      this.assertFrameBound(this.stdoutPending.length + segment.length);
      let line = this.stdoutPending.length === 0
        ? segment
        : Buffer.concat(
          [this.stdoutPending, segment],
          this.stdoutPending.length + segment.length,
        );
      this.stdoutPending = Buffer.alloc(0);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      const envelope = this.parseEnvelope(line);
      this.captureSessionId(envelope);
      if (this.onEnvelope) {
        await this.deliverEnvelope(envelope);
      }
      if (this.stdoutFaulted) return;
      offset = newline + 1;
    }
  }

  private faultStdout(error: ClaudeCliProcessError): void {
    if (this.stdoutFaulted) return;
    this.stopIngressForTerminal();
    this.beginFailure(error);
  }

  private stopIngressForTerminal(): void {
    if (this.stdoutFaulted) return;
    this.stdoutFaulted = true;
    this.stdoutPending = Buffer.alloc(0);
    for (const bytes of this.ingressQueue.splice(0)) this.releaseIngress(bytes.length);
  }

  private maybePauseIngress(): void {
    if (
      this.ingressPaused ||
      (this.ingressItems < this.ingressLimits.pauseItems &&
        this.ingressBytes < this.ingressLimits.pauseBytes)
    ) return;
    this.ingressPaused = true;
    try { this.child?.stdout.pause(); } catch {
      this.faultStdout(processError("STDOUT_ERROR", "Claude CLI stdout pause failed"));
    }
  }

  private releaseIngress(bytes: number): void {
    this.ingressItems -= 1;
    this.ingressBytes -= bytes;
    if (
      this.ingressPaused &&
      !this.stdoutFaulted &&
      this.ingressItems <= this.ingressLimits.resumeItems &&
      this.ingressBytes <= this.ingressLimits.resumeBytes
    ) {
      this.ingressPaused = false;
      try { this.child?.stdout.resume(); } catch {
        this.faultStdout(processError("STDOUT_ERROR", "Claude CLI stdout resume failed"));
      }
    }
    this.resolveIngressIdleIfNeeded();
  }

  private waitForIngressIdle(): Promise<void> {
    if (this.ingressItems === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.ingressIdleWaiters.add(resolve));
  }

  private resolveIngressIdleIfNeeded(): void {
    if (this.ingressItems !== 0) return;
    for (const resolve of this.ingressIdleWaiters) resolve();
    this.ingressIdleWaiters.clear();
  }

  private appendStdoutPartial(segment: Buffer): void {
    this.assertFrameBound(this.stdoutPending.length + segment.length);
    if (segment.length === 0) return;
    this.stdoutPending = this.stdoutPending.length === 0
      ? Buffer.from(segment)
      : Buffer.concat(
        [this.stdoutPending, segment],
        this.stdoutPending.length + segment.length,
      );
  }

  private assertFrameBound(bytes: number): void {
    if (bytes > this.maxFrameBytes) {
      throw processError(
        "FRAME_TOO_LARGE",
        `Claude JSONL frame exceeds ${this.maxFrameBytes} bytes`,
      );
    }
  }

  private parseEnvelope(line: Buffer): Readonly<Record<string, unknown>> {
    if (line.length === 0) {
      throw processError("MALFORMED_FRAME", "Claude emitted an empty JSONL frame");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      throw processError("MALFORMED_FRAME", "Claude emitted invalid UTF-8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw processError("MALFORMED_FRAME", "Claude emitted malformed JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw processError("MALFORMED_FRAME", "Claude JSONL envelope must be an object");
    }
    return parsed as Readonly<Record<string, unknown>>;
  }

  private captureSessionId(envelope: Readonly<Record<string, unknown>>): void {
    if (envelope.type !== "system" || envelope.subtype !== "init") return;
    const received = envelope.session_id;
    if (this.expectedSessionId !== null) {
      if (
        typeof received !== "string" ||
        !UUID.test(received) ||
        received !== this.expectedSessionId
      ) {
        throw processError("MALFORMED_FRAME", "Claude init session identity did not match");
      }
    }
    if (typeof received !== "string" || !UUID.test(received)) return;
    if (this._sessionId !== null && received !== this._sessionId) {
      throw processError("MALFORMED_FRAME", "Claude init session identity changed");
    }
    this._sessionId ??= received;
    this.confirmExpectedSessionIdentity();
  }

  private deliverEnvelope(envelope: Readonly<Record<string, unknown>>): Promise<void> {
    let delivery: Promise<void>;
    try {
      delivery = Promise.resolve(this.onEnvelope!(envelope));
    } catch {
      return Promise.reject(processError(
        "ENVELOPE_HANDLER_ERROR",
        "Claude envelope handler failed",
      ));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timerSet = false;
      let handle: unknown;
      const finish = (error?: ClaudeCliProcessError): void => {
        if (settled) return;
        settled = true;
        if (timerSet && !this.safeClearTimer(handle) && !error) {
          error = processError("TIMER_ERROR", "Claude envelope timer failed");
        }
        if (error) reject(error);
        else resolve();
      };
      void delivery.then(
        () => finish(),
        () => finish(processError(
          "ENVELOPE_HANDLER_ERROR",
          "Claude envelope handler failed",
        )),
      );
      try {
        handle = this.setTimeoutFn(() => finish(processError(
          "ENVELOPE_HANDLER_TIMEOUT",
          "Claude envelope handler timed out",
        )), this.envelopeHandlerTimeoutMs);
        timerSet = true;
        if (settled) this.safeClearTimer(handle);
      } catch {
        this.recordTimerFailure();
        finish(processError("TIMER_ERROR", "Claude envelope timer failed"));
      }
    });
  }

  private requestStdoutFinish(): Promise<void> {
    if (this.stdoutFinishPromise) return this.stdoutFinishPromise;
    this.stdoutFinishRequested = true;
    this.stdoutFinishPromise = this.waitForIngressIdle().then(() => {
      if (!this.stdoutFaulted && this.stdoutPending.length > 0) {
        const error = processError(
          "TRUNCATED_FRAME",
          `Claude stdout ended with an incomplete ${this.stdoutPending.length}-byte frame`,
        );
        this.stdoutPending = Buffer.alloc(0);
        this.stdoutFaulted = true;
        this.beginFailure(error);
      }
    });
    return this.stdoutFinishPromise;
  }

  private async pumpWrites(): Promise<void> {
    if (this.pumpingWrites) return;
    this.pumpingWrites = true;
    try {
      while (!this._terminalError && !this.shutdownRequested) {
        const entry = this.writes.shift();
        if (!entry) break;
        this.activeWrite = entry;
        try {
          await this.writeChunk(entry.bytes);
          this.finishWrite(entry);
        } catch (error) {
          const failure = error instanceof ClaudeCliProcessError
            ? error
            : processError("WRITE_FAILED", "Claude CLI stdin write failed");
          this.finishWrite(entry, failure);
          if (!this.shutdownRequested) this.beginFailure(failure);
          break;
        } finally {
          if (this.activeWrite === entry) this.activeWrite = null;
        }
      }
    } finally {
      this.pumpingWrites = false;
    }
  }

  private writeChunk(bytes: Buffer): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.writable === false || this._terminalError || this.shutdownRequested) {
      return Promise.reject(processError("TERMINAL", "Claude CLI stdin is unavailable"));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let callbackDone = false;
      let drainSeen = false;
      let writeReturned: boolean | undefined;
      const cleanup = (): void => {
        stdin.off("drain", onDrain);
        if (this.activeRawWriteReject === abort) this.activeRawWriteReject = null;
      };
      const succeedIfComplete = (): void => {
        if (settled || writeReturned === undefined || !callbackDone) return;
        if (!writeReturned && !drainSeen) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: ClaudeCliProcessError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = (error: ClaudeCliProcessError): void => fail(error);
      const onDrain = (): void => {
        drainSeen = true;
        succeedIfComplete();
      };
      this.activeRawWriteReject = abort;
      stdin.once("drain", onDrain);
      try {
        writeReturned = stdin.write(bytes, (error) => {
          if (error) {
            fail(processError("WRITE_FAILED", "Claude CLI stdin write failed"));
            return;
          }
          callbackDone = true;
          succeedIfComplete();
        });
      } catch {
        fail(processError("WRITE_FAILED", "Claude CLI stdin write failed"));
        return;
      }
      if (writeReturned) stdin.off("drain", onDrain);
      succeedIfComplete();
    });
  }

  private finishWrite(entry: WriteEntry, error?: ClaudeCliProcessError): void {
    if (entry.settled) return;
    entry.settled = true;
    this.outboundItems -= 1;
    this.outboundBytes -= entry.bytes.length;
    if (error) entry.reject(error);
    else entry.resolve();
  }

  private rejectWrites(error: ClaudeCliProcessError): void {
    if (this.activeWrite) this.finishWrite(this.activeWrite, error);
    for (const entry of this.writes.splice(0)) this.finishWrite(entry, error);
  }

  private abortActiveRawWrite(error: ClaudeCliProcessError): void {
    this.activeRawWriteReject?.(error);
  }

  private beginFailure(error: ClaudeCliProcessError, preserveIngress = false): void {
    if (this.terminalValue) return;
    this.clearInitIdentityDeadline();
    if (!preserveIngress) this.stopIngressForTerminal();
    if (
      this._terminalError &&
      !(isProtocolError(error) && !isProtocolError(this._terminalError))
    ) return;
    this._terminalError = error;
    this._phase = "terminal";
    this.rejectStart(error);
    this.abortActiveRawWrite(error);
    this.rejectWrites(error);
    void this.ensureCleanup();
  }

  private ensureCleanup(): Promise<ClaudeCliTerminalResult> {
    if (!this.cleanupPromise) {
      const cleanup = createDeferred<ClaudeCliTerminalResult>();
      this.cleanupPromise = cleanup.promise;
      void this.cleanup().then(cleanup.resolve, () => {
        this.recordTimerFailure();
        try { this.child?.stdout.destroy(); } catch { /* bounded teardown */ }
        try { this.child?.stderr.destroy(); } catch { /* bounded teardown */ }
        this.markStdoutBoundary();
        this.stderr.finish();
        cleanup.resolve(this.settleTerminal());
      });
    }
    return this.cleanupPromise;
  }

  private async cleanup(): Promise<ClaudeCliTerminalResult> {
    if (this.terminalValue) return this.terminalValue;
    this.endStdin();

    if (this.child && !this.spawned && !this.spawnFailed) {
      await this.waitForSpawnOutcome();
    }
    if (this.child && this.spawned && !this.exitSeen && !this.closeSeen) {
      await this.waitForExitOrDelay(this.gracefulTimeoutMs);
      if (!this.exitSeen && !this.closeSeen) {
        this.sendSignal("SIGINT");
        await this.waitForExitOrDelay(this.sigintTimeoutMs);
      }
      if (!this.exitSeen && !this.closeSeen) {
        this.sendSignal("SIGTERM");
        await this.waitForExitOrDelay(this.sigtermTimeoutMs);
      }
      if (!this.exitSeen && !this.closeSeen) {
        this.sendSignal("SIGKILL");
        await this.waitForExitOrDelay(this.sigkillTimeoutMs);
      }
    }

    if (this.child && !this.stdoutBoundarySeen) await this.waitForStdoutBoundary();
    else if (!this.child) this.markStdoutBoundary();
    await this.requestStdoutFinish();
    this.stderr.finish();
    return this.settleTerminal();
  }

  private waitForExitOrDelay(delayMs: number): Promise<void> {
    if (this.exitSeen || this.closeSeen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let handleReady = false;
      const waiter: DelayWaiter = {
        handle: undefined,
        settled: false,
        resolve: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.delayWaiters.delete(waiter);
          if (handleReady) this.safeClearTimer(waiter.handle);
          resolve();
        },
      };
      try {
        const handle = this.setTimeoutFn(waiter.resolve, delayMs);
        waiter.handle = handle;
        handleReady = true;
        if (waiter.settled) this.safeClearTimer(handle);
        else this.delayWaiters.add(waiter);
      } catch {
        this.recordTimerFailure();
        waiter.settled = true;
        resolve();
      }
    });
  }

  private waitForSpawnOutcome(): Promise<void> {
    if (this.spawnOutcomeSettled) return Promise.resolve();
    return this.spawnOutcome.promise.then(() => undefined);
  }

  private resolveDelayWaiters(): void {
    for (const waiter of [...this.delayWaiters]) waiter.resolve();
  }

  private waitForStdoutBoundary(): Promise<void> {
    if (this.stdoutBoundarySeen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let handle: unknown;
      let timerSet = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timerSet) this.safeClearTimer(handle);
        resolve();
      };
      void this.stdoutBoundary.promise.then(finish);
      const forceBoundary = (): void => {
        try { this.child?.stdout.destroy(); } catch { /* bounded teardown */ }
        try { this.child?.stderr.destroy(); } catch { /* bounded teardown */ }
        this.markStdoutBoundary();
        finish();
      };
      try {
        handle = this.setTimeoutFn(forceBoundary, this.exitDrainTimeoutMs);
        timerSet = true;
        if (settled) {
          timerSet = false;
          this.safeClearTimer(handle);
        }
      } catch {
        this.recordTimerFailure();
        forceBoundary();
      }
    });
  }

  private safeClearTimer(handle: unknown): boolean {
    try {
      this.clearTimeoutFn(handle);
      return true;
    } catch {
      this.recordTimerFailure();
      return false;
    }
  }

  private recordTimerFailure(): void {
    this.beginFailure(processError("TIMER_ERROR", "Claude CLI teardown timer failed"));
  }

  private sendSignal(signal: NodeJS.Signals): void {
    if (!this.child || this.exitSeen || this.closeSeen) return;
    try { this.child.kill(signal); } catch { /* signal races are non-diagnostic */ }
  }

  private endStdin(): void {
    if (this.stdinEnded || !this.child) return;
    this.stdinEnded = true;
    try { this.child.stdin.end(); } catch { /* bounded teardown */ }
  }

  private resolveStart(): void {
    if (this.startSettled || !this.startDeferred) return;
    this.startSettled = true;
    this.startDeferred.resolve(undefined);
  }

  private settleSpawnOutcome(outcome: "spawned" | "failed"): void {
    if (this.spawnOutcomeSettled) return;
    this.spawnOutcomeSettled = true;
    this.spawnFailed = outcome === "failed";
    if (this.spawnOutcomeTimerSet) {
      this.spawnOutcomeTimerSet = false;
      this.safeClearTimer(this.spawnOutcomeTimer);
    }
    this.spawnOutcome.resolve(outcome);
  }

  private armSpawnOutcomeDeadline(): void {
    const timeout = (): void => {
      this.spawnOutcomeTimerSet = false;
      this.expireSpawnOutcome(processError(
        "SPAWN_OUTCOME_TIMEOUT",
        "Claude CLI spawn outcome timed out",
      ));
    };
    try {
      const handle = this.setTimeoutFn(timeout, this.spawnOutcomeTimeoutMs);
      this.spawnOutcomeTimer = handle;
      if (this.spawnOutcomeSettled) this.safeClearTimer(handle);
      else this.spawnOutcomeTimerSet = true;
    } catch {
      this.expireSpawnOutcome(processError(
        "TIMER_ERROR",
        "Claude CLI spawn outcome timer failed",
      ));
    }
  }

  private armInitIdentityDeadline(): void {
    if (
      this.expectedSessionId === null ||
      this._sessionId === this.expectedSessionId ||
      this._terminalError !== null ||
      this.shutdownRequested
    ) return;
    let fired = false;
    const timeout = (): void => {
      fired = true;
      this.initIdentityTimerSet = false;
      this.beginFailure(processError(
        "INIT_TIMEOUT",
        "Claude CLI init identity validation timed out",
      ));
    };
    try {
      const handle = this.setTimeoutFn(timeout, this.spawnOutcomeTimeoutMs);
      this.initIdentityTimer = handle;
      if (
        fired ||
        this._sessionId === this.expectedSessionId ||
        this._terminalError !== null ||
        this.shutdownRequested
      ) {
        this.safeClearTimer(handle);
      } else {
        this.initIdentityTimerSet = true;
      }
    } catch {
      this.beginFailure(processError(
        "TIMER_ERROR",
        "Claude CLI init identity timer failed",
      ));
    }
  }

  private clearInitIdentityDeadline(): void {
    if (!this.initIdentityTimerSet) return;
    this.initIdentityTimerSet = false;
    this.safeClearTimer(this.initIdentityTimer);
  }

  private confirmExpectedSessionIdentity(): void {
    if (
      this.expectedSessionId === null ||
      this._sessionId !== this.expectedSessionId
    ) return;
    this.clearInitIdentityDeadline();
    if (
      !this.spawned ||
      this._terminalError !== null ||
      this.shutdownRequested ||
      this.terminalValue !== null
    ) return;
    this._phase = "ready";
    this.resolveStart();
  }

  private expireSpawnOutcome(error: ClaudeCliProcessError): void {
    if (this.spawnOutcomeSettled) return;
    this.spawnOutcomeSettled = true;
    this.spawnOutcomeTimedOut = true;
    this.spawnOutcome.resolve("failed");
    this.beginFailure(error);
    this.sendSignal("SIGKILL");
  }

  private rejectStart(error: ClaudeCliProcessError): void {
    if (this.startSettled || !this.startDeferred) return;
    this.startSettled = true;
    this.startDeferred.reject(error);
  }

  private settleTerminal(): ClaudeCliTerminalResult {
    if (this.terminalValue) return this.terminalValue;
    const error = this._terminalError;
    this.terminalValue = Object.freeze({
      kind: error ? "failure" : "shutdown",
      intentional: error === null && this.shutdownRequested,
      exitSeen: this.exitSeen,
      closeSeen: this.closeSeen,
      error,
    });
    this._phase = "stopped";
    this.terminalDeferred.resolve(this.terminalValue);
    return this.terminalValue;
  }
}
