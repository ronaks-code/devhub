import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

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
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-40",
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
