import type {
  EngineEvent,
  ProjectSummary,
  RunningSession,
  SessionMessagesPage,
  SessionSummary,
  Stats,
} from "./types";
import type { AppSettings } from "@claude-ui/engine/types";
// Git result shapes. Mirrored locally (not imported from the engine root, which
// pulls in Node-only code) so the web bundle stays free of server deps. Kept in
// lockstep with packages/engine/src/git.ts.
import type {
  GitStatus,
  GitLogEntry,
  ConfigScope,
  McpServerDef,
  McpServerInput,
} from "./types";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

export interface Health {
  ok: boolean;
  ready: boolean;
  sessionCount: number;
}

/** Response from POST /api/git/suggest-message — an AI-drafted commit message. */
export interface GitSuggestResult {
  message: string;
}

/**
 * Response from POST /api/git/commit. Mirrors the engine's GitCommitResult
 * (GitWriteResult + hash): `ok` reports success, `error` carries the reason on
 * failure (e.g. "nothing to commit"), and `hash` is the new HEAD (null when no
 * commit was made). Kept in lockstep with packages/engine/src/git.ts.
 */
export interface GitCommitResult {
  ok: boolean;
  /** Trimmed git stdout (may be empty). */
  stdout: string;
  /** Failure reason when `ok` is false; empty on success. */
  error: string;
  /** New HEAD hash on success, null when the commit didn't happen. */
  hash: string | null;
}

/** Response shape for an MCP write (PUT/DELETE) — the server echoes the target. */
export interface McpWriteResult {
  ok: boolean;
  name: string;
  scope: ConfigScope;
  /** Present on PUT (the persisted server entry); absent on DELETE. */
  server?: Record<string, unknown>;
}

/**
 * Helpers over the MCP-server config REST surface (served by the server package
 * from the engine config module). The web side only wires the HTTP calls —
 * validation + safe backup/atomic writes live in the engine/server.
 *
 * Scope is implied by `cwd`: with a (known) project `cwd` the write targets that
 * project's `projects[<cwd>].mcpServers`; without one it targets the top-level
 * (global) `mcpServers` map in ~/.claude.json. Writes echo the target rather
 * than the full list, so callers re-fetch via {@link mcpList} after a change.
 */
const config = {
  /** All configured MCP servers: global + (when `cwd` given) that project's. */
  mcpList: (cwd?: string) =>
    get<McpServerDef[]>(
      "/api/config/mcp" + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""),
    ),
  /** Upsert one MCP server. A known project `cwd` writes project scope; else global. */
  mcpSet: (name: string, server: McpServerInput, cwd?: string) =>
    send<McpWriteResult>("/api/config/mcp", "PUT", { name, server, cwd }),
  /** Remove a named MCP server. Scope follows `cwd` (project) or none (global). */
  mcpDelete: (name: string, cwd?: string) =>
    send<McpWriteResult>("/api/config/mcp", "DELETE", { name, cwd }),
};

export const api = {
  health: () => get<Health>("/api/health"),
  projects: () => get<ProjectSummary[]>("/api/projects"),
  sessions: (projectId: string) =>
    get<SessionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  messages: (sessionId: string, tailBytes?: number) =>
    get<SessionMessagesPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages` +
        (tailBytes ? `?tailBytes=${tailBytes}` : ""),
    ),
  rename: (sessionId: string, customTitle: string | null) =>
    send<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
      customTitle,
    }),
  setPinned: (sessionId: string, pinned: boolean) =>
    send<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
      pinned,
    }),
  stats: () => get<Stats>("/api/stats"),
  running: () => get<RunningSession[]>("/api/running"),
  // Read-only git status for a project cwd. The server returns null when the
  // directory is not a git repo (or git is unavailable); rejects unknown cwds.
  gitStatus: (cwd: string) =>
    get<GitStatus | null>(`/api/git/status?cwd=${encodeURIComponent(cwd)}`),
  // Recent commits (newest first), capped server-side. [] when not a repo.
  gitLog: (cwd: string, limit?: number) =>
    get<GitLogEntry[]>(
      `/api/git/log?cwd=${encodeURIComponent(cwd)}` + (limit ? `&limit=${limit}` : ""),
    ),
  // Ask the server to draft a commit message for the working tree's changes.
  // The server (via GitService) reads the staged/unstaged diff; the web side only
  // wires the call. The cwd is allowlisted server-side like the read-only routes.
  gitSuggestMessage: (cwd: string) =>
    send<GitSuggestResult>("/api/git/suggest-message", "POST", { cwd }),
  // Commit the working tree. `all:true` stages tracked changes first (git add -u
  // semantics), matching the composer's "Commit" affordance. Writes go through
  // GitService server-side; the web side only POSTs the intent.
  gitCommit: (cwd: string, message: string, all = true) =>
    send<GitCommitResult>("/api/git/commit", "POST", { cwd, message, all }),
  getSettings: () => get<AppSettings>("/api/settings"),
  // PUT merges a partial update server-side and returns the full merged settings.
  putSettings: (patch: Partial<AppSettings>) =>
    send<AppSettings>("/api/settings", "PUT", patch),
  // MCP-server config management (list/upsert/remove across scopes).
  config,
};

export type { AppSettings };

/** Subscribe to server-sent engine events. Returns an unsubscribe fn. */
export function subscribeEvents(onEvent: (e: EngineEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as EngineEvent);
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    /* EventSource auto-reconnects */
  };
  return () => es.close();
}
