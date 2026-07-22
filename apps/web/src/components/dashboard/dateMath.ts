/**
 * UTC calendar-day math for `YYYY-MM-DD` strings — the exact format the rollup
 * series (`DailyUsage.date`) and the PeriodSelector's `since`/`until` use.
 * Shared by the Daily-spend chart (gap filling, x-axis labels) and the hero
 * card's prior-window delta so both surfaces count days identically.
 */

/** Parse a `YYYY-MM-DD` day into a Date at UTC midnight. */
function toUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
}

/** The day `delta` days after (negative = before) a `YYYY-MM-DD` day. */
export function addDaysYmd(ymd: string, delta: number): string {
  const dt = toUtc(ymd);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** INCLUSIVE day count from `a` through `b` (1 when a === b; 0 when b < a). */
export function ymdSpanDays(a: string, b: string): number {
  const days = Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000) + 1;
  return Math.max(0, days);
}

/** Short human label for a UTC day — "Jul 9" — for chart axis ticks. */
export function formatDayLabel(ymd: string): string {
  return toUtc(ymd).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
