import { useMemo } from "react";
import { cn } from "../../../lib/utils";
import { opsFilterCounts, type OpsEntry, type OpsFilter } from "./opsHelpers";

/** The §3.7 head filter chips, left→right. */
const FILTERS: ReadonlyArray<{ value: OpsFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "anthropic", label: "Claude" },
  { value: "openai", label: "Codex" },
  { value: "needsYou", label: "Needs me" },
];

/**
 * Live Ops head filter chips (§3.7): All / Claude / Codex / Needs me. Shared by the
 * Glass Grid and the Attention Board so both filter identically. Purely a VIEW
 * filter — the caller keeps its head totals on the full entry list; these chips
 * only narrow which cards render. Each chip carries a live match count so an empty
 * "Needs me" reads as a calm "0" rather than a dead button.
 */
export function OpsFilterChips({
  entries,
  filter,
  onFilterChange,
}: {
  entries: OpsEntry[];
  filter: OpsFilter;
  onFilterChange: (next: OpsFilter) => void;
}) {
  const counts = useMemo(() => opsFilterCounts(entries), [entries]);

  return (
    <div role="group" aria-label="Filter sessions" className="glass-card inline-flex items-center p-0.5">
      {FILTERS.map(({ value, label }) => {
        const active = filter === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onFilterChange(value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[11.5px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dh-focus)]",
              active
                ? "bg-[var(--dh-rail-active)] text-[var(--dh-text-strong)] ring-1 ring-[var(--dh-glass-border-hi)]"
                : "text-[var(--dh-text-muted)] hover:text-[var(--dh-text)]",
            )}
          >
            {label}
            <span className="dh-nums rounded-full bg-[var(--dh-control)] px-1.5 text-[10px] font-semibold text-[var(--dh-text-muted)]">
              {counts[value]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
