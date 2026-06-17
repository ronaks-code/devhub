/**
 * Monthly spend budget status — the data behind a "budget bar" in the dashboard.
 *
 * Compares the user's soft monthly budget (`settings.monthlyBudgetUsd`) against
 * the month-to-date APPROXIMATE spend for the CURRENT calendar month. Spend comes
 * from the per-day cost series ({@link DailyUsage}), which buckets each session's
 * model-priced cost on the UTC day of its last activity — so the month boundary is
 * UTC too, matching the rest of the engine's day/activity conventions.
 *
 * Pure (no DB / no Node) given the rollup rows + budget value, so it is trivially
 * unit-testable; `Engine.getBudgetStatus()` wires it to the live settings + index.
 */
import type { DailyUsage } from "./rollups.js";
import type { BudgetStatus } from "./types.js";

export type { BudgetStatus } from "./types.js";

/** Threshold (fraction of budget) at or above which we warn. */
const WARN_AT = 0.8;
/** Threshold (fraction of budget) at or above which we flag "over". */
const OVER_AT = 1.0;

/** The UTC `YYYY-MM` prefix of a date (default: now). */
function utcMonthPrefix(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Compute the budget status from a (full or windowed) daily-usage series. Only the
 * rows whose `date` falls in the current calendar month (UTC) contribute to
 * `monthToDateUsd`; the rest are ignored, so the caller may pass the whole series.
 *
 * With no budget set (`null`) — or a non-positive one — `pct` is 0 and `alert` is
 * `"none"`: we still report `monthToDateUsd` (useful on its own) but can't grade it.
 *
 * `now` is injectable for deterministic tests; production callers omit it.
 */
export function budgetStatus(
  monthlyBudgetUsd: number | null | undefined,
  daily: DailyUsage[],
  now: Date = new Date(),
): BudgetStatus {
  const prefix = utcMonthPrefix(now);
  let monthToDateUsd = 0;
  for (const d of daily) {
    if (d.date.startsWith(prefix)) monthToDateUsd += d.costUsd;
  }

  const budget = monthlyBudgetUsd ?? null;
  if (budget == null || budget <= 0) {
    return { monthlyBudgetUsd: budget, monthToDateUsd, pct: 0, alert: "none" };
  }

  const pct = monthToDateUsd / budget;
  const alert: BudgetStatus["alert"] = pct >= OVER_AT ? "over" : pct >= WARN_AT ? "warn" : "none";
  return { monthlyBudgetUsd: budget, monthToDateUsd, pct, alert };
}
