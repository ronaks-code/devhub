/**
 * The live-session driver contract + the WS protocol shared by server and web.
 * PURE types (no Node) so the browser can `import type` them.
 *
 * v1 model (validated against claude 2.1.178): one `claude -p --output-format
 * stream-json` process PER TURN; `--resume <sessionId>` continues context. Inline
 * per-tool approve/deny needs the SDK control-protocol handshake (not available
 * over the raw CLI), so permissions are governed by a permission-mode toggle.
 */
import type { NormalizedMessage, TokenUsage } from "../types.js";
// Type-only import: `SandboxOptions` is a plain interface, so this carries no runtime
// (Node) dependency into this browser-safe types module.
import type { SandboxOptions } from "./sandbox.js";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export const PERMISSION_MODES: PermissionMode[] = [
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "default",
];

export interface TurnRequest {
  cwd: string;
  prompt: string;
  /** Resume this session if provided; otherwise a new session is created. */
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  includePartial?: boolean;
  /**
   * Optional sandbox for a headless turn (isolated / no configured network). When
   * absent the turn spawns exactly as before; when `{ enabled: true }` the spawn is
   * env-scrubbed (proxy vars removed + marker set) and, on macOS where `sandbox-exec`
   * exists, wrapped in a Seatbelt profile that denies outbound network. See
   * `driver/sandbox.ts` for exactly what isolation each layer provides (it does not
   * overclaim). Additive: omitting it preserves the original behavior.
   */
  sandbox?: SandboxOptions;
  /**
   * Branch this turn into a NEW conversation that inherits the resumed session's
   * context, instead of continuing the original. Maps to the CLI's `--fork-session`
   * (only meaningful together with `sessionId`). The new session id arrives on the
   * init system line. Additive: absent/false keeps the original resume-in-place
   * behavior. See `driver/fork.ts` for the forking helpers.
   */
  fork?: boolean;
}

export interface SessionInit {
  sessionId: string;
  model: string | null;
  cwd: string | null;
  tools: string[];
  permissionMode: string | null;
  slashCommands: string[];
}

export interface PermissionDenial {
  toolName: string;
  toolInput?: unknown;
}

/**
 * A request from the agent to approve/deny a single tool call. Surfaced over the
 * persistent (stream-json) control protocol — NOT the per-turn `runTurn` path,
 * which has no inline approval channel. Types only for now (no behavior wired).
 */
export interface PermissionRequest {
  /** Correlates the response back to this request. */
  id: string;
  toolName: string;
  toolInput: unknown;
  /** Optional pre-baked decisions/edits the agent proposes (e.g. "allow once"). */
  suggestions?: string[];
}

export interface PermissionResponse {
  id: string;
  decision: "allow" | "deny";
  /** Optional human-readable note shown to the agent (e.g. a deny reason). */
  message?: string;
}

export interface TurnResult {
  sessionId: string | null;
  subtype: string; // "success" | "error_max_turns" | "error_*"
  isError: boolean;
  costUsd: number;
  usage?: TokenUsage;
  denials: PermissionDenial[];
  resultText?: string;
}

export interface TurnHandlers {
  onSession?: (sessionId: string, init: SessionInit) => void;
  onMessage?: (m: NormalizedMessage) => void;
  /** Token-by-token partial assistant text (from --include-partial-messages). */
  onDelta?: (text: string) => void;
  /**
   * Token-by-token partial THINKING text (extended-thinking `thinking_delta` frames
   * from --include-partial-messages). Separate from {@link onDelta} so a face can
   * render the model's reasoning stream distinctly from its answer text. Optional;
   * a face that doesn't surface thinking simply leaves it unset.
   */
  onThinkingDelta?: (text: string) => void;
  onStatus?: (status: { kind: string; data?: unknown }) => void;
  onResult?: (r: TurnResult) => void;
  onError?: (err: string) => void;
  /**
   * Inline tool-permission request from the agent. Only fired by the persistent
   * (stream-json) session path; the per-turn `runTurn` driver never calls it.
   * Not yet wired — present so faces/server can type against it.
   */
  onPermissionRequest?: (req: PermissionRequest) => void;
}

export interface RunningTurn {
  interrupt(): void;
  done: Promise<TurnResult | null>;
}

export interface AgentDriver {
  runTurn(req: TurnRequest, handlers: TurnHandlers): RunningTurn;
}

// ---- WS protocol (web <-> server) ----

export type ClientMsg =
  | {
      t: "prompt";
      cwd: string;
      prompt: string;
      sessionId?: string;
      model?: string;
      permissionMode?: PermissionMode;
    }
  | { t: "interrupt" }
  // Inline approve/deny reply. Future use: only meaningful on the persistent
  // (stream-json) session path; ignored by the per-turn driver.
  | {
      t: "permission-response";
      id: string;
      decision: "allow" | "deny";
      message?: string;
      /**
       * For an EDITABLE approval: the (possibly user-edited) tool input to run
       * instead of the agent's original. Only meaningful with `decision: "allow"`;
       * omitted means "run the tool as proposed". Carried opaquely (the shape is the
       * tool's own input) on the persistent (stream-json) control path.
       */
      updatedInput?: unknown;
    };

export type ServerMsg =
  | { t: "session"; sessionId: string; init: SessionInit }
  | { t: "message"; message: NormalizedMessage }
  | { t: "delta"; text: string }
  // Token-by-token partial THINKING text (extended-thinking stream), kept distinct
  // from "delta" (answer text) so a face can render reasoning separately.
  | { t: "thinking-delta"; text: string }
  | { t: "status"; kind: string }
  | { t: "result"; result: TurnResult }
  | { t: "error"; message: string }
  | { t: "turn-end" }
  // Agent asks the user to approve/deny a tool call. Future use: emitted only by
  // the persistent session path, answered by a "permission-response" ClientMsg.
  | {
      t: "permission-request";
      id: string;
      toolName: string;
      toolInput: unknown;
      suggestions?: string[];
    };
