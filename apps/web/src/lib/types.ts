import type { SearchHit } from "@claude-ui/engine/types";

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
