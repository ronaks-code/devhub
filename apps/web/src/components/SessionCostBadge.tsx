import { useMemo, useState } from "react";
import { Coins } from "lucide-react";
import type { SessionSummary } from "../lib/types";
import { formatUsd } from "../lib/format";
import { cn } from "../lib/utils";

/**
 * A compact running-total cost badge for the TopBar. Sums the APPROXIMATE
 * {@link SessionSummary.costUsd} across the sessions already loaded for the active
 * project (no new fetch — it reuses the list App already has), and shows a tooltip
 * breaking the spend into "this project" vs. "all loaded projects".
 *
 * Plain words: a little dollar chip up top so you can see roughly how much the
 * project you're looking at has cost, without opening the dashboard. It's an
 * estimate (priced from token usage), never a bill.
 *
 * Self-hides when there's nothing to show (no sessions / $0), so it never adds
 * empty chrome to the header. Costs come straight off the engine's per-session
 * `costUsd` — the same display estimate the dashboard uses.
 */
export function SessionCostBadge({
  projectSessions,
  projectName,
}: {
  /** Sessions already fetched for the active project (App's `sessions` state). */
  projectSessions: SessionSummary[];
  /** Active project's display name, for the tooltip. */
  projectName?: string | null;
}) {
  const [hover, setHover] = useState(false);

  const total = useMemo(
    () => projectSessions.reduce((sum, s) => sum + (s.costUsd || 0), 0),
    [projectSessions],
  );

  // Nothing meaningful to show yet — keep the header clean.
  if (total <= 0) return null;

  const label = projectName ? `${projectName} · ` : "";
  const count = projectSessions.length;

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-clay-300 ring-1 ring-zinc-800"
        title={`${label}estimated spend across ${count} loaded session${count === 1 ? "" : "s"}`}
      >
        <Coins className="h-3 w-3 text-clay-400/80" />
        {formatUsd(total)}
      </span>
      {hover ? (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute right-0 top-full z-[60] mt-1.5 w-56 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-left shadow-xl",
          )}
        >
          <span className="block text-[11px] font-medium text-zinc-300">
            Estimated session cost
          </span>
          <span className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px]">
            <span className="min-w-0 truncate text-zinc-500">
              {projectName || "This project"}
            </span>
            <span className="shrink-0 tabular-nums text-clay-300">{formatUsd(total)}</span>
          </span>
          <span className="mt-0.5 block text-[10px] leading-snug text-zinc-600">
            Across {count} loaded session{count === 1 ? "" : "s"}. APPROXIMATE — priced from
            token usage, never billed truth.
          </span>
        </span>
      ) : null}
    </span>
  );
}
