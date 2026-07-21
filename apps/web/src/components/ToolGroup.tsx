import { useState, type ReactNode } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * ToolGroup — collapses a RUN of consecutive tool cards into one tidy
 * "N tool calls" summary row, expandable to the individual cards.
 *
 * An assistant turn often fires a burst of tools (read this, grep that, edit the
 * other) with little or no prose between them. Rendered one-card-per-block that's
 * a wall of collapsibles. We detect those runs upstream (see groupToolBlocks in
 * MessageView) and wrap them here: collapsed by default, the group shows a single
 * count + the tool names; expanding reveals the original per-tool cards verbatim
 * (the same nodes that would have rendered ungrouped — nothing is hidden, only
 * folded). Short runs aren't grouped at all, so a lone tool call still renders flat.
 */
export function ToolGroup({
  count,
  names,
  children,
  defaultOpen = false,
}: {
  /** Number of tool cards in the run (drives the "N tool calls" label). */
  count: number;
  /** Tool names in order (deduped + truncated for the summary preview). */
  names: string[];
  /** The individual tool cards, rendered when the group is expanded. */
  children: ReactNode;
  /** Start expanded (used e.g. while live so an in-flight burst stays visible). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Compact name preview: first few distinct tool names, "+k more" beyond that.
  const distinct = Array.from(new Set(names));
  const PREVIEW = 4;
  const shown = distinct.slice(0, PREVIEW);
  const extra = distinct.length - shown.length;

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-zinc-400 transition hover:bg-zinc-800/40"
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform", open && "rotate-90")}
        />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-[var(--dh-brand)]" />
        <span className="text-zinc-300">{count} tool calls</span>
        {!open && shown.length ? (
          <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-zinc-600">
            {shown.map((n, i) => (
              <span key={i} className="shrink-0 rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                {n}
              </span>
            ))}
            {extra > 0 ? <span className="shrink-0">+{extra} more</span> : null}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[10.5px] text-zinc-600">{open ? "collapse" : "expand"}</span>
      </button>
      {open ? <div className="border-t border-zinc-800/60 px-2 py-1">{children}</div> : null}
    </div>
  );
}
