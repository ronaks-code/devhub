/**
 * Shared, framework-agnostic types. PURE — no Node imports — so the browser face
 * can `import type` these without pulling Node code into the bundle.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
      /** Path to a spilled large output under <sessionId>/tool-results/, if any. */
      spilledPath?: string;
    }
  | { type: "image"; mediaType?: string }
  | { type: "unknown"; raw: unknown };

/** Normalized role for rendering. `meta` lines are not usually shown. */
export type MessageRole =
  | "user"
  | "assistant"
  | "system"
  | "attachment"
  | "hook"
  | "queue"
  | "meta";

export interface NormalizedMessage {
  /** Sequence index within the returned window (stable for React keys). */
  seq: number;
  uuid: string | null;
  parentUuid: string | null;
  role: MessageRole;
  /** Raw line `type` from the transcript (e.g. "assistant", "attachment"). */
  type: string;
  timestamp: string | null;
  model?: string;
  blocks: ContentBlock[];
  usage?: TokenUsage;
  isSidechain?: boolean;
  /** Set when this message came from a subagent transcript file. */
  agentId?: string;
}

export type TitleSource =
  | "custom"
  | "ai-title"
  | "summary"
  | "first-prompt"
  | "session-id";

export interface SubagentRef {
  agentId: string;
  filePath: string;
  /** Best-effort label (agent name / first line) if cheaply available. */
  label?: string;
}

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  /** True working directory read from inside the transcript (never decoded from folder). */
  cwd: string | null;
  projectId: string;
  title: string;
  titleSource: TitleSource;
  gitBranch?: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Count of conversation messages (user + assistant). May be 0 until indexed. */
  messageCount: number;
  usage: TokenUsage;
  sizeBytes: number;
  mtimeMs: number;
  hasSubagents: boolean;
  pinned: boolean;
  /** True while a full index of this file is still pending (counts/usage approximate). */
  indexed: boolean;
}

export interface ProjectSummary {
  id: string;
  /** True project path. */
  cwd: string;
  name: string;
  sessionCount: number;
  lastActivity: string | null;
  totalUsage: TokenUsage;
  /** ~/.claude/projects folders that map to this cwd (>1 ⇒ rename/collision recovered). */
  encodedFolders: string[];
}

export interface RunningSession {
  pid: number;
  sessionId: string;
  cwd: string | null;
  status: string; // "busy" | "idle" | "waiting" | ...
  model?: string | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  name?: string | null;
  entrypoint?: string | null;
}

export interface Stats {
  totalSessions: number;
  totalProjects: number;
  totalUsage: TokenUsage;
  topProjects: Array<{ projectId: string; name: string; sessions: number; tokens: number }>;
  /** Sessions active per day (by last activity), oldest→newest. */
  activity: Array<{ date: string; sessions: number }>;
}

export interface SearchHit {
  sessionId: string;
  projectId: string;
  projectName: string;
  title: string;
  cwd: string | null;
  role: string;
  /** Matching text excerpt (may include highlight markers). */
  snippet: string;
  timestamp: string | null;
}

export interface SessionMessagesPage {
  session: SessionSummary;
  messages: NormalizedMessage[];
  /** True when older messages exist before the returned window (huge-file tail mode). */
  truncatedFromStart: boolean;
  subagents: SubagentRef[];
}

/** Server-Sent Event payloads pushed to faces. */
export type EngineEvent =
  | { kind: "index-progress"; done: number; total: number }
  | { kind: "session-changed"; sessionId: string; projectId: string }
  | { kind: "session-added"; sessionId: string; projectId: string }
  | { kind: "ready" };

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}
