import type { EngineEvent, SearchHit, Stats } from "@claude-ui/engine/types";

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

/**
 * A transient user notification pushed over the /api/events SSE stream. The engine
 * `EngineEvent` union does not (yet) carry this kind, and we can't edit that
 * package — so, like {@link SearchHitWithSeq}, we widen it at the web boundary
 * instead of shimming the engine. Every field beyond `kind` is optional and read
 * defensively, so whatever the engine/server lane ends up emitting still parses.
 *
 * Typical payloads: a session finishing ("Session finished in <project>") or a
 * session blocking on the user ("Session waiting for you").
 */
export interface NotifyEvent {
  kind: "notify";
  /** Short headline (falls back to a generic title when absent). */
  title?: string;
  /** Longer body line. */
  body?: string;
  /** Severity hint for the toast tint; defaults to "info". */
  level?: "info" | "success" | "warning";
  /** When present, the toast/notification deep-links to this session on click. */
  sessionId?: string;
  projectId?: string;
  /** Project name/cwd for a nicer message, when the server includes it. */
  project?: string;
}

/**
 * The events the web app actually subscribes to: the engine's union widened with
 * the web-only {@link NotifyEvent}. Used by the SSE subscriber so a `notify` event
 * type-checks without an engine edit.
 */
export type AppEvent = EngineEvent | NotifyEvent;

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
 * The three permission rule buckets Claude Code enforces (deny wins, then ask,
 * then allow). Mirrors the engine config module's `PermissionsConfig`; defined
 * locally so the web bundle stays free of the Node-only engine config code.
 * Kept in lockstep with packages/engine/src/config/index.ts.
 */
export interface PermissionsConfig {
  allow: string[];
  ask: string[];
  deny: string[];
}

/** Which bucket a rule lives in. */
export type RuleAction = "allow" | "ask" | "deny";

/**
 * Response from GET /api/permissions — the merged allow/ask/deny rules across the
 * settings.json layers, plus the contributing source paths. `scope` is "project"
 * when a project cwd narrowed the read, else "global". Mirrors the server route.
 */
export interface PermissionsResult {
  permissions: PermissionsConfig;
  /** settings.json paths that fed the merged view, lowest precedence first. */
  sources: string[];
  scope: ConfigScope;
}

/**
 * Response from PUT /api/permissions — the rule was added/removed in the USER
 * settings.json (~/.claude/settings.json). `permissions` is that file's three
 * buckets after the write (NOT the merged layered view).
 */
export interface PermissionsWriteResult {
  ok: boolean;
  /** Absolute path of the settings.json that was written. */
  file: string;
  permissions: PermissionsConfig;
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
 * One installed Claude Code plugin from GET /api/config/plugins, read from
 * ~/.claude/plugins/installed_plugins.json. Mirrors the engine config module's
 * `PluginDef`; defined locally so the web bundle stays free of the Node-only
 * engine config code. The shape is intentionally tolerant — the engine/server
 * lane owns the canonical fields; unknown extras are ignored, and most fields are
 * optional so older/sparser manifests still render. Kept in lockstep with
 * packages/engine/src/config/index.ts.
 */
export interface PluginDef {
  /** Plugin name/id as written in the manifest. */
  name: string;
  /** Version string from the manifest, if present. */
  version: string | null;
  /** Marketplace the plugin was installed from (e.g. "anthropic"), if known. */
  marketplace: string | null;
  /** Whether the plugin is currently enabled. */
  enabled: boolean;
  /** Where the install lives — global (~/.claude) vs. a project. */
  scope: ConfigScope;
  /** Short description from the manifest, if any. */
  description?: string | null;
}

/**
 * One configured plugin marketplace from GET /api/config/plugins, read from
 * ~/.claude/plugins/known_marketplaces.json. Defined locally to keep the web
 * bundle server-free; tolerant of extra fields. Kept in lockstep with
 * packages/engine/src/config/index.ts.
 */
export interface MarketplaceDef {
  /** Marketplace name/id. */
  name: string;
  /** Source URL / git remote / local path the marketplace resolves from, if known. */
  url?: string | null;
  /** Whether this marketplace is currently enabled/trusted. */
  enabled?: boolean;
}

/**
 * Response from GET /api/config/plugins — the installed plugins plus the known
 * marketplaces. Mirrors the engine config module's read of
 * ~/.claude/plugins/{installed_plugins,known_marketplaces}.json. Defined locally
 * so the web bundle stays free of Node-only engine code.
 */
export interface PluginsResult {
  plugins: PluginDef[];
  marketplaces: MarketplaceDef[];
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
