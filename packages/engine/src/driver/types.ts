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
  onStatus?: (status: { kind: string; data?: unknown }) => void;
  onResult?: (r: TurnResult) => void;
  onError?: (err: string) => void;
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
  | { t: "interrupt" };

export type ServerMsg =
  | { t: "session"; sessionId: string; init: SessionInit }
  | { t: "message"; message: NormalizedMessage }
  | { t: "delta"; text: string }
  | { t: "status"; kind: string }
  | { t: "result"; result: TurnResult }
  | { t: "error"; message: string }
  | { t: "turn-end" };
