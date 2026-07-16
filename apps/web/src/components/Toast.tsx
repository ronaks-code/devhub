import { useEffect, useRef } from "react";
import { Bell, CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * One toast to display. `id` is unique; `onClick` (optional) makes it actionable.
 *
 * `level` chooses the variant + tone: "info" (default), "success", "warning", and
 * "error". The first three match {@link import("../lib/types").NotifyEvent}'s level,
 * so the SSE-driven toasts in App.tsx need no change; "error" is additive for callers
 * that surface a failure. `duration` overrides the auto-dismiss timeout (ms); pass 0
 * to make the toast sticky (only a manual dismiss / click closes it).
 */
export interface ToastItem {
  id: number;
  title: string;
  body?: string;
  level?: "info" | "success" | "warning" | "error";
  /** Invoked when the toast body is clicked (e.g. open the related session). */
  onClick?: () => void;
  /**
   * Label for the click affordance shown under the body (default "Open session →").
   * Lets non-navigation toasts (e.g. a fetch-error Retry) read correctly. Only shown
   * when {@link onClick} is set.
   */
  actionLabel?: string;
  /** Auto-dismiss after this many ms (default {@link DEFAULT_DURATION}); 0 = never. */
  duration?: number;
}

/** Default auto-dismiss timeout. Matches the prior hard-coded 6s. */
const DEFAULT_DURATION = 6000;

const LEVEL_META = {
  info: { icon: <Info className="h-4 w-4" />, ring: "ring-sky-500/30", tint: "text-sky-300" },
  success: { icon: <CheckCircle2 className="h-4 w-4" />, ring: "ring-emerald-500/30", tint: "text-emerald-300" },
  warning: { icon: <AlertTriangle className="h-4 w-4" />, ring: "ring-amber-500/30", tint: "text-amber-300" },
  error: { icon: <XCircle className="h-4 w-4" />, ring: "ring-red-500/30", tint: "text-red-300" },
} as const;

/**
 * A single auto-dismissing toast card. The timer pauses while the pointer is over
 * the card (so a slow reader/hover never loses the toast mid-read) and resumes —
 * with the elapsed time deducted — on leave. A manual dismiss (the X) always works.
 */
function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const meta = LEVEL_META[item.level ?? "info"];
  const duration = item.duration ?? DEFAULT_DURATION;

  // Remaining time + the timestamp the current countdown started, so a hover can
  // pause (banking the remainder) and a leave can resume from there. A duration of
  // 0 disables the timer entirely (sticky toast).
  const remainingRef = useRef(duration);
  const startedRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // Pause/resume handlers, set up inside the effect so they share the timer refs;
  // the JSX wires the card's hover/focus events to them.
  const pauseRef = useRef<() => void>(() => {});
  const resumeRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (duration <= 0) return; // sticky — no auto-dismiss
    const clear = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // Arm from the current remaining time. Called on mount and on each resume.
    const arm = () => {
      clear();
      startedRef.current = Date.now();
      timerRef.current = window.setTimeout(() => onDismiss(item.id), remainingRef.current);
    };
    pauseRef.current = () => {
      if (timerRef.current == null) return;
      clear();
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
    };
    resumeRef.current = () => {
      if (remainingRef.current > 0) arm();
    };
    arm();
    return clear;
  }, [item.id, duration, onDismiss]);

  const clickable = !!item.onClick;
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-80 items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/95 px-3.5 py-3 shadow-xl ring-1 backdrop-blur",
        meta.ring,
      )}
      role="status"
      onMouseEnter={() => pauseRef.current()}
      onMouseLeave={() => resumeRef.current()}
      onFocus={() => pauseRef.current()}
      onBlur={() => resumeRef.current()}
    >
      <span className={cn("mt-0.5 shrink-0", meta.tint)}>{meta.icon}</span>
      <button
        type="button"
        onClick={() => {
          item.onClick?.();
          onDismiss(item.id);
        }}
        disabled={!clickable}
        className={cn(
          "min-w-0 flex-1 text-left",
          clickable ? "cursor-pointer" : "cursor-default",
        )}
      >
        <div className="truncate text-[13px] font-medium text-zinc-100">{item.title}</div>
        {item.body ? (
          <div className="mt-0.5 line-clamp-2 text-[12px] text-zinc-400">{item.body}</div>
        ) : null}
        {clickable ? (
          <div className="mt-1 text-[11px] font-medium text-clay-300">
            {item.actionLabel ?? "Open session →"}
          </div>
        ) : null}
      </button>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        className="shrink-0 rounded p-0.5 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Bottom-right stack of transient toasts. Unobtrusive: fixed, pointer-events-none
 * on the container (so it never blocks the UI) with each card re-enabling clicks.
 *
 * The whole stack lives in an `aria-live="polite"` / `role="status"` region so a
 * screen reader announces each new toast as it appears (without stealing focus).
 * The region stays MOUNTED even when empty so assistive tech keeps observing it —
 * an empty container is just visually nothing.
 */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions"
    >
      <span className="sr-only">
        <Bell className="h-4 w-4" />
        Notifications
      </span>
      {toasts.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
