import { useEffect, useMemo, useState } from "react";
import type { SessionSummary } from "../../lib/types";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

/** How many recent sessions to bucket. Enough to read a weekly rhythm. */
const SESSION_SAMPLE = 500;

/** Days of the week, Monday-first (matches how most people read a work week). */
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Hour-column labels along the top (every 3 hours keeps it readable). */
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21] as const;

/** Five activity buckets (index 0 = none). Tailwind clay tints, like CalendarHeatmap. */
const BUCKET_CLASSES = [
  "bg-zinc-900 ring-1 ring-inset ring-zinc-800/80", // 0 — no activity
  "bg-clay-500/25",
  "bg-clay-500/45",
  "bg-clay-500/70",
  "bg-clay-400",
] as const;

/** JS getDay() is Sunday=0..Saturday=6; remap to Monday-first row index 0..6. */
function mondayIndex(jsDay: number): number {
  return (jsDay + 6) % 7;
}

/**
 * Bucket a count into 0..4 against the grid's max, so the gradient adapts to the
 * user's volume (same approach as the contribution heatmap).
 */
function bucketize(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio > 0.66) return 4;
  if (ratio > 0.33) return 3;
  if (ratio > 0.1) return 2;
  return 1;
}

/** 12-hour clock label for a tooltip, e.g. 0 → "12am", 13 → "1pm". */
function hourLabel(h: number): string {
  const am = h < 12;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${am ? "am" : "pm"}`;
}

/**
 * A time-of-day × day-of-week activity heatmap, showing WHEN you tend to work.
 * Rows are weekdays (Mon→Sun), columns are the 24 hours of the day; each cell is
 * shaded by how many sessions started/last-touched in that (day, hour) slot.
 *
 * Plain words: it's a 7×24 grid that lights up where your coding sessions
 * cluster — so you can see at a glance that, say, you mostly work weekday
 * evenings. Built from recent session timestamps (the rollups only know calendar
 * days, not the hour), bucketed in the browser's local timezone.
 *
 * Self-loads its own session sample (independent of the dashboard's polling) so
 * it stays a drop-in section. Degrades to a quiet empty state when there are no
 * sessions or the listing isn't available.
 */
export function HourHeatmap() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .allSessions({ sort: "recent", limit: SESSION_SAMPLE })
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { grid, max, total } = useMemo(() => {
    // 7 rows (Mon..Sun) × 24 hour columns of counts.
    const g: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    let t = 0;
    for (const s of sessions ?? []) {
      // Prefer the session's last activity; fall back to its first timestamp.
      const iso = s.lastTimestamp ?? s.firstTimestamp;
      if (!iso) continue;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      const row = mondayIndex(d.getDay());
      const col = d.getHours();
      g[row]![col]!++;
      t++;
    }
    let m = 0;
    for (const r of g) for (const v of r) if (v > m) m = v;
    return { grid: g, max: m, total: t };
  }, [sessions]);

  if (error) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
        Session timestamps aren't available on this server yet.
      </div>
    );
  }

  if (sessions === null) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/30">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
        No session activity to chart yet.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="overflow-x-auto">
        <div className="inline-flex min-w-full flex-col gap-1.5">
          {/* Hour tick labels along the top, aligned to the 24 columns. */}
          <div className="flex pl-9 text-[9px] text-zinc-600">
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h} className="w-[14px] shrink-0">
                {HOUR_TICKS.includes(h as (typeof HOUR_TICKS)[number]) ? (
                  <span className="block -ml-px">{hourLabel(h)}</span>
                ) : null}
              </div>
            ))}
          </div>

          {/* One row per weekday: a label gutter + 24 hour cells. */}
          {grid.map((rowCounts, row) => (
            <div key={row} className="flex items-center gap-1">
              <div className="w-8 shrink-0 text-right text-[9px] leading-[12px] text-zinc-600">
                {DAY_LABELS[row]}
              </div>
              <div className="flex gap-[3px]">
                {rowCounts.map((count, hour) => {
                  const tip =
                    count > 0
                      ? `${DAY_LABELS[row]} ${hourLabel(hour)}: ${count} session${count === 1 ? "" : "s"}`
                      : `${DAY_LABELS[row]} ${hourLabel(hour)}: no activity`;
                  return (
                    <div
                      key={hour}
                      title={tip}
                      className={cn(
                        "h-[11px] w-[11px] rounded-[2px] transition hover:ring-1 hover:ring-clay-300/60",
                        BUCKET_CLASSES[bucketize(count, max)],
                      )}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer: sample size + the bucket legend. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span>
          <span className="font-semibold tabular-nums text-zinc-300">{total.toLocaleString()}</span>{" "}
          session{total === 1 ? "" : "s"} by local time of day
        </span>
        <span className="flex items-center gap-1">
          Less
          {BUCKET_CLASSES.map((cls, i) => (
            <span key={i} className={cn("h-[10px] w-[10px] rounded-[2px]", cls)} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}
