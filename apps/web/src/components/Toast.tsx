import { useEffect } from "react";
import { Bell, CheckCircle2, Info, AlertTriangle, X } from "lucide-react";
import { cn } from "../lib/utils";

/** One toast to display. `id` is unique; `onClick` (optional) makes it actionable. */
export interface ToastItem {
  id: number;
  title: string;
  body?: string;
  level?: "info" | "success" | "warning";
  /** Invoked when the toast body is clicked (e.g. open the related session). */
  onClick?: () => void;
}

const LEVEL_META = {
  info: { icon: <Info className="h-4 w-4" />, ring: "ring-sky-500/30", tint: "text-sky-300" },
  success: { icon: <CheckCircle2 className="h-4 w-4" />, ring: "ring-emerald-500/30", tint: "text-emerald-300" },
  warning: { icon: <AlertTriangle className="h-4 w-4" />, ring: "ring-amber-500/30", tint: "text-amber-300" },
} as const;

/** A single auto-dismissing toast card. */
function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const meta = LEVEL_META[item.level ?? "info"];
  // Auto-dismiss after a few seconds; cleared if the toast unmounts first.
  useEffect(() => {
    const t = window.setTimeout(() => onDismiss(item.id), 6000);
    return () => window.clearTimeout(t);
  }, [item.id, onDismiss]);

  const clickable = !!item.onClick;
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-80 items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/95 px-3.5 py-3 shadow-xl ring-1 backdrop-blur",
        meta.ring,
      )}
      role="status"
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
          <div className="mt-1 text-[11px] font-medium text-clay-300">Open session →</div>
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
 * Empty container renders nothing.
 */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      <span className="sr-only">
        <Bell className="h-4 w-4" />
      </span>
      {toasts.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
