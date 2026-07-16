/**
 * CLI-subprocess driver. Spawns `claude -p --output-format stream-json` per turn,
 * inheriting the user's local login (no API key). Reuses the M1 parser to normalize
 * assistant/user lines, so the chat UI renders identically to the history viewer.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLine, usageFromMessage } from "../parser.js";
import { createLineSplitter } from "./buffer.js";
import { gracefulInterrupt } from "./interrupt.js";
import { applySandbox } from "./sandbox.js";
import { forkCliArgs } from "./fork.js";
import type {
  AgentDriver,
  PermissionMode,
  RunningTurn,
  SessionInit,
  TurnHandlers,
  TurnRequest,
  TurnResult,
} from "./types.js";

/** Options for {@link resolveClaudeBin}, overridable for hermetic tests. */
export interface ResolveClaudeBinOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}

/**
 * A candidate is trusted only if it's an absolute path that resolves (through
 * symlinks) to a real, executable file. Mirrors the same validation the native
 * Claude runtime discovery already applies (packages/server/src/native-claude-runtime.ts
 * `executableFile`) — kept as a small local copy here because engine must not
 * depend on server (wrong direction of the dependency graph).
 */
function validatedExecutable(candidate: string, platform: NodeJS.Platform): string | null {
  if (
    typeof candidate !== "string" || candidate.length === 0 ||
    candidate.trim() !== candidate || candidate.includes("\u0000") ||
    !path.isAbsolute(candidate)
  ) return null;
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile()) return null;
    if (platform !== "win32") accessSync(resolved, fsConstants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Resolve the `claude` CLI binary to spawn for chat turns (CliDriver/PersistentSession
 * below), deterministically rather than trusting an ambient shell PATH lookup at spawn
 * time. A bare command name handed to `spawn()` still gets resolved by the OS against
 * whatever `process.env.PATH` happens to be at that moment — same nondeterminism this
 * task's audit is closing for the sidecar/health/provider-discovery surfaces.
 *
 * Resolution order:
 *  1. `CLAUDE_UI_CLAUDE_BIN`, if set — an explicit power-user/test override, trusted
 *     as-is with no validation (same behavior as before this fix; it's an intentional
 *     escape hatch, not ambient discovery).
 *  2. Each absolute directory on PATH, plus the same well-known install locations the
 *     native Claude runtime discovery trusts (`~/.local/bin`, `~/.claude/bin`,
 *     `~/.claude/local`, and the platform's Homebrew/`/usr/local`/`/usr` bin dirs) —
 *     first candidate that resolves to a real, executable file wins.
 *  3. If nothing validates, fall back to the bare name "claude" — preserving the
 *     exact prior behavior for setups a validated scan can't anticipate (e.g. shell
 *     shims/functions), rather than refusing to spawn at all.
 */
export function resolveClaudeBin(options: ResolveClaudeBinOptions = {}): string {
  const env = options.env ?? process.env;

  const explicit = env.CLAUDE_UI_CLAUDE_BIN?.trim();
  if (explicit) return explicit;

  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  const executableName = platform === "win32" ? "claude.exe" : "claude";
  const delimiter = platform === "win32" ? ";" : ":";

  const candidates: string[] = [];
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry)) candidates.push(path.join(entry, executableName));
  }
  candidates.push(
    path.join(homedir, ".local", "bin", executableName),
    path.join(homedir, ".claude", "bin", executableName),
    path.join(homedir, ".claude", "local", executableName),
  );
  if (platform === "darwin") {
    candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  } else if (platform !== "win32") {
    candidates.push("/usr/local/bin/claude", "/usr/bin/claude");
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const validated = validatedExecutable(candidate, platform);
    if (validated) return validated;
  }

  return "claude";
}

const CLAUDE_BIN = resolveClaudeBin();

/** Coerce a usage field to a non-negative integer (0 for missing/garbage). */
function usageNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Input-side token count from an Anthropic `usage` object: the prompt tokens plus
 * the cache read/creation tokens (all part of what was billed as "input" context).
 */
function readInputTokens(usage: Record<string, unknown>): number {
  return (
    usageNum(usage.input_tokens) +
    usageNum(usage.cache_read_input_tokens) +
    usageNum(usage.cache_creation_input_tokens)
  );
}

/** Output (generated) token count from an Anthropic `usage` object. */
function readOutputTokens(usage: Record<string, unknown>): number {
  return usageNum(usage.output_tokens);
}

/**
 * Builds the per-line stream-json handler shared by the per-turn and persistent
 * paths, so both normalize output identically. `state` is mutable so the result
 * frame and resolved session id survive across lines.
 *
 * Exported for unit testing of the (fiddly) stream-json frame dispatch — especially
 * the text vs. thinking delta split — without spawning the `claude` binary.
 */
export function makeLineHandler(handlers: TurnHandlers, state: {
  sessionId: string | null;
  seq: number;
  finalResult: TurnResult | null;
}): (line: string) => void {
  // Running token estimate for THIS handler (one per turn/session). The Anthropic
  // streaming protocol reports cumulative usage on the partial-message frames:
  //   - message_start.message.usage carries the input side (input_tokens +
  //     cache_read/cache_creation) and an initial output_tokens, and
  //   - message_delta.usage carries the GROWING cumulative output_tokens.
  // We track the latest seen of each so a face can show a live "tokens so far"
  // meter mid-turn (before the final `result` frame's authoritative totals).
  let meterInput = 0;
  let meterOutput = 0;
  /** Emit onStatus({ kind:"tokens" }) when the estimate has actually moved. */
  const emitTokens = (): void => {
    handlers.onStatus?.({
      kind: "tokens",
      data: { input: meterInput, output: meterOutput, total: meterInput + meterOutput },
    });
  };

  return (line: string): void => {
    const s = line.trim();
    if (!s) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(s) as Record<string, unknown>;
    } catch {
      return;
    }
    const t = m.type as string | undefined;

    if (t === "system") {
      if (m.subtype === "init") {
        state.sessionId = (m.session_id as string) ?? state.sessionId;
        const init: SessionInit = {
          sessionId: state.sessionId ?? "",
          model: (m.model as string) ?? null,
          cwd: (m.cwd as string) ?? null,
          tools: Array.isArray(m.tools) ? (m.tools as string[]) : [],
          permissionMode: (m.permissionMode as string) ?? null,
          slashCommands: Array.isArray(m.slash_commands) ? (m.slash_commands as string[]) : [],
        };
        if (state.sessionId) handlers.onSession?.(state.sessionId, init);
      } else {
        handlers.onStatus?.({ kind: (m.subtype as string) ?? "system" });
      }
    } else if (t === "stream_event") {
      // Partial-message frames from --include-partial-messages. Emit text-token
      // deltas via onDelta and extended-thinking deltas via onThinkingDelta; ignore
      // message_start/stop, content_block_start/stop, message_delta, signature_delta,
      // etc. The final full "assistant" message still arrives below (onMessage).
      const event = m.event as Record<string, unknown> | undefined;
      if (event && event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
          handlers.onDelta?.(delta.text);
        } else if (delta && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          // Extended-thinking frames carry the reasoning text under `thinking`.
          handlers.onThinkingDelta?.(delta.thinking);
        }
      } else if (event && event.type === "message_start") {
        // First frame of an assistant message: usage lives under message.usage and
        // carries the input side (+ an initial output count). Take the input side as
        // our running input estimate; bump output if present.
        const msg = event.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, unknown> | undefined;
        if (usage) {
          meterInput = readInputTokens(usage);
          const out = readOutputTokens(usage);
          if (out > meterOutput) meterOutput = out;
          emitTokens();
        }
      } else if (event && event.type === "message_delta") {
        // Incremental assistant-message frame: usage.output_tokens is CUMULATIVE for
        // the turn so far, so it monotonically grows — drive the live meter from it.
        const usage = event.usage as Record<string, unknown> | undefined;
        if (usage) {
          const out = readOutputTokens(usage);
          if (out > meterOutput) meterOutput = out;
          // message_delta may also restate input (e.g. when tools rerun); keep the max.
          const inp = readInputTokens(usage);
          if (inp > meterInput) meterInput = inp;
          emitTokens();
        }
      }
    } else if (t === "assistant" || t === "user") {
      const norm = normalizeLine(m, state.seq);
      if (norm) {
        state.seq += 1;
        handlers.onMessage?.(norm);
      }
    } else if (t === "result") {
      const usageObj = m.usage as Record<string, unknown> | undefined;
      state.finalResult = {
        sessionId: (m.session_id as string) ?? state.sessionId,
        subtype: (m.subtype as string) ?? "unknown",
        isError: m.is_error === true,
        costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0,
        usage: usageObj ? usageFromMessage({ usage: usageObj }) : undefined,
        denials: Array.isArray(m.permission_denials)
          ? (m.permission_denials as Array<Record<string, unknown>>).map((d) => ({
              toolName: (d.tool_name as string) ?? "tool",
              toolInput: d.tool_input,
            }))
          : [],
        resultText: typeof m.result === "string" ? m.result : undefined,
      };
      handlers.onResult?.(state.finalResult);
    }
  };
}

/**
 * Splits a stdout byte stream into newline-delimited lines, feeding each complete
 * line to `onLine`. Returns a flush() that handles any trailing partial line.
 *
 * Backed by the bounded {@link createLineSplitter}: normal lines stream through
 * unchanged, but the pending (no-newline) buffer is capped so a process that emits
 * a giant line without a newline can't grow memory without bound. An overflow logs
 * a one-line warning and the line is truncated to the cap.
 */
function makeLineSplitter(onLine: (line: string) => void): {
  push: (chunk: Buffer) => void;
  flush: () => void;
} {
  return createLineSplitter(onLine, {
    onOverflow: (dropped) =>
      console.warn(`[driver] dropped ${dropped} bytes from an oversized stdout line (no newline)`),
  });
}

/**
 * Frames a plain-text user prompt as a single stream-json input line (with
 * trailing newline) for `claude --input-format stream-json`'s stdin. This is the
 * exact shape the CLI accepts for an interactive user turn.
 */
export function encodeUserMessage(text: string): string {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

export class CliDriver implements AgentDriver {
  runTurn(req: TurnRequest, handlers: TurnHandlers): RunningTurn {
    const args = ["-p", req.prompt, "--output-format", "stream-json", "--verbose"];
    // Stream partial tokens by default; opt out only when explicitly disabled.
    const includePartial = req.includePartial !== false;
    if (includePartial) args.push("--include-partial-messages");
    if (req.sessionId) args.push("--resume", req.sessionId);
    // Fork into a NEW conversation that inherits the resumed context (CLI
    // --fork-session). No-op unless req.fork && req.sessionId — non-fork turns keep
    // the exact same argv as before. See driver/fork.ts.
    args.push(...forkCliArgs(req));
    if (req.model) args.push("--model", req.model);
    args.push("--permission-mode", req.permissionMode ?? "acceptEdits");

    // Optionally sandbox the spawn (env-scrub always; macOS Seatbelt wrapper when
    // available). With no sandbox option this returns the command/args/env unchanged,
    // so the default spawn is byte-for-byte identical to before. See driver/sandbox.ts.
    const { spec } = applySandbox(
      { command: CLAUDE_BIN, args, env: { ...process.env } },
      req.sandbox,
    );

    const child = spawn(spec.command, spec.args, {
      cwd: req.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: spec.env,
    });

    const state = { sessionId: req.sessionId ?? null, seq: 0, finalResult: null as TurnResult | null };
    let stderr = "";
    const handleLine = makeLineHandler(handlers, state);
    const splitter = makeLineSplitter(handleLine);

    const done = new Promise<TurnResult | null>((resolve) => {
      child.stdout.on("data", (d: Buffer) => splitter.push(d));
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (e) => {
        handlers.onError?.(e.message);
        resolve(null);
      });
      child.on("close", (code) => {
        splitter.flush();
        if (!state.finalResult && code !== 0) {
          handlers.onError?.(stderr.trim() || `claude exited with code ${code}`);
        }
        resolve(state.finalResult);
      });
    });

    return {
      interrupt() {
        // Graceful: SIGINT (stop politely), then SIGTERM, then SIGKILL — escalation
        // stops the instant the process exits. The turn still stops; just cleaner
        // than the old bare SIGTERM.
        gracefulInterrupt(child);
      },
      done,
    };
  }

  /**
   * SCAFFOLD (additive, not yet the default). Opens a single long-lived
   * `claude --input-format stream-json --output-format stream-json` process and
   * returns a {@link PersistentSession} you can `send()` multiple user prompts to,
   * streaming output through the same handlers/normalization as `runTurn`.
   *
   * This is the foundation for later steering and inline tool permissions. The
   * per-turn `runTurn` path above is unchanged and remains the production path;
   * nothing in the app calls this yet.
   */
  openPersistentSession(req: PersistentSessionRequest, handlers: TurnHandlers): PersistentSession {
    return new PersistentSession(req, handlers);
  }
}

/** Options for opening a persistent stream-json session. */
export interface PersistentSessionRequest {
  cwd: string;
  /** Resume an existing session if provided; otherwise a fresh one is created. */
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  includePartial?: boolean;
}

/**
 * SCAFFOLD. A long-lived `claude` process driven over stream-json stdin/stdout.
 *
 * What is wired: process spawn with the stream-json input+output formats, the
 * stdin message writer ({@link send}), shared stdout normalization (same handlers
 * as `runTurn`), and lifecycle ({@link interrupt}/{@link close}).
 *
 * What is intentionally NOT wired yet: inline permission requests
 * (`onPermissionRequest`) and `permission-response` replies — those require the
 * CLI's control-protocol handshake, which is not surfaced here. When that lands,
 * route control frames in via {@link respondToPermission} and emit them out via
 * the handler. Not the default path; `runTurn` remains production.
 */
export class PersistentSession {
  private child: ChildProcessWithoutNullStreams;
  private state: { sessionId: string | null; seq: number; finalResult: TurnResult | null };
  private splitter: { push: (chunk: Buffer) => void; flush: () => void };
  private stderr = "";
  /** Resolves when the underlying process exits. */
  readonly closed: Promise<number | null>;
  private closeError = false;

  constructor(req: PersistentSessionRequest, handlers: TurnHandlers) {
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    const includePartial = req.includePartial !== false;
    if (includePartial) args.push("--include-partial-messages");
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.model) args.push("--model", req.model);
    args.push("--permission-mode", req.permissionMode ?? "acceptEdits");

    this.child = spawn(CLAUDE_BIN, args, {
      cwd: req.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    }) as ChildProcessWithoutNullStreams;

    this.state = { sessionId: req.sessionId ?? null, seq: 0, finalResult: null };
    this.splitter = makeLineSplitter(makeLineHandler(handlers, this.state));

    this.closed = new Promise<number | null>((resolve) => {
      this.child.stdout.on("data", (d: Buffer) => this.splitter.push(d));
      this.child.stderr.on("data", (d: Buffer) => {
        this.stderr += d.toString();
      });
      this.child.on("error", (e) => {
        this.closeError = true;
        handlers.onError?.(e.message);
        resolve(null);
      });
      this.child.on("close", (code) => {
        this.splitter.flush();
        if (!this.closeError && code !== 0) {
          handlers.onError?.(this.stderr.trim() || `claude exited with code ${code}`);
        }
        resolve(code);
      });
    });
  }

  /** The resolved session id once the `system:init` frame has arrived. */
  get sessionId(): string | null {
    return this.state.sessionId;
  }

  /**
   * Write a user prompt to the live process as a stream-json line. Safe to call
   * multiple times to continue the same conversation (steering). Returns false if
   * stdin is no longer writable (process exited).
   */
  send(prompt: string): boolean {
    if (!this.child.stdin.writable) return false;
    return this.child.stdin.write(encodeUserMessage(prompt));
  }

  /**
   * SCAFFOLD (not yet wired). Reply to an inline permission request once the CLI
   * control protocol is hooked up. Today this is a no-op placeholder so callers
   * can be written against the final shape.
   */
  respondToPermission(_id: string, _decision: "allow" | "deny", _message?: string): void {
    // Intentionally unimplemented: the stream-json control-frame for inline
    // permission replies is not surfaced yet. See PersistentSession docblock.
  }

  /**
   * Stop the current activity gracefully: SIGINT first (the process can stop cleanly
   * and stay alive for a later resume), escalating to SIGTERM then SIGKILL only if it
   * ignores the polite signal. Escalation stops the moment the process exits.
   */
  interrupt(): void {
    gracefulInterrupt(this.child);
  }

  /** End stdin and let the process exit; awaits {@link closed}. */
  async close(): Promise<void> {
    if (this.child.stdin.writable) this.child.stdin.end();
    await this.closed;
  }
}

let singleton: CliDriver | null = null;
export function createDriver(): AgentDriver {
  if (!singleton) singleton = new CliDriver();
  return singleton;
}
