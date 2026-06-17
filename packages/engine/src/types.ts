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
  | {
      type: "image";
      /** Media type from the source block (e.g. "image/png"), when known. */
      mediaType?: string;
      /**
       * Base64-encoded image bytes inlined in the transcript, when present and
       * small enough to carry (capped — see {@link MAX_INLINE_IMAGE_BYTES}). The UI
       * renders this directly as a data URL. Optional for backward-compat: an older
       * `{ type: "image", mediaType? }` block omits it.
       */
      data?: string;
      /**
       * Path to an image FILE the transcript references instead of inlining
       * (a source of kind "file"/"path"). The face resolves/serves it via its
       * allowlisted-asset reader. Optional and mutually exclusive with `data`.
       */
      assetPath?: string;
    }
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
  /**
   * The model the session ran on (the most-frequent / last `message.model` across
   * its assistant lines), e.g. "claude-opus-4-8". Null when unknown (no assistant
   * line carried a model, or an older row predating model tracking and not yet
   * backfilled by a forced reindex).
   */
  model: string | null;
  pinned: boolean;
  /**
   * Hidden from the default session lists unless explicitly included. User-owned
   * flag in session_meta (never derived from the transcript).
   */
  archived: boolean;
  /** User-assigned tags (normalized: trimmed, lower-cased, de-duped). Empty when none. */
  tags: string[];
  /**
   * Free-form notes (markdown) the user attached to this session, or null when none.
   * User-owned scratchpad in session_meta; never derived from the transcript.
   */
  notes: string | null;
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
  /** User-pinned project (sorts to the top). */
  favorite: boolean;
  /** Hidden from the default project list unless explicitly included. */
  archived: boolean;
  /** Manual ordering hint within a favorite/non-favorite group (lower first). */
  sortOrder: number;
  /** Optional UI accent color (free-form, e.g. a hex string), or null. */
  color: string | null;
  /**
   * Per-project DEFAULT model id for new sessions (e.g. "claude-opus-4-8"), or null
   * to fall back to the app-wide `AppSettings.defaultModel`. User-owned preference.
   */
  defaultModel: string | null;
  /**
   * Per-project DEFAULT permission mode for new sessions (e.g. "default",
   * "acceptEdits", "plan"), or null to fall back to the app-wide setting.
   */
  defaultPermissionMode: string | null;
}

/**
 * Per-project UI metadata we own (the user's pins/archive/order/color + per-project
 * default model/permission mode). Keyed by the stable projectId; never derived from
 * the transcript. All fields have sane defaults so a project with no row behaves
 * like an unpinned, unarchived one with no project-specific defaults.
 */
export interface ProjectMeta {
  projectId: string;
  favorite: boolean;
  archived: boolean;
  sortOrder: number;
  color: string | null;
  /** Per-project default model id, or null = use the app-wide default. */
  defaultModel: string | null;
  /** Per-project default permission mode, or null = use the app-wide default. */
  defaultPermissionMode: string | null;
}

/** Baseline project metadata for a project that has no stored row yet. */
export const DEFAULT_PROJECT_META: Omit<ProjectMeta, "projectId"> = {
  favorite: false,
  archived: false,
  sortOrder: 0,
  color: null,
  defaultModel: null,
  defaultPermissionMode: null,
};

export interface RunningSession {
  pid: number;
  sessionId: string;
  cwd: string | null;
  status: string; // "busy" | "idle" | "waiting" | "dead" | ...
  /**
   * Whether the PID is still a live OS process (probed with `process.kill(pid, 0)`).
   * False for stale/zombie `<pid>.json` files Claude Code left behind; such entries
   * also carry `status: "dead"`.
   */
  alive: boolean;
  model?: string | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  name?: string | null;
  entrypoint?: string | null;
  /**
   * What a `status: "waiting"` session is blocked on (e.g. a permission prompt or a
   * tool name), read straight from the `<pid>.json` `waitingFor` field. Null when the
   * file doesn't report it or the session isn't waiting. Lets the dashboard show
   * *why* a session is paused.
   */
  waitingFor?: string | null;
  /**
   * When the session's `status` last changed (epoch ms), from the file's
   * `statusUpdatedAt`. Lets the dashboard show staleness — how long a session has sat
   * in its current state. Null when the file doesn't report it.
   */
  statusUpdatedAt?: number | null;
  /**
   * True when this session is BLOCKED ON THE USER: it's `status: "waiting"` (e.g. a
   * permission prompt) AND has sat there longer than the staleness threshold, so it
   * won't make progress until the user acts. Lets the dashboard float "needs you"
   * sessions to the top. Always false for dead/non-waiting sessions.
   */
  needsYou?: boolean;
}

/**
 * Where the current calendar month's APPROXIMATE spend sits relative to the user's
 * soft monthly budget (`AppSettings.monthlyBudgetUsd`). Month-to-date cost is the
 * current UTC month's slice of the per-day cost series. Lives here (pure) so faces
 * can `import type` it; computed by the engine's `budget` module.
 */
export interface BudgetStatus {
  /** The configured soft budget in USD, or null when the user hasn't set one. */
  monthlyBudgetUsd: number | null;
  /** APPROXIMATE USD spent so far this calendar month (UTC). */
  monthToDateUsd: number;
  /** Fraction of the budget consumed; 0 when no (or a non-positive) budget is set. */
  pct: number;
  /** "none" while under 80% (or no budget), "warn" at >=80%, "over" at >=100%. */
  alert: "none" | "warn" | "over";
}

export interface Stats {
  totalSessions: number;
  totalProjects: number;
  totalUsage: TokenUsage;
  /**
   * APPROXIMATE total spend in USD across all sessions, summing per-session
   * `costUsd(session.model, session.usage)`. Display-only estimate, never billed
   * truth; sessions with an unknown model use the fallback pricing tier.
   */
  totalCostUsd: number;
  topProjects: Array<{
    projectId: string;
    name: string;
    sessions: number;
    tokens: number;
    /** APPROXIMATE USD spend for this project (sum of its sessions' costUsd). */
    costUsd: number;
  }>;
  /** Sessions active per day (by last activity), oldest→newest. */
  activity: Array<{ date: string; sessions: number }>;
  /** Monthly spend budget status (for the dashboard's budget bar). */
  budget: BudgetStatus;
  /**
   * APPROXIMATE usage rolled up by model, cost descending. Each session is priced by
   * its OWN model; sessions with a null/unknown model bucket under "unknown". Powers
   * the dashboard's per-model spend breakdown. Display-only estimate.
   */
  byModel: Array<{
    model: string;
    /** Sum of all token buckets (input + output + cache read + cache write). */
    tokens: number;
    /** APPROXIMATE USD spend on this model. */
    costUsd: number;
    /** Number of sessions that ran on this model. */
    sessions: number;
  }>;
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
  /**
   * Index of the best-matching message WITHIN the session (the mirrored message
   * `seq` of the matched row), so the UI can jump straight to the match. ALWAYS
   * populated by `search()` (0 when the underlying seq is unknown — e.g. legacy
   * mirrored rows predating seq tracking). Declared OPTIONAL for backward-compat:
   * existing consumers that pre-declared their own optional `seq` (the web face's
   * `SearchHitWithSeq`) keep type-checking, and any older caller constructing a
   * `SearchHit` literal isn't forced to supply it.
   */
  seq?: number;
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
  /**
   * A Claude Code CONFIG file/dir changed on disk (settings.json, ~/.claude.json,
   * agents/, hooks, a project's .claude/). Carries the absolute path that changed so
   * a face can invalidate just the affected config view. NOT a transcript event —
   * the watcher only watches config paths. Debounced like the transcript watcher.
   */
  | { kind: "config-changed"; path: string }
  | { kind: "ready" };

/**
 * User-facing app preferences, persisted in the `settings` key/value table.
 * Every field is optional: a missing key means "use the default / not set yet".
 * Values are stored as JSON so types round-trip (numbers, null, strings) intact.
 */
export interface AppSettings {
  /** Preferred model id for new sessions (e.g. "claude-opus-4-8"). */
  defaultModel?: string;
  /** Preferred permission mode for new sessions (e.g. "default", "acceptEdits"). */
  defaultPermissionMode?: string;
  /** UI theme. */
  theme?: "dark" | "light" | "system";
  /** UI density token (e.g. "comfortable", "compact"). */
  density?: string;
  /** Last project the user had open (for restore-on-launch). */
  lastProjectId?: string | null;
  /** Last tab/view the user had open. */
  lastTab?: string;
  /** Soft monthly spend budget in USD, or null when unset. */
  monthlyBudgetUsd?: number | null;
}

/** Baseline settings applied under any value the user hasn't explicitly set. */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  density: "comfortable",
  lastProjectId: null,
  monthlyBudgetUsd: null,
};

/**
 * Cap on inline base64 image bytes carried on an image ContentBlock (~512KB of
 * raw image data). Larger images are dropped to `mediaType`-only so a single huge
 * paste can't bloat a message payload; the face can still fall back to its asset
 * reader for the on-disk source when available.
 */
export const MAX_INLINE_IMAGE_BYTES = 512 * 1024;

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
