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
