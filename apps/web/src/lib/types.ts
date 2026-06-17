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
} from "@claude-ui/engine/types";

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
