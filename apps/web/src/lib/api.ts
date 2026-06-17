import type {
  EngineEvent,
  ProjectSummary,
  RunningSession,
  SessionMessagesPage,
  SessionSummary,
  Stats,
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
};

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
