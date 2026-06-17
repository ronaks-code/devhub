import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PendingPermission, PermissionDecision } from "../components/PermissionCard";

/**
 * Keyboard-driven approvals for the live chat.
 *
 * Plain words: when Claude pauses to ask "can I run this tool?", you shouldn't
 * have to grab the mouse. This hook lets you keep your hands on the keyboard:
 *   A → allow once     D → deny
 *   S → allow for the rest of this session     E → edit (focus the editable input)
 * It also keeps a tiny QUEUE: if more than one request is waiting, J/K (or the
 * arrow keys) step between them, and answering one auto-advances to the next.
 *
 * The hook owns the queue so ChatPane just feeds requests in (enqueue) and the
 * component renders whichever one is `active`. Decisions are forwarded back out
 * via the `respond` callback the host provides (which sends the WS frame).
 */

export interface ApprovalKeyboardOptions {
  /** Forward a decision to the server (ChatPane.respondPermission). */
  respond: (id: string, decision: PermissionDecision) => void;
  /**
   * Asked to "edit" the active request (E key / edit action). The host scrolls
   * to / focuses the EditableApproval input. Optional — omit to drop the E binding.
   */
  onEdit?: (id: string) => void;
  /**
   * When false, the global key bindings are not installed (e.g. a modal/composer
   * has focus and should own typing). The queue still works programmatically.
   */
  enabled?: boolean;
}

export interface ApprovalKeyboard {
  /** Every queued request, oldest first. */
  queue: PendingPermission[];
  /** The request currently shown/targeted by the key bindings, or null when empty. */
  active: PendingPermission | null;
  /** 0-based index of `active` within `queue` (−1 when empty). */
  activeIndex: number;
  /** Add a request to the queue (de-duped by id). Becomes active if none was. */
  enqueue: (req: PendingPermission) => void;
  /** Drop a request by id (e.g. it was answered out-of-band or the turn ended). */
  remove: (id: string) => void;
  /** Clear the whole queue (turn ended / new turn). */
  clear: () => void;
  /** Move the active cursor to the next / previous queued request (wraps). */
  next: () => void;
  prev: () => void;
  /** Answer the ACTIVE request with the given decision (then auto-advance). */
  decide: (decision: PermissionDecision) => void;
}

/** The verdict a single keypress maps to (allow scope, or deny). */
type KeyVerdict =
  | { decision: "allow"; scope: "once" | "session" }
  | { decision: "deny"; scope: "once" };

const KEY_MAP: Record<string, KeyVerdict> = {
  a: { decision: "allow", scope: "once" },
  d: { decision: "deny", scope: "once" },
  s: { decision: "allow", scope: "session" },
};

export function useApprovalKeyboard(options: ApprovalKeyboardOptions): ApprovalKeyboard {
  const { respond, onEdit, enabled = true } = options;
  const [queue, setQueue] = useState<PendingPermission[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Keep the active index in range as the queue grows/shrinks.
  useEffect(() => {
    setActiveIndex((i) => {
      if (queue.length === 0) return 0;
      return Math.min(i, queue.length - 1);
    });
  }, [queue.length]);

  const active = queue[activeIndex] ?? null;

  const enqueue = useCallback((req: PendingPermission) => {
    setQueue((prev) => (prev.some((r) => r.id === req.id) ? prev : [...prev, req]));
  }, []);

  const remove = useCallback((id: string) => {
    setQueue((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const clear = useCallback(() => {
    setQueue([]);
    setActiveIndex(0);
  }, []);

  const next = useCallback(() => {
    setActiveIndex((i) => (queue.length === 0 ? 0 : (i + 1) % queue.length));
  }, [queue.length]);

  const prev = useCallback(() => {
    setActiveIndex((i) => (queue.length === 0 ? 0 : (i - 1 + queue.length) % queue.length));
  }, [queue.length]);

  const decide = useCallback(
    (decision: PermissionDecision) => {
      const target = queue[activeIndex];
      if (!target) return;
      respond(target.id, decision);
      // Optimistically drop it; the host's respond also clears the underlying
      // pending state. The activeIndex clamp effect keeps us on a valid item.
      remove(target.id);
    },
    [queue, activeIndex, respond, remove],
  );

  // Refs so the global key handler reads CURRENT values without re-subscribing
  // the listener on every queue change.
  const activeRef = useRef(active);
  activeRef.current = active;
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const nextRef = useRef(next);
  nextRef.current = next;
  const prevRef = useRef(prev);
  prevRef.current = prev;
  const editRef = useRef(onEdit);
  editRef.current = onEdit;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const cur = activeRef.current;
      if (!cur) return;
      // Never hijack typing: if focus is in a text field/editor, let it through.
      const el = e.target as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) {
          return;
        }
      }
      // Don't fight browser/app chords.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const k = e.key.toLowerCase();
      // Queue navigation.
      if (k === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        nextRef.current();
        return;
      }
      if (k === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        prevRef.current();
        return;
      }
      // Edit the active request.
      if (k === "e") {
        if (editRef.current) {
          e.preventDefault();
          editRef.current(cur.id);
        }
        return;
      }
      // Allow / deny verdicts.
      const verdict = KEY_MAP[k];
      if (verdict) {
        e.preventDefault();
        decideRef.current({ decision: verdict.decision, scope: verdict.scope });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  return useMemo(
    () => ({ queue, active, activeIndex, enqueue, remove, clear, next, prev, decide }),
    [queue, active, activeIndex, enqueue, remove, clear, next, prev, decide],
  );
}
