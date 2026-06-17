import type { SearchHit, Stats } from "@claude-ui/engine/types";

export type {
  ProjectSummary,
  SessionSummary,
  SessionMessagesPage,
  NormalizedMessage,
  ContentBlock,
  TokenUsage,
  SubagentRef,
  EngineEvent,
  MessageRole,
  TitleSource,
  Stats,
  RunningSession,
  SearchHit,
} from "@claude-ui/engine/types";

/**
 * One per-model row of the dashboard breakdown. Derived from (and structurally
 * identical to) the engine `Stats.byModel` element — aliased here so the
 * ModelBreakdown widget has a named type to consume without re-importing the
 * engine's indexed access in every file.
 */
export type ModelStat = Stats["byModel"][number];

/**
 * A search hit widened at the web boundary with the matching message's `seq`.
 * The engine `SearchHit` does not (yet) carry `seq`, and we can't edit that
 * package — so we extend it here instead of shimming the engine type. `seq` is
 * optional: when the server starts returning it, jump-to-match becomes exact;
 * until then the field is simply absent and we fall back to opening the session.
 */
export interface SearchHitWithSeq extends SearchHit {
  /** 0-based message sequence index within the session window of the match. */
  seq?: number;
}

// Read-only git result shapes used by the GitPanel. Defined here (rather than
// imported from the engine root, which bundles Node-only code) to keep the web
// build server-free. Kept in lockstep with packages/engine/src/git.ts.
export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  date: string;
}

/**
 * One branch from GET /api/git/branches. Mirrors the engine's `GitBranch`
 * (git.ts); defined locally so the web bundle stays free of Node-only engine
 * code. Kept in lockstep with packages/engine/src/git.ts.
 */
export interface GitBranch {
  name: string;
  /** True for the currently checked-out branch. */
  current: boolean;
}

/** A unified diff for one file, or the whole working tree when `file` is null. */
export interface GitDiff {
  file: string | null;
  /** Raw unified-diff text (may be empty when there are no changes). */
  patch: string;
}

// MCP server config shapes. Mirrored locally (rather than imported from the
// engine config module, which uses node:fs) to keep the web build server-free.
// Kept in lockstep with packages/engine/src/config/index.ts.

/** Where a config entry was found. */
export type ConfigScope = "global" | "project";

/** One configured MCP server, as returned by GET /api/config/mcp. */
export interface McpServerDef {
  name: string;
  /** "stdio" | "sse" | "http" | … as written in config; null when unspecified. */
  type: string | null;
  command: string | null;
  args: string[];
  scope: ConfigScope;
  /** The full original entry, preserved for display/editing. */
  raw: Record<string, unknown>;
}

/** A validated MCP server entry to upsert via PUT /api/config/mcp. */
export interface McpServerInput {
  /** "stdio" | "sse" | "http"; defaults to "stdio" when omitted. */
  type?: string;
  /** Required for stdio servers. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For sse/http servers. */
  url?: string;
}

/**
 * Response from GET /api/config/hooks — the merged hooks map plus the settings.json
 * files that contributed (lowest precedence first). `hooks` keys are hook events
 * (e.g. "PreToolUse") mapping to matcher entries; the entry shape is passed through
 * from Claude Code as-is. Mirrors the engine's SettingsLayered (config/index.ts);
 * defined locally so the web bundle stays free of the Node-only engine config code.
 */
export interface HooksConfig {
  hooks: Record<string, unknown[]>;
  /** settings.json paths that fed the merged view, lowest precedence first. */
  sources: string[];
  scope: ConfigScope;
}

/** Payload for PUT /api/config/hooks: replace the hooks map at the given scope. */
export interface HooksInput {
  /** Full hooks map to persist (event -> matcher entries). */
  hooks: Record<string, unknown[]>;
}

/**
 * A CLAUDE.md document from GET /api/config/claudemd. Mirrors the engine's
 * `ClaudeMdDoc` (config/index.ts); defined locally so the web bundle stays free
 * of Node-only engine code. When no file exists yet the server returns
 * `{ scope, filePath: null, content: "" }`, so `filePath` is nullable and an
 * empty `content` is a valid "not created yet" state. Kept in lockstep with
 * packages/engine/src/config/index.ts.
 */
export interface ClaudeMdDoc {
  scope: ConfigScope;
  /** Absolute path of the CLAUDE.md, or null when it doesn't exist yet. */
  filePath: string | null;
  /** Raw markdown contents ("" when the file doesn't exist yet). */
  content: string;
}

/** Response from PUT /api/config/claudemd — the persisted scope + path. */
export interface ClaudeMdWriteResult {
  ok: boolean;
  scope: ConfigScope;
  /** Absolute path of the CLAUDE.md that was written. */
  filePath: string;
}

/**
 * One skill from GET /api/config/skills (a `skills/<dir>/SKILL.md` file with
 * frontmatter). Mirrors the engine's `SkillDef` (config/index.ts); defined
 * locally so the web bundle stays free of the Node-only engine config code.
 * Kept in lockstep with packages/engine/src/config/index.ts.
 */
export interface SkillDef {
  name: string;
  description: string | null;
  /** Version string from frontmatter, if set. */
  version: string | null;
  scope: ConfigScope;
  /** Absolute path to the directory holding SKILL.md. */
  dirPath: string;
  /** Absolute path to the SKILL.md source file (used for the open/copy affordance). */
  filePath: string;
}

/**
 * One subagent definition from GET /api/config/agents (an `agents/*.md` file with
 * frontmatter). Mirrors the engine's `AgentDef` (config/index.ts); defined locally
 * so the web bundle stays free of the Node-only engine config code. Kept in
 * lockstep with packages/engine/src/config/index.ts.
 */
export interface AgentDef {
  name: string;
  description: string | null;
  /** Preferred model alias from frontmatter (e.g. "sonnet"), if set. */
  model: string | null;
  scope: ConfigScope;
  /** Absolute path to the source .md file (used for the open/copy affordance). */
  filePath: string;
}

/**
 * One day's rolled-up token usage + cost + session count, from GET /api/rollups.
 * Mirrors the engine's `DailyUsage` (rollups.ts); defined locally so the web
 * bundle stays free of Node-only engine code. The series is oldest→newest and
 * days with no activity are simply absent (the client zero-/range-fills as needed).
 * Kept in lockstep with packages/engine/src/rollups.ts.
 */
export interface DailyUsage {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** APPROXIMATE summed USD spend for the day (per-session, model-priced). */
  costUsd: number;
  /** Number of sessions whose last activity fell on this day. */
  sessions: number;
}

/**
 * One git worktree from GET /api/git/worktrees. A worktree is a checkout of a
 * branch in its own directory that shares the repo's history — handy for working
 * on two branches at once. The shape is mirrored locally (not imported from the
 * engine root, which bundles Node-only code) to keep the web build server-free,
 * and is intentionally tolerant: the engine/server lane owns the canonical
 * fields; unknown extras are ignored.
 */
export interface Worktree {
  /** Absolute path of the worktree directory. */
  path: string;
  /** Checked-out branch (e.g. "feature/x"), or null when detached. */
  branch: string | null;
  /** Current HEAD commit hash, when reported. */
  head?: string | null;
  /** True for the repo's primary (main) worktree, which can't be removed here. */
  isMain?: boolean;
  /** True when this worktree is bare/locked/prunable (advisory display only). */
  locked?: boolean;
}
