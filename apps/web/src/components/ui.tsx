import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

// Remember which primitives we've already nagged so a re-rendering icon button
// doesn't spam the console every frame.
const labelWarned = new Set<string>();

/**
 * Dev-only a11y nudge: an icon-only control (no visible text) should carry an
 * accessible name via `aria-label` (or `aria-labelledby`/`title`), or a screen
 * reader just announces "button". No-op in production and de-duped per component
 * so it never affects rendering — it only logs guidance during development.
 */
function warnMissingLabel(component: string, props: ButtonHTMLAttributes<HTMLButtonElement>): void {
  const labelled =
    props["aria-label"] != null ||
    props["aria-labelledby"] != null ||
    props.title != null;
  if (labelled || labelWarned.has(component)) return;
  labelWarned.add(component);
  // eslint-disable-next-line no-console
  console.warn(
    `[a11y] <${component}> is icon-only — pass an \`aria-label\` (or \`title\`) so it has an accessible name.`,
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-spin rounded-full border-2 border-zinc-700 border-t-clay-500",
        className ?? "h-4 w-4",
      )}
    />
  );
}

export function Badge({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function IconButton({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  // Icon-only buttons have no text label, so a screen reader announces them as a
  // bare "button". Nudge (dev-only, once per offender) toward an explicit
  // `aria-label`/`title`. `props` already forwards `aria-label` to the <button>,
  // so consumers only need to pass it — nothing here changes the rendering.
  if (import.meta.env?.DEV) warnMissingLabel("IconButton", props);
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-zinc-700">{icon}</div>
      <div className="text-sm font-medium text-zinc-400">{title}</div>
      {hint ? <div className="max-w-xs text-xs text-zinc-600">{hint}</div> : null}
    </div>
  );
}

/** Explicit retryable load failure; never doubles as a benign empty state. */
export function LoadErrorState({
  message,
  onRetry,
  retrying = false,
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-200"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="shrink-0 rounded-md bg-red-500/10 px-2.5 py-1 font-medium text-red-200 ring-1 ring-red-500/30 transition hover:bg-red-500/20 disabled:opacity-50"
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
