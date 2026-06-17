import { useCallback, useEffect, useState } from "react";

/**
 * A "recently viewed" jump-back list. Tracks the last {@link MAX_RECENTS} sessions
 * the user opened in the Browse transcript, most-recent-first and de-duped by
 * sessionId, persisted in localStorage so it survives reloads. The header's Recent
 * dropdown reads {@link recents} and reopens a session on click via {@link pushRecent}'s
 * stored projectId.
 *
 * Mirrors the SSR-guarded, try/catch storage style used elsewhere (useDraft, the
 * App's UI-state persistence): any storage failure (private mode, quota) degrades
 * to in-memory only.
 */
const STORAGE_KEY = "claude-ui:recent-sessions";

/** How many recents to keep (the oldest beyond this are dropped). */
export const MAX_RECENTS = 12;

/** One opened-session entry, persisted most-recent-first. */
export interface RecentSession {
  sessionId: string;
  /** Title at the time it was opened (falls back to a generic label when blank). */
  title: string;
  /** Project the session belongs to, so a click can reopen it. */
  projectId: string;
  /** Epoch ms the session was last opened (for relative display + recency order). */
  openedAt: number;
}

/** Read + sanity-check the persisted list. Anything malformed degrades to []. */
function read(): RecentSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensively keep only well-formed entries (an older/partial write shouldn't
    // crash the dropdown), capped at MAX_RECENTS.
    return parsed
      .filter(
        (r): r is RecentSession =>
          !!r &&
          typeof r === "object" &&
          typeof (r as RecentSession).sessionId === "string" &&
          typeof (r as RecentSession).projectId === "string",
      )
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function write(list: RecentSession[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable or quota exceeded — non-fatal */
  }
}

export interface UseRecentSessionsResult {
  /** The recent sessions, most-recent-first. */
  recents: RecentSession[];
  /** Record (or bump) a session as just-opened; moves it to the front, de-duped. */
  pushRecent: (entry: { sessionId: string; title: string; projectId: string }) => void;
  /** Forget all recents. */
  clearRecents: () => void;
}

export function useRecentSessions(): UseRecentSessionsResult {
  // Lazy init from storage so the first paint already shows the saved list.
  const [recents, setRecents] = useState<RecentSession[]>(() => read());

  const pushRecent = useCallback(
    (entry: { sessionId: string; title: string; projectId: string }) => {
      if (!entry.sessionId || !entry.projectId) return;
      setRecents((prev) => {
        const next: RecentSession[] = [
          {
            sessionId: entry.sessionId,
            title: entry.title || "(untitled session)",
            projectId: entry.projectId,
            openedAt: Date.now(),
          },
          // Drop any prior entry for the same session so it floats to the front
          // instead of duplicating.
          ...prev.filter((r) => r.sessionId !== entry.sessionId),
        ].slice(0, MAX_RECENTS);
        write(next);
        return next;
      });
    },
    [],
  );

  const clearRecents = useCallback(() => {
    setRecents([]);
    write([]);
  }, []);

  // Keep multiple tabs / mounts roughly in sync: pick up another tab's write.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setRecents(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { recents, pushRecent, clearRecents };
}
