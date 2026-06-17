import type {
  AppEvent,
  ProjectSummary,
  RunningSession,
  SessionMessagesPage,
  SessionSummary,
  Stats,
  NormalizedMessage,
} from "./types";
import type { AppSettings } from "@claude-ui/engine/types";
// Git result shapes. Mirrored locally (not imported from the engine root, which
// pulls in Node-only code) so the web bundle stays free of server deps. Kept in
// lockstep with packages/engine/src/git.ts.
import type {
  GitStatus,
  GitLogEntry,
  GitDiff,
  GitBranch,
  ConfigScope,
  McpServerDef,
  McpServerInput,
  HooksConfig,
  HooksInput,
  AgentDef,
  SkillDef,
  PluginsResult,
  DailyUsage,
  Worktree,
  ClaudeMdDoc,
  ClaudeMdWriteResult,
  PermissionsResult,
  PermissionsWriteResult,
  RuleAction,
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

/**
 * Raised when an endpoint isn't implemented by the running server (HTTP 404 or
 * 501). The worktree routes are wired here ahead of the engine/server lane that
 * implements them — exactly like /api/rollups was. Callers (WorktreePanel) catch
 * this to show a graceful "not available on this server yet" state instead of a
 * hard error, so the UI never breaks when the backend hasn't shipped the route.
 */
export class NotImplementedError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`${status} for ${url} (endpoint not available)`);
    this.name = "NotImplementedError";
    this.status = status;
  }
}

/** GET that maps a 404/501 to {@link NotImplementedError} (other errors still throw). */
async function getMaybe<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404 || res.status === 501) throw new NotImplementedError(res.status, url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

/** Mutating request that maps a 404/501 to {@link NotImplementedError}. */
async function sendMaybe<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (res.status === 404 || res.status === 501) throw new NotImplementedError(res.status, url);
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

/**
 * Response from the remote git operations (POST /api/git/fetch|pull|push).
 * Mirrors the engine's GitWriteResult: `ok` reports success, `stdout` carries
 * git's (trimmed) output to show in the result line, and `error` is the failure
 * reason (e.g. "no upstream branch", "non-fast-forward") when `ok` is false.
 * Kept in lockstep with packages/engine/src/git.ts.
 */
export interface GitRemoteResult {
  ok: boolean;
  /** Trimmed git stdout (may be empty — e.g. "Already up to date."). */
  stdout: string;
  /** Failure reason when `ok` is false; empty on success. */
  error: string;
}

/** Response shape for an MCP write (PUT/DELETE) — the server echoes the target. */
export interface McpWriteResult {
  ok: boolean;
  name: string;
  scope: ConfigScope;
  /** Present on PUT (the persisted server entry); absent on DELETE. */
  server?: Record<string, unknown>;
}

/** Response shape for a hooks write (PUT /api/config/hooks). */
export interface HooksWriteResult {
  ok: boolean;
  scope: ConfigScope;
  /** Path of the settings.json that was written. */
  file?: string;
  /** The hooks map as persisted (echoed back by the server). */
  hooks?: Record<string, unknown[]>;
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

  /**
   * The merged hooks map + contributing settings.json paths. With a (known)
   * project `cwd` the global+project layers are merged; without one it's the
   * global layer only. Backed by GET /api/config/hooks.
   */
  getHooks: (cwd?: string) =>
    get<HooksConfig>(
      "/api/config/hooks" + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""),
    ),

  /**
   * Replace the hooks map at the given scope via PUT /api/config/hooks. The
   * server requires an explicit `scope`; project scope also needs the project
   * `cwd` (validated server-side against known projects). Writes go through the
   * server's safe-write (validate -> .bak backup -> atomic write to the scoped
   * settings.json); the web side only wires the call.
   */
  putHooks: (scope: ConfigScope, input: HooksInput, cwd?: string) =>
    send<HooksWriteResult>("/api/config/hooks", "PUT", {
      scope,
      hooks: input.hooks,
      ...(scope === "project" && cwd ? { cwd } : {}),
    }),

  /**
   * Subagents: the global set, plus (when a known project `cwd` is given) that
   * project's. Backed by the read-only GET /api/config/agents (engine
   * `listAgents`). The web side only wires the call; discovery/parsing of the
   * `agents/*.md` files lives in the engine.
   */
  agents: (cwd?: string) =>
    get<AgentDef[]>(
      "/api/config/agents" + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""),
    ),

  /**
   * Skills: the global set, plus (when a known project `cwd` is given) that
   * project's. Backed by the read-only GET /api/config/skills (engine
   * `listSkills`). The web side only wires the call; discovery/parsing of the
   * `skills/<dir>/SKILL.md` files (name/description/version frontmatter) lives in
   * the engine.
   */
  skills: (cwd?: string) =>
    get<SkillDef[]>(
      "/api/config/skills" + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""),
    ),

  /**
   * Installed plugins + known marketplaces, read from ~/.claude/plugins/
   * (installed_plugins.json + known_marketplaces.json). Backed by the read-only
   * GET /api/config/plugins (engine `listPlugins`); the web side only wires the
   * call. Until the engine/server lane ships the route, the *Maybe helper
   * surfaces a NotImplementedError so PluginsView shows a graceful "not available
   * on this server yet" state instead of a hard error.
   */
  plugins: () => getMaybe<PluginsResult>("/api/config/plugins"),

  /**
   * Read a CLAUDE.md. Global scope reads ~/.claude/CLAUDE.md; with `scope:
   * "project"` and a (known) project `cwd` it reads <cwd>/CLAUDE.md. The server
   * returns `{ scope, filePath: null, content: "" }` when the file doesn't exist
   * yet, so callers treat an empty doc as a "create it" starting point. Backed by
   * GET /api/config/claudemd.
   */
  getClaudeMd: (scope: ConfigScope = "global", cwd?: string) =>
    get<ClaudeMdDoc>(
      "/api/config/claudemd" +
        ((): string => {
          const qs = new URLSearchParams();
          qs.set("scope", scope);
          if (scope === "project" && cwd) qs.set("cwd", cwd);
          return `?${qs.toString()}`;
        })(),
    ),

  /**
   * Write a CLAUDE.md via PUT /api/config/claudemd. Global scope writes
   * ~/.claude/CLAUDE.md; project scope writes <cwd>/CLAUDE.md (cwd validated
   * server-side against known projects). The server does the safe write
   * (.bak backup -> atomic write); the web side only POSTs the new contents.
   */
  putClaudeMd: (scope: ConfigScope, content: string, cwd?: string) =>
    send<ClaudeMdWriteResult>("/api/config/claudemd", "PUT", {
      scope,
      content,
      ...(scope === "project" && cwd ? { cwd } : {}),
    }),
};

export const api = {
  health: () => get<Health>("/api/health"),
  // Projects. ProjectSummary carries the per-project chat defaults
  // (defaultModel/defaultPermissionMode), null when the user hasn't set them.
  projects: () => get<ProjectSummary[]>("/api/projects"),
  // Patch a project's UI/meta. Forwards only the present keys (the server's
  // PATCH /api/projects/:id applies a partial patch). Used to persist the
  // per-project chat defaults from the ChatPane header. Returns the raw server
  // ack ({ ok, id, meta }); callers re-fetch projects to pick up the change.
  patchProject: (
    id: string,
    patch: {
      defaultModel?: string | null;
      defaultPermissionMode?: string | null;
      favorite?: boolean;
      archived?: boolean;
      sortOrder?: number;
      color?: string | null;
    },
  ) => send<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, "PATCH", patch),
  sessions: (projectId: string) =>
    get<SessionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  // Cross-project session listing (GET /api/all-sessions). Sorts server-side by
  // recent | tokens | messages (NOT cost — cost isn't a stored column), with
  // optional facet narrowing + paging. Backs the dashboard's TopSpenders, which
  // fetches by `tokens` and re-ranks by estimated cost client-side.
  allSessions: (opts: {
    sort?: "recent" | "tokens" | "messages";
    projectId?: string;
    tag?: string;
    model?: string;
    limit?: number;
    offset?: number;
  } = {}) =>
    get<SessionSummary[]>(
      "/api/all-sessions" +
        ((): string => {
          const qs = new URLSearchParams();
          if (opts.sort) qs.set("sort", opts.sort);
          if (opts.projectId) qs.set("projectId", opts.projectId);
          if (opts.tag) qs.set("tag", opts.tag);
          if (opts.model) qs.set("model", opts.model);
          if (opts.limit != null) qs.set("limit", String(opts.limit));
          if (opts.offset != null) qs.set("offset", String(opts.offset));
          const s = qs.toString();
          return s ? `?${s}` : "";
        })(),
    ),
  messages: (sessionId: string, tailBytes?: number) =>
    get<SessionMessagesPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages` +
        (tailBytes ? `?tailBytes=${tailBytes}` : ""),
    ),
  // Read a single subagent transcript by its on-disk path (the SubagentRef
  // `filePath` from a SessionMessagesPage). The server allowlists the path to
  // ~/.claude/projects and only reads .jsonl files; the web side only wires the
  // call. Backs the TaskCard's inline subagent-transcript expander.
  subagentMessages: (sessionId: string, filePath: string) =>
    get<NormalizedMessage[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/subagent?path=${encodeURIComponent(filePath)}`,
    ),
  rename: (sessionId: string, customTitle: string | null) =>
    send<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
      customTitle,
    }),
  setPinned: (sessionId: string, pinned: boolean) =>
    send<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
      pinned,
    }),
  // Replace a session's tag set (normalized server-side: trim/lower/de-dupe).
  // Backs the SessionsPane bulk "tag" action; the PATCH route accepts `tags`.
  setTags: (sessionId: string, tags: string[]) =>
    send<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
      tags,
    }),
  // Toggle a session's archived flag via PATCH /api/sessions/:id { archived }.
  // Backs the InboxPane "archive" triage action. The PATCH forwards present keys,
  // so a server that doesn't persist `archived` still ACKs harmlessly.
  setArchived: (sessionId: string, archived: boolean) =>
    send<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
      archived,
    }),
  // Save freeform markdown notes on a session via PATCH /api/sessions/:id { notes }.
  // Backs the SessionNotes editor. The route's `notes` body field is a plain
  // string (the schema rejects null), so clearing notes sends "" — never null.
  // The PATCH forwards present keys, so a server that doesn't persist `notes`
  // still ACKs harmlessly.
  setNotes: (sessionId: string, notes: string) =>
    send<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
      notes,
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
  // Unified working-tree diff. With `file`, diffs just that path; without it,
  // the whole tree. null when `cwd` is not a git repo (or the diff is over-cap).
  gitDiff: (cwd: string, file?: string) =>
    get<GitDiff | null>(
      `/api/git/diff?cwd=${encodeURIComponent(cwd)}` +
        (file ? `&file=${encodeURIComponent(file)}` : ""),
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
  // The repo's local branches (current flagged). [] when `cwd` is not a git repo.
  // Backs the BranchSwitcher dropdown near the chat header.
  gitBranches: (cwd: string) =>
    get<GitBranch[]>(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`),
  // Switch to (or create + switch to) a branch. `checkout` checks out the
  // branch; combined with `name` of a NEW branch the server creates it first
  // (git branch + checkout). The server returns the refreshed branch list, so
  // the switcher updates from the response without a separate re-fetch.
  gitBranch: (cwd: string, name: string, checkout = true) =>
    send<GitBranch[]>("/api/git/branch", "POST", { cwd, name, checkout }),
  // Remote sync for a project `cwd`, allowlisted server-side like the other git
  // routes. Fetch updates remote-tracking refs (no working-tree change), pull
  // fast-forwards/merges the upstream into the current branch, and push uploads
  // local commits. These call POST /api/git/fetch|pull|push; until the
  // engine/server lane ships them, the *Maybe helper surfaces a
  // NotImplementedError so GitSync shows a graceful "not available yet" state
  // instead of erroring — exactly like the worktree routes were wired.
  gitFetch: (cwd: string) =>
    sendMaybe<GitRemoteResult>("/api/git/fetch", "POST", { cwd }),
  gitPull: (cwd: string) =>
    sendMaybe<GitRemoteResult>("/api/git/pull", "POST", { cwd }),
  gitPush: (cwd: string) =>
    sendMaybe<GitRemoteResult>("/api/git/push", "POST", { cwd }),
  // Per-day token/cost/session time series for a usage window. `since`/`until`
  // are inclusive `YYYY-MM-DD` dates; omit both for the full history. Backed by
  // GET /api/rollups (engine `dailyUsage`). The PeriodSelector sums the in-range
  // days client-side for period totals — no engine change needed.
  rollups: (since?: string, until?: string, projectId?: string) =>
    get<DailyUsage[]>(
      "/api/rollups" +
        ((): string => {
          const qs = new URLSearchParams();
          if (since) qs.set("since", since);
          if (until) qs.set("until", until);
          if (projectId) qs.set("projectId", projectId);
          const s = qs.toString();
          return s ? `?${s}` : "";
        })(),
    ),
  // Git worktree management for a project `cwd`, allowlisted server-side like the
  // other git routes. These call the /api/git/worktree(s) endpoints; until the
  // engine/server lane ships them, the *Maybe helpers surface a
  // NotImplementedError so the panel degrades gracefully instead of erroring.
  gitWorktrees: (cwd: string) =>
    getMaybe<Worktree[]>(`/api/git/worktrees?cwd=${encodeURIComponent(cwd)}`),
  // Create a new worktree checking out `branch` at `path` (relative paths are
  // resolved against the repo server-side). `newBranch` asks git to create the
  // branch as part of the add.
  gitWorktreeAdd: (
    cwd: string,
    path: string,
    branch: string,
    newBranch = false,
  ) =>
    sendMaybe<Worktree>("/api/git/worktree", "POST", {
      cwd,
      path,
      branch,
      newBranch,
    }),
  // Remove a worktree by its directory path. `force` drops it even with
  // uncommitted changes (the panel confirms before calling, and only offers
  // force on a second confirm).
  gitWorktreeRemove: (cwd: string, path: string, force = false) =>
    sendMaybe<{ ok: boolean }>("/api/git/worktree", "DELETE", {
      cwd,
      path,
      force,
    }),
  // Open a project location on the machine running the server: a file in the
  // user's editor (target "editor"), or the project root in the OS file
  // explorer / a terminal (target "finder" | "terminal"). The server allowlists
  // `cwd` to known project roots and (for "editor") `file` within that cwd, then
  // shells out to the configured opener; the web side only POSTs the intent.
  // Backs the OpenInEditor button on file paths. Until the engine/server lane
  // ships POST /api/open, the *Maybe helper surfaces a NotImplementedError so the
  // button degrades to a quiet "unavailable" state instead of erroring.
  open: (cwd: string, file?: string, target: "editor" | "finder" | "terminal" = "editor") =>
    sendMaybe<{ ok: boolean }>("/api/open", "POST", { cwd, target, ...(file ? { file } : {}) }),
  getSettings: () => get<AppSettings>("/api/settings"),
  // PUT merges a partial update server-side and returns the full merged settings.
  putSettings: (patch: Partial<AppSettings>) =>
    send<AppSettings>("/api/settings", "PUT", patch),
  // The merged allow/ask/deny permission rules across the settings.json layers
  // (+ the contributing source paths). A known project `cwd` adds that project's
  // layers; without one it's the global layer only. Backs the PermissionsEditor.
  getPermissions: (cwd?: string) =>
    get<PermissionsResult>(
      "/api/permissions" + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""),
    ),
  // Add or remove ONE rule in a bucket, persisted to the USER settings.json
  // (~/.claude/settings.json) via the server's safe-write (validate -> .bak -> atomic).
  // Returns that file's three buckets after the write. The web side only wires the call.
  putPermissionRule: (action: RuleAction, rule: string, op: "add" | "remove") =>
    send<PermissionsWriteResult>("/api/permissions", "PUT", { action, rule, op }),
  // Fuzzy file lookup within a project cwd, backing the composer's "@" mention
  // picker. The server allowlists `cwd` to known project roots (so an arbitrary
  // path can't be enumerated) and ranks matches for `q` server-side. The web
  // side only wires the call; an empty `q` asks for an initial/top set.
  listFiles: (cwd: string, q = "", limit = 30) =>
    get<FileEntry[]>(
      `/api/files?cwd=${encodeURIComponent(cwd)}` +
        (q ? `&q=${encodeURIComponent(q)}` : "") +
        (limit ? `&limit=${limit}` : ""),
    ),
  // Upload an image attachment. The browser can't write the user's filesystem, so
  // the composer sends the image as base64 JSON; the server decodes it, validates
  // type + size, writes it under ~/.claude-ui/attachments/, and returns the on-disk
  // path (which the composer inserts as an @-reference for the CLI to read) plus a
  // preview `url` via the read-only assets endpoint. The web side only wires the
  // call — if the server hasn't shipped POST /api/attachments, the *Maybe helper
  // surfaces a NotImplementedError so the composer degrades to a clear "not
  // available here" message instead of erroring. Body matches the server schema
  // exactly ({ filename, dataBase64 }) — it rejects unknown properties.
  uploadAttachment: (input: AttachmentUpload) =>
    sendMaybe<AttachmentResult>("/api/attachments", "POST", input),
  // MCP-server config management (list/upsert/remove across scopes).
  config,
};

/**
 * One file match from GET /api/files. `path` is the project-relative path the
 * mention picker inserts; `name` (when present) is just the basename for display.
 * The server may return either richer objects or bare path strings, so the
 * picker normalizes both — this is the rich shape.
 */
export interface FileEntry {
  /** Project-relative path (what gets inserted into the composer). */
  path: string;
  /** Basename for display; falls back to `path` when absent. */
  name?: string;
  /** True when the entry is a directory (rendered with a trailing "/"). */
  dir?: boolean;
}

/**
 * Payload for POST /api/attachments: an image to persist so the CLI can read it
 * from disk. Matches the server schema EXACTLY — it sets `additionalProperties:
 * false`, so only these two fields are accepted (anything else → 400). The server
 * derives the stored extension from `filename`, re-stamps a random basename, and
 * enforces a type allowlist + a 10MB decoded-size cap.
 */
export interface AttachmentUpload {
  /** Suggested filename (e.g. "pasted-image.png"); only its EXTENSION is honored. */
  filename: string;
  /** Base64-encoded image bytes; a `data:...;base64,` prefix is stripped server-side. */
  dataBase64: string;
}

/**
 * Response from POST /api/attachments — the saved file's on-disk `path` (what the
 * composer inserts as an `@`-reference so the CLI reads the file) plus a `url`
 * pointing at the read-only assets endpoint for an inline image preview.
 */
export interface AttachmentResult {
  ok: boolean;
  /** Absolute on-disk path of the saved attachment. */
  path: string;
  /** Preview URL via GET /api/assets (only images are served inline). */
  url: string;
  /** Decoded byte size of the stored file. */
  size: number;
}

/**
 * Build the URL for an on-disk asset (e.g. an image referenced by a transcript
 * block) served by GET /api/assets?path=. The path is allowlisted server-side
 * against known project cwds; the web side only forms the URL. Used by ImageBlock
 * as a plain <img src>, so the browser does the fetch (and caching) directly.
 */
export function assetUrl(path: string): string {
  return `/api/assets?path=${encodeURIComponent(path)}`;
}

export type { AppSettings };

/**
 * Subscribe to server-sent engine events. Returns an unsubscribe fn. The callback
 * receives the engine union widened with the web-only `notify` event ({@link AppEvent}),
 * so toast handling type-checks without an engine edit; unknown kinds are simply ignored.
 */
export function subscribeEvents(onEvent: (e: AppEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as AppEvent);
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    /* EventSource auto-reconnects */
  };
  return () => es.close();
}
