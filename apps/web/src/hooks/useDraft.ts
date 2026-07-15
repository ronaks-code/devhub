import { useCallback, useEffect, useRef, useState } from "react";
import { readCompat, removeCompat, writeCompat } from "../lib/compat-storage";

/**
 * Per-conversation composer draft, persisted in localStorage so an unsent
 * message survives tab switches and reloads. The storage key is scoped by
 * (projectId | sessionId): switching project or resuming a different session
 * loads that conversation's own draft, and starting a brand-new chat (no
 * sessionId yet) keeps a per-project scratch draft.
 *
 * Mirrors the SSR-guarded, try/catch storage style used elsewhere in the app:
 * any storage failure (private mode, quota) degrades to in-memory only.
 */
const PREFIX = "devhub:draft:";

function keyFor(projectId: string | null | undefined, sessionId: string | null | undefined): string {
  return `${PREFIX}${projectId ?? "_"}|${sessionId ?? "_"}`;
}

function read(key: string): string {
  return readCompat(key) ?? "";
}

function write(key: string, value: string): void {
  // Empty drafts are removed rather than stored so the table stays tidy. Removal
  // clears the legacy twin too so an emptied draft can't be resurrected.
  if (value) writeCompat(key, value);
  else removeCompat(key);
}

export interface UseDraftResult {
  /** Current draft text for the active (projectId|sessionId) scope. */
  draft: string;
  /** Update the draft; persists to localStorage under the scoped key. */
  setDraft: (value: string) => void;
  /** Clear the draft (e.g. after a successful send). */
  clearDraft: () => void;
}

export function useDraft(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
): UseDraftResult {
  const key = keyFor(projectId, sessionId);
  const keyRef = useRef(key);

  // Lazy init from storage so the first paint already shows the saved draft.
  const [draft, setDraftState] = useState<string>(() => read(key));

  // When the scope changes (project switch / session resume), swap to that
  // conversation's stored draft. Guard against re-running for the same key.
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setDraftState(read(key));
  }, [key]);

  const setDraft = useCallback(
    (value: string) => {
      setDraftState(value);
      write(keyRef.current, value);
    },
    [],
  );

  const clearDraft = useCallback(() => {
    setDraftState("");
    write(keyRef.current, "");
  }, []);

  return { draft, setDraft, clearDraft };
}
