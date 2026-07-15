import { useCallback, useEffect, useRef, useState } from "react";
import { readCompat, removeCompat, writeCompat } from "../lib/compat-storage";

/**
 * Shell-style prompt recall for the chat composer. Sent prompts are pushed onto a
 * per-project history that survives reloads (localStorage), and Up/Down arrow walk
 * it newest→oldest the way a terminal does.
 *
 * Navigation model (mirrors bash/readline):
 *  - cursor === null  → "live" line (whatever the user is currently typing).
 *  - Up    → step toward older entries (cursor grows); clamps at the oldest.
 *  - Down  → step toward newer entries; stepping past the newest returns to the
 *            live line and restores the draft we stashed when navigation began.
 *
 * Arrow keys only navigate when the caret can't move within the textarea (caret at
 * the very start for Up, at the very end for Down) so multi-line editing still works
 * — that gating lives in the consumer; this hook just exposes recall/next/reset.
 *
 * Storage is SSR-guarded and try/catch'd (private mode / quota) → degrades to
 * in-memory, matching useDraft's style. Scoped per project id.
 */
const PREFIX = "devhub:prompt-history:";
const MAX_ENTRIES = 100;

function keyFor(projectId: string | null | undefined): string {
  return `${PREFIX}${projectId ?? "_"}`;
}

function read(key: string): string[] {
  try {
    const raw = readCompat(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, value: string[]): void {
  if (value.length > 0) writeCompat(key, JSON.stringify(value));
  else removeCompat(key);
}

export interface UsePromptHistoryResult {
  /** Record a freshly sent prompt at the head of history (dedupes the immediate repeat). */
  add: (prompt: string) => void;
  /**
   * Move toward older entries. `current` is the live composer text, stashed on the
   * first step so Down can restore it. Returns the text to show, or null = no change.
   */
  recallPrev: (current: string) => string | null;
  /** Move toward newer entries; returns the live line when stepping past the newest. */
  recallNext: () => string | null;
  /** Abandon navigation (e.g. after a send or an edit), back to the live line. */
  reset: () => void;
  /** True while walking history (not on the live line). */
  navigating: boolean;
}

export function usePromptHistory(
  projectId: string | null | undefined,
): UsePromptHistoryResult {
  const key = keyFor(projectId);
  const keyRef = useRef(key);
  // history[0] is the NEWEST prompt (so cursor = index directly maps to "steps back").
  const historyRef = useRef<string[]>(read(key));
  // null = live line; otherwise an index into historyRef.
  const cursorRef = useRef<number | null>(null);
  // The user's in-progress text, stashed when navigation begins so Down can restore it.
  const stashRef = useRef<string>("");
  const [navigating, setNavigating] = useState(false);

  // Reload history when the project scope changes.
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    historyRef.current = read(key);
    cursorRef.current = null;
    stashRef.current = "";
    setNavigating(false);
  }, [key]);

  const add = useCallback((prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const prev = historyRef.current;
    // Drop an immediate duplicate of the newest entry to avoid run-on repeats.
    const next = prev[0] === trimmed ? prev.slice() : [trimmed, ...prev];
    if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES;
    historyRef.current = next;
    write(keyRef.current, next);
    // A send always returns to the live line.
    cursorRef.current = null;
    stashRef.current = "";
    setNavigating(false);
  }, []);

  const recallPrev = useCallback((current: string): string | null => {
    const hist = historyRef.current;
    if (hist.length === 0) return null;
    if (cursorRef.current === null) {
      // Entering history: stash the live line, jump to the newest entry.
      stashRef.current = current;
      cursorRef.current = 0;
      setNavigating(true);
      return hist[0] ?? null;
    }
    const next = Math.min(cursorRef.current + 1, hist.length - 1);
    if (next === cursorRef.current) return null; // already at the oldest
    cursorRef.current = next;
    return hist[next] ?? null;
  }, []);

  const recallNext = useCallback((): string | null => {
    if (cursorRef.current === null) return null; // already live
    const hist = historyRef.current;
    if (cursorRef.current === 0) {
      // Stepping past the newest entry → restore the stashed live line.
      cursorRef.current = null;
      setNavigating(false);
      const live = stashRef.current;
      stashRef.current = "";
      return live;
    }
    const next = cursorRef.current - 1;
    cursorRef.current = next;
    return hist[next] ?? null;
  }, []);

  const reset = useCallback(() => {
    cursorRef.current = null;
    stashRef.current = "";
    setNavigating(false);
  }, []);

  return { add, recallPrev, recallNext, reset, navigating };
}
