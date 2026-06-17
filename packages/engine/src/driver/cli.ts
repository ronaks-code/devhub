/**
 * CLI-subprocess driver. Spawns `claude -p --output-format stream-json` per turn,
 * inheriting the user's local login (no API key). Reuses the M1 parser to normalize
 * assistant/user lines, so the chat UI renders identically to the history viewer.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { normalizeLine, usageFromMessage } from "../parser.js";
import { createLineSplitter } from "./buffer.js";
import type {
  AgentDriver,
  PermissionMode,
  RunningTurn,
  SessionInit,
  TurnHandlers,
  TurnRequest,
  TurnResult,
} from "./types.js";

const CLAUDE_BIN = process.env.CLAUDE_UI_CLAUDE_BIN?.trim() || "claude";

/**
 * Builds the per-line stream-json handler shared by the per-turn and persistent
 * paths, so both normalize output identically. `state` is mutable so the result
 * frame and resolved session id survive across lines.
 */
function makeLineHandler(handlers: TurnHandlers, state: {
  sessionId: string | null;
  seq: number;
  finalResult: TurnResult | null;
}): (line: string) => void {
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
      // deltas only; ignore message_start/stop, content_block_start/stop,
      // message_delta, thinking_delta, signature_delta, etc. The final full
      // "assistant" message still arrives below and is emitted via onMessage.
      const event = m.event as Record<string, unknown> | undefined;
      if (event && event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
          handlers.onDelta?.(delta.text);
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
    if (req.model) args.push("--model", req.model);
    args.push("--permission-mode", req.permissionMode ?? "acceptEdits");

    const child = spawn(CLAUDE_BIN, args, {
      cwd: req.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
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
        child.kill("SIGTERM");
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

  /** Stop the current activity (SIGTERM); the process may stay alive for resume. */
  interrupt(): void {
    this.child.kill("SIGTERM");
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
