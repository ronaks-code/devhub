import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NormalizedMessage } from "../lib/types";

/**
 * True when a message carries an error worth jumping to: a tool_result flagged
 * isError, or a `system` message whose text reads like an error/failure. Kept in
 * lockstep with TranscriptFilters' error notion (tool_result isError), widened
 * to catch standalone system errors that have no tool_result block.
 */
export function messageIsError(m: NormalizedMessage): boolean {
  for (const b of m.blocks) {
    if (b.type === "tool_result" && b.isError === true) return true;
  }
  if (m.role === "system") {
    for (const b of m.blocks) {
      if (b.type === "text" && /\b(error|failed|failure|exception|denied)\b/i.test(b.text)) {
        return true;
      }
    }
  }
  return false;
}

export interface ErrorNav {
  /** Indices (into the passed `messages` list) of every error message, in order. */
  indices: number[];
  /** Total error count (convenience: `indices.length`). */
  count: number;
  /** The error currently focused (1-based for display), or 0 when none focused. */
  position: number;
  /** Jump to the next error (wraps to the first). No-op when there are none. */
  next: () => void;
  /** Jump to the previous error (wraps to the last). No-op when there are none. */
  prev: () => void;
  /** Jump to the first error (used by the "errors only" jump control). */
  first: () => void;
}

/**
 * Collect error messages in the open transcript and drive next/prev navigation
 * over them. The caller supplies the (already paired + filtered) message list so
 * indices line up with what the virtualizer renders, plus a `scrollTo` that
 * scrolls the viewer to a given message index.
 *
 * Keyboard: Alt+E / Alt+Shift+E (or the next/prev controls) step through errors;
 * stepping wraps around. The focused cursor resets whenever the error set
 * changes (e.g. a new session loads or filters change the visible list).
 *
 * `enabled` lets a caller (e.g. a pane with no transcript) cheaply turn the hook
 * and its key listener off without violating the rules of hooks.
 */
export function useErrorNav(
  messages: NormalizedMessage[],
  scrollTo: (index: number) => void,
  enabled = true,
): ErrorNav {
  const indices = useMemo(() => {
    if (!enabled) return [];
    const out: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messageIsError(messages[i]!)) out.push(i);
    }
    return out;
  }, [messages, enabled]);

  // Cursor INTO `indices` (not the message list). -1 = nothing focused yet.
  const [cursor, setCursor] = useState(-1);
  // Read the live cursor synchronously inside the key handler without making the
  // listener depend on it (which would re-bind on every step).
  const cursorRef = useRef(-1);
  cursorRef.current = cursor;

  // Reset focus when the set of errors changes shape (new session / filters).
  useEffect(() => {
    setCursor(-1);
  }, [indices]);

  const go = useCallback(
    (cur: number) => {
      const target = indices[cur];
      if (target == null) return;
      setCursor(cur);
      scrollTo(target);
    },
    [indices, scrollTo],
  );

  const next = useCallback(() => {
    if (indices.length === 0) return;
    const cur = cursorRef.current;
    go(cur < 0 ? 0 : (cur + 1) % indices.length);
  }, [indices.length, go]);

  const prev = useCallback(() => {
    if (indices.length === 0) return;
    const cur = cursorRef.current;
    go(cur < 0 ? indices.length - 1 : (cur - 1 + indices.length) % indices.length);
  }, [indices.length, go]);

  const first = useCallback(() => {
    if (indices.length === 0) return;
    go(0);
  }, [indices.length, go]);

  // Alt+E next, Alt+Shift+E previous. Alt avoids clashing with the ⌘/Ctrl
  // palette + find shortcuts, and isn't a common browser binding.
  useEffect(() => {
    if (!enabled || indices.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key !== "e" && e.key !== "E") return;
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, indices.length, next, prev]);

  return {
    indices,
    count: indices.length,
    position: cursor >= 0 ? cursor + 1 : 0,
    next,
    prev,
    first,
  };
}
