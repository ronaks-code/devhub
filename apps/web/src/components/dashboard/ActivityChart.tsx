import { useEffect, useId, useMemo, useState } from "react";
import { Calendar, X } from "lucide-react";
import type { DailyUsage, SessionSummary } from "../../lib/types";
import { api } from "../../lib/api";
import { compactNumber, formatUsd, relativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";
import { displaySessionTitle, projectNameFromCwd } from "../../lib/session-title";
import { addDaysYmd, formatDayLabel, ymdSpanDays } from "./dateMath";

/** Sum of the four token buckets for one rolled-up day. */
function dayTokens(d: DailyUsage): number {
  return d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens;
}

/**
 * UTC `YYYY-MM-DD` for an ISO timestamp (or null when unparseable). Rollup days
 * are UTC calendar days, so a session is matched to a bar by its UTC last-activity
 * day — keeping the drill-down consistent with the bar it was clicked from.
 */
function utcDay(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** How many recent sessions to pull when drilling into a day (filtered client-side). */
const DRILL_FETCH_LIMIT = 500;

/**
 * Round a positive value UP to a "nice" axis number — 1/2/2.5/5/10 × 10^n — the
 * standard d3-style axis-tick rounding. Used so the y-axis top reads "$5k"
 * instead of the exact busiest day's cost, e.g. "$5273.70" (QA m9).
 */
function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const frac = value / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * base;
}

/** A nice axis value as a compact dollar figure — "$5k" / "$2.5k" / "$0" —
 * never the raw decimals `formatUsd` uses for precise figures elsewhere. */
function formatAxisUsd(n: number): string {
  if (n <= 0) return "$0";
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `$${Math.round(n)}`;
}

/** A DailyUsage with every metric zeroed, for gap-filling absent calendar days. */
function zeroDay(date: string): DailyUsage {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    sessions: 0,
  };
}

/** One charted day: the rollup (or a zero-fill) + whether it's synthetic. */
interface ChartDay {
  day: DailyUsage;
  /** True for a gap-filled zero day — charted honestly at $0, but not clickable
   * (there is no rollup to drill into). */
  synthetic: boolean;
}

/** Don't zero-fill spans longer than this (an "All" window can cover years —
 * a per-day series that long buys nothing and costs thousands of DOM nodes). */
const MAX_FILL_DAYS = 366;

/** The dashed rule's average, as a short label ("avg $12.40/day"). */
function formatAvgUsd(n: number): string {
  if (n >= 1000) return formatAxisUsd(n);
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * The "Daily spend" chart for the Dashboard (§3.6): a single violet AREA + LINE
 * over the per-day rollup costs (`DailyUsage.costUsd`, oldest→newest), with a
 * peak marker on the most expensive day, a dashed rule at the window's average
 * daily spend, and date labels on the x-axis. The y-axis keeps the rounded
 * "nice" dollar ticks ($5k, $2.5k, $0) — and unlike the old bar chart, the
 * geometry is scaled to that same cost axis, so the curve and the ticks agree.
 *
 * Days with no rollup row are zero-filled between the series' first and last
 * day (capped at a year) so the x-axis is true calendar time — a quiet week
 * reads as a dip, not a skipped gap.
 *
 * Each real day keeps the drill-down: an invisible full-height hit area over
 * its x-slice (a focusable button) opens the modal listing the sessions whose
 * last activity fell on it — each row opens the session in the Browse
 * transcript. Zero-filled days have nothing to drill into and aren't clickable.
 */
export function ActivityChart({
  days,
  onOpenSession,
}: {
  /** In-range daily usage, oldest→newest (the same series the host sums for totals). */
  days: DailyUsage[];
  /** Open a session in the Browse view: (projectId, sessionId). From the Dashboard. */
  onOpenSession?: (projectId: string, sessionId: string) => void;
}) {
  // The day a hit-area drilled into (its DailyUsage), or null when no modal is open.
  const [drill, setDrill] = useState<DailyUsage | null>(null);
  const gradientId = useId();

  // Zero-fill calendar gaps so x-distance = time. Skipped for multi-year spans.
  const series = useMemo<ChartDay[]>(() => {
    if (days.length < 2) return days.map((day) => ({ day, synthetic: false }));
    const first = days[0]!.date;
    const last = days[days.length - 1]!.date;
    const span = ymdSpanDays(first, last);
    if (span > MAX_FILL_DAYS || span <= days.length) {
      return days.map((day) => ({ day, synthetic: false }));
    }
    const byDate = new Map(days.map((d) => [d.date, d]));
    const out: ChartDay[] = [];
    for (let i = 0; i < span; i++) {
      const date = addDaysYmd(first, i);
      const real = byDate.get(date);
      out.push(real ? { day: real, synthetic: false } : { day: zeroDay(date), synthetic: true });
    }
    return out;
  }, [days]);

  // Cost geometry: nice-rounded axis top, average rule, and the peak day.
  const { axisMax, avg, peakIdx } = useMemo(() => {
    let max = 0;
    let total = 0;
    let peak = 0;
    series.forEach(({ day }, i) => {
      total += day.costUsd;
      if (day.costUsd > max) {
        max = day.costUsd;
        peak = i;
      }
    });
    return {
      axisMax: niceCeil(max),
      avg: series.length > 0 ? total / series.length : 0,
      peakIdx: peak,
    };
  }, [series]);

  const n = series.length;
  const xAt = (i: number): number => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const yAt = (cost: number): number => (axisMax > 0 ? 100 - (cost / axisMax) * 100 : 100);

  // SVG paths in a 0–100 viewBox stretched to fit; strokes stay crisp via
  // vector-effect="non-scaling-stroke".
  const linePath =
    n >= 2
      ? `M ${series.map(({ day }, i) => `${xAt(i).toFixed(2)} ${yAt(day.costUsd).toFixed(2)}`).join(" L ")}`
      : null;
  const areaPath = linePath ? `${linePath} L 100 100 L 0 100 Z` : null;

  const peak = series[peakIdx];
  const showPeak = axisMax > 0 && peak != null && peak.day.costUsd > 0;
  const peakX = xAt(peakIdx);
  const peakY = peak ? yAt(peak.day.costUsd) : 100;
  // Keep the peak label inside the plot: clamp x, flip below the dot near the top.
  const peakLabelX = Math.min(88, Math.max(12, peakX));
  const peakLabelBelow = peakY < 22;

  const showAvg = axisMax > 0 && n > 1 && avg > 0;
  const avgY = yAt(avg);

  // Up to 4 evenly spaced date ticks (always including the first + last day).
  const tickIdxs = useMemo(() => {
    if (n === 0) return [];
    const count = Math.min(4, n);
    const set = new Set<number>();
    for (let k = 0; k < count; k++) set.add(Math.round((k * (n - 1)) / Math.max(1, count - 1)));
    return [...set].sort((a, b) => a - b);
  }, [n]);

  return (
    <>
      <div className="flex gap-1.5">
        {/* y-axis — the rounded "nice" dollar ticks, same as before. */}
        <div
          className="flex h-28 flex-col justify-between py-2 text-right text-[10px] leading-none tabular-nums text-zinc-600"
          aria-hidden
        >
          <span>{formatAxisUsd(axisMax)}</span>
          <span>{formatAxisUsd(axisMax / 2)}</span>
          <span>$0</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative h-28 overflow-hidden rounded-xl border border-[var(--dh-border)] bg-[var(--dh-control)]">
            {/* Plot region, inset so the line/markers don't kiss the border. */}
            <div className="absolute inset-x-2 inset-y-2">
              <svg
                className="absolute inset-0 h-full w-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--dh-violet, #a78bfa)" stopOpacity="0.32" />
                    <stop offset="100%" stopColor="var(--dh-violet, #a78bfa)" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                {/* Mid gridline, matching the axis' half tick. */}
                <line
                  x1="0"
                  y1="50"
                  x2="100"
                  y2="50"
                  stroke="var(--dh-border, #2a2337)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  opacity="0.6"
                />
                {areaPath ? <path d={areaPath} fill={`url(#${gradientId})`} /> : null}
                {linePath ? (
                  <path
                    d={linePath}
                    fill="none"
                    stroke="var(--dh-violet, #a78bfa)"
                    strokeWidth="1.75"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                {/* Dashed rule at the window's average daily spend. */}
                {showAvg ? (
                  <line
                    x1="0"
                    y1={avgY.toFixed(2)}
                    x2="100"
                    y2={avgY.toFixed(2)}
                    stroke="var(--dh-violet, #a78bfa)"
                    strokeWidth="1"
                    strokeDasharray="3 4"
                    vectorEffect="non-scaling-stroke"
                    opacity="0.5"
                  />
                ) : null}
              </svg>

              {showAvg ? (
                <span
                  className="dh-nums pointer-events-none absolute right-0 z-10 -translate-y-full whitespace-nowrap pb-px text-[9px] leading-none text-[color:var(--dh-text-dim)]"
                  style={{ top: `${avgY}%` }}
                >
                  avg {formatAvgUsd(avg)}/day
                </span>
              ) : null}

              {/* Peak-day marker + label. */}
              {showPeak ? (
                <>
                  <span
                    className="pointer-events-none absolute z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--dh-control)] bg-[var(--dh-violet)]"
                    style={{ left: `${peakX}%`, top: `${peakY}%` }}
                  />
                  <span
                    className="dh-nums pointer-events-none absolute z-10 whitespace-nowrap text-[9px] font-semibold leading-none text-violet-200"
                    style={{
                      left: `${peakLabelX}%`,
                      top: peakLabelBelow ? `calc(${peakY}% + 7px)` : `calc(${peakY}% - 7px)`,
                      transform: peakLabelBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
                    }}
                  >
                    {formatUsd(peak.day.costUsd)}
                  </span>
                </>
              ) : null}

              {/* Per-day hit areas: real days keep the click-to-drill-down. */}
              <div className="absolute inset-0 flex">
                {series.map(({ day, synthetic }) => {
                  if (synthetic) {
                    return <div key={day.date} className="min-w-0 flex-1" title={`${day.date}: no usage`} />;
                  }
                  const t = dayTokens(day);
                  const tip = `${day.date}: ${formatUsd(day.costUsd)} · ${compactNumber(t)} tokens · ${day.sessions} session${day.sessions === 1 ? "" : "s"} — click to view`;
                  return (
                    <button
                      key={day.date}
                      type="button"
                      onClick={() => setDrill(day)}
                      className="min-w-0 flex-1 rounded-sm transition hover:bg-violet-400/10 focus-visible:bg-violet-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/50"
                      title={tip}
                      aria-label={tip}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* x-axis date labels (mx-2 mirrors the plot region's inset). */}
          <div className="dh-nums relative mx-2 mt-1 h-3.5 text-[9px] leading-none text-zinc-600" aria-hidden>
            {tickIdxs.map((i, k) => {
              const x = xAt(i);
              const transform =
                k === 0 && x <= 1 ? "none" : k === tickIdxs.length - 1 && x >= 99 ? "translateX(-100%)" : "translateX(-50%)";
              return (
                <span
                  key={series[i]!.day.date}
                  className="absolute top-0 whitespace-nowrap"
                  style={{ left: `${x}%`, transform }}
                >
                  {formatDayLabel(series[i]!.day.date)}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {drill ? (
        <DayDrilldown
          day={drill}
          onClose={() => setDrill(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </>
  );
}

/**
 * Modal listing the sessions whose last activity fell on `day.date`. Fetches the
 * most-recent sessions once and filters to the day in the browser (rollups know
 * only calendar days, not which sessions land on them), then lets the user open
 * any one in the Browse transcript. Closes on Escape or a backdrop click.
 */
function DayDrilldown({
  day,
  onClose,
  onOpenSession,
}: {
  day: DailyUsage;
  onClose: () => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState(false);

  // Pull recent sessions once, then narrow to this day client-side. Sorting by
  // "recent" keeps the busiest/most-recent days within the fetch window.
  useEffect(() => {
    let cancelled = false;
    api
      .allSessions({ sort: "recent", limit: DRILL_FETCH_LIMIT })
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

  // Close on Escape, matching the app's other overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo<SessionSummary[]>(() => {
    if (!sessions) return [];
    return sessions.filter((s) => utcDay(s.lastTimestamp) === day.date);
  }, [sessions, day.date]);

  const tokens = dayTokens(day);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Sessions on ${day.date}`}
      >
        {/* Header: the day + its rolled-up totals. */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Calendar className="h-4 w-4 text-violet-400" />
          <span className="text-[13px] font-semibold text-zinc-100">{day.date}</span>
          <span className="text-[11px] tabular-nums text-zinc-600">
            {compactNumber(tokens)} tok · {formatUsd(day.costUsd)} · {day.sessions} session
            {day.sessions === 1 ? "" : "s"}
          </span>
          <button
            onClick={onClose}
            className="ml-auto inline-flex items-center justify-center rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body: the day's sessions, or the appropriate loading/empty/error state. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="px-4 py-8 text-center text-[12px] text-zinc-600">
              Session listing isn't available on this server.
            </div>
          ) : sessions === null ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner className="h-5 w-5" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-zinc-600">
              No sessions landed on this day{" "}
              {day.sessions > 0 ? "(older than the recent window)" : ""}.
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-zinc-800/60">
              {rows.map((s) => {
                const project = projectNameFromCwd(s.cwd) ?? "unknown";
                const open = () => {
                  onOpenSession?.(s.projectId, s.sessionId);
                  onClose();
                };
                return (
                  <button
                    key={s.sessionId}
                    onClick={open}
                    disabled={!onOpenSession}
                    className={cn(
                      "group flex items-center gap-3 px-4 py-2.5 text-left transition hover:bg-zinc-800/40 disabled:cursor-default",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/50",
                    )}
                    title={s.cwd ?? undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-zinc-200 group-hover:text-zinc-100">
                        {displaySessionTitle(s)}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-600">
                        <span className="truncate">{project}</span>
                        {s.model ? (
                          <>
                            <span>·</span>
                            <span className="truncate">{s.model}</span>
                          </>
                        ) : null}
                        <span>·</span>
                        <span className="tabular-nums">{s.messageCount} msg</span>
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
                      {relativeTime(s.lastTimestamp)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
