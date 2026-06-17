import { useMemo } from "react";
import type { DailyUsage } from "../../lib/types";
import { compactNumber, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";

/** What the heatmap colors by. Sessions reads cleanest; tokens shows spend-shape. */
export type HeatmapMetric = "sessions" | "tokens";

/** Sum of the four token buckets for one rolled-up day. */
function dayTokens(d: DailyUsage): number {
  return d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens;
}

/** Local-time `YYYY-MM-DD` for a Date (rollup dates are calendar days). */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a `YYYY-MM-DD` into a local Date at midnight (avoids TZ drift). */
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Five GitHub-style buckets (index 0 = none). Tailwind clay tints. */
const BUCKET_CLASSES = [
  "bg-zinc-900 ring-1 ring-inset ring-zinc-800/80", // 0 — no activity
  "bg-clay-500/25",
  "bg-clay-500/45",
  "bg-clay-500/70",
  "bg-clay-400",
] as const;

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""] as const;
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** One day cell in the grid. */
interface Cell {
  date: string;
  value: number;
  tokens: number;
  cost: number;
  sessions: number;
  bucket: number;
}

/**
 * Bucket a value into 0..4 using thresholds derived from the active max, so the
 * scale adapts to the user's volume (a light user and a heavy user both get a
 * readable spread instead of everything maxing out or staying pale).
 */
function bucketize(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio > 0.66) return 4;
  if (ratio > 0.33) return 3;
  if (ratio > 0.1) return 2;
  return 1;
}

/**
 * A 12-month, GitHub-style contribution heatmap of daily activity. Columns are
 * weeks (Sun→Sat top-to-bottom), spanning ~53 weeks ending today, with month
 * labels along the top and a per-day tooltip. Colors bucket by the chosen metric
 * (sessions or total tokens), scaled to the period's max so the gradient is
 * always legible.
 *
 * Pure presentation over the `days` it's given (the DailyUsage series from
 * GET /api/rollups). Missing days render as empty (no-activity) cells.
 */
export function CalendarHeatmap({
  days,
  metric = "sessions",
}: {
  days: DailyUsage[];
  metric?: HeatmapMetric;
}) {
  const { weeks, monthSpans, total, max } = useMemo(() => {
    // Index the rollups by date for O(1) lookup as we walk the calendar.
    const byDate = new Map<string, DailyUsage>();
    for (const d of days) byDate.set(d.date, d);

    // Window: today back ~1 year, snapped so the grid starts on a Sunday.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = today;
    const start = new Date(end.getTime() - 364 * DAY_MS);
    // Back up to the Sunday on/before start so each column is a full week.
    const gridStart = new Date(start.getTime() - start.getDay() * DAY_MS);

    const metricOf = (d: DailyUsage) => (metric === "tokens" ? dayTokens(d) : d.sessions);

    // First pass: find the max metric in-window for adaptive bucketing.
    let maxVal = 0;
    let totalVal = 0;
    for (let t = gridStart.getTime(); t <= end.getTime(); t += DAY_MS) {
      const rec = byDate.get(ymd(new Date(t)));
      if (!rec) continue;
      const v = metricOf(rec);
      if (v > maxVal) maxVal = v;
      totalVal += v;
    }

    // Second pass: build week columns of 7 day-cells each.
    const cols: Cell[][] = [];
    let col: Cell[] = [];
    // Track which week-column each month's label should sit above (first column
    // whose first day is in that month).
    const spans: { label: string; colIndex: number }[] = [];
    let lastMonth = -1;

    let colIndex = 0;
    for (let t = gridStart.getTime(); t <= end.getTime(); t += DAY_MS) {
      const date = new Date(t);
      const key = ymd(date);
      const rec = byDate.get(key);
      const value = rec ? metricOf(rec) : 0;
      const cell: Cell = {
        date: key,
        value,
        tokens: rec ? dayTokens(rec) : 0,
        cost: rec ? rec.costUsd : 0,
        sessions: rec ? rec.sessions : 0,
        bucket: bucketize(value, maxVal),
      };

      if (date.getDay() === 0 && col.length > 0) {
        cols.push(col);
        col = [];
        colIndex++;
      }
      // New month → record a label above this column (once per month).
      if (date.getMonth() !== lastMonth) {
        lastMonth = date.getMonth();
        spans.push({ label: MONTH_LABELS[date.getMonth()]!, colIndex });
      }
      col.push(cell);
    }
    if (col.length > 0) cols.push(col);

    return { weeks: cols, monthSpans: spans, total: totalVal, max: maxVal };
  }, [days, metric]);

  const metricLabel = metric === "tokens" ? "tokens" : "sessions";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="overflow-x-auto">
        <div className="inline-flex min-w-full flex-col gap-1.5">
          {/* Month labels row, aligned to week columns. */}
          <div className="flex pl-7 text-[10px] text-zinc-600">
            {weeks.map((_, ci) => {
              const span = monthSpans.find((s) => s.colIndex === ci);
              return (
                <div key={ci} className="w-[13px] shrink-0">
                  {span ? <span className="block -ml-px">{span.label}</span> : null}
                </div>
              );
            })}
          </div>

          <div className="flex gap-1">
            {/* Weekday labels gutter (Mon/Wed/Fri). */}
            <div className="mr-1 flex w-6 shrink-0 flex-col gap-[3px] text-[9px] leading-[10px] text-zinc-600">
              {WEEKDAY_LABELS.map((lbl, i) => (
                <div key={i} className="h-[10px]">
                  {lbl}
                </div>
              ))}
            </div>

            {/* Week columns. */}
            <div className="flex gap-[3px]">
              {weeks.map((week, ci) => (
                <div key={ci} className="flex flex-col gap-[3px]">
                  {Array.from({ length: 7 }).map((_, ri) => {
                    const cell = week[ri];
                    if (!cell) {
                      // Padding cell (start/end of window not on a week boundary).
                      return <div key={ri} className="h-[10px] w-[10px]" />;
                    }
                    const tip =
                      cell.value > 0
                        ? `${cell.date}: ${cell.sessions} session${cell.sessions === 1 ? "" : "s"} · ${compactNumber(cell.tokens)} tokens · ${formatUsd(cell.cost)}`
                        : `${cell.date}: no activity`;
                    return (
                      <div
                        key={ri}
                        title={tip}
                        className={cn(
                          "h-[10px] w-[10px] rounded-[2px] transition hover:ring-1 hover:ring-clay-300/60",
                          BUCKET_CLASSES[cell.bucket],
                        )}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Footer: total + the bucket legend. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span>
          <span className="font-semibold tabular-nums text-zinc-300">
            {metric === "tokens" ? compactNumber(total) : total.toLocaleString()}
          </span>{" "}
          {metricLabel} in the last year
        </span>
        <span className="flex items-center gap-1">
          Less
          {BUCKET_CLASSES.map((cls, i) => (
            <span key={i} className={cn("h-[10px] w-[10px] rounded-[2px]", cls)} />
          ))}
          More
          {max <= 0 ? <span className="ml-1 text-zinc-600">(no activity yet)</span> : null}
        </span>
      </div>
    </div>
  );
}
