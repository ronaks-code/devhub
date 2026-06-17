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
import type { GitStatus, GitLogEntry } from "./types";

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
  getSettings: () => get<AppSettings>("/api/settings"),
  // PUT merges a partial update server-side and returns the full merged settings.
  putSettings: (patch: Partial<AppSettings>) =>
    send<AppSettings>("/api/settings", "PUT", patch),
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
