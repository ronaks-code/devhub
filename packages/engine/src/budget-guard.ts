/**
 * Pre-turn budget guard + spend projection — the advisory layer a face/driver can
 * consult BEFORE spending more money, on top of the dashboard's {@link BudgetStatus}.
 *
 * Where `budget.ts` answers "where does this month sit?" for a status bar, this module
 * answers two operational questions:
 *   1. {@link budgetGuardStatus} — a richer, period-aware snapshot: remaining headroom,
 *      a linear month-to-date PROJECTION to the period end, and a coarse ok/warn/over
 *      state graded against the configured cap.
 *   2. {@link guardTurn} — a CHEAP pre-turn gate: should this turn be allowed, and if
 *      not, why. It is ADVISORY: a caller opts in by calling it; it never reaches into
 *      the CLI driver's spawn path, so existing turns are unchanged.
 *
 * Spend is read from the SAME bounded per-day rollup the dashboard uses
 * ({@link DailyUsage}); we never re-scan transcripts and add no schema. The cap comes
 * from `AppSettings.monthlyBudgetUsd` (the existing soft monthly budget) via the
 * existing settings accessor — `Engine.budgetStatus()` / `Engine.guardTurn()` wire the
 * pure functions here to the live settings + index.
 *
 * Pure (no DB / no Node) given the rollup rows + cap, so it is trivially unit-testable.
 */
import type { DailyUsage } from "./rollups.js";

/** Fraction of the cap at or above which we surface a "warn" (sane default). */
export const DEFAULT_WARN_FRACTION = 0.8;

/** Coarse grade of where spend sits vs. the configured cap. */
export type BudgetState = "ok" | "warn" | "over";

/** Options for {@link budgetGuardStatus}. All optional; an empty object is the default. */
export interface BudgetGuardOptions {
  /**
   * Fraction of the cap (0..1) at or above which `state` becomes "warn". Defaults to
   * {@link DEFAULT_WARN_FRACTION}. Clamped to [0, 1]; a non-finite value is ignored.
   */
  warnFraction?: number;
  /** Injectable "now" for deterministic tests; production callers omit it. */
  now?: Date;
}

/**
 * A period-aware budget snapshot. The period is the CURRENT calendar month (UTC), to
 * match the rest of the engine's day/activity conventions (and `budget.ts`).
 */
export interface BudgetGuardStatus {
  /** The configured cap in USD, or null when the user hasn't set one. */
  capUsd: number | null;
  /** APPROXIMATE USD spent so far this period (UTC month-to-date). */
  spentUsd: number;
  /** Headroom left under the cap (`capUsd - spentUsd`, floored at 0); null when no cap. */
  remainingUsd: number | null;
  /**
   * Fraction of the cap consumed (`spentUsd / capUsd`); may exceed 1 when over. 0 when
   * no (or a non-positive) cap is set, since there is nothing to grade against.
   */
  fraction: number;
  /** "ok" under the warn threshold (or no cap), "warn" at >= it, "over" at >= the cap. */
  state: BudgetState;
  /**
   * Linear month-to-date PROJECTION of this period's total spend: `spentUsd` scaled by
   * `periodDuration / elapsedSoFar` (i.e. spend continues at the current daily rate to
   * the period end). Equals `spentUsd` at the very end of the period; computed even when
   * no cap is set. Estimate for planning, not a billed figure.
   */
  projectedUsd: number;
  /** Inclusive ISO start of the period (first instant of the UTC month). */
  periodStart: string;
  /** Exclusive ISO end of the period (first instant of the NEXT UTC month). */
  periodEnd: string;
}

/** First instant of the UTC month containing `now`. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of the UTC month AFTER the one containing `now` (exclusive end). */
function monthEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Clamp the warn fraction into [0, 1], falling back to the default for bad input. */
function resolveWarnFraction(v: number | undefined): number {
  if (v == null || !Number.isFinite(v)) return DEFAULT_WARN_FRACTION;
  return Math.min(1, Math.max(0, v));
}

/**
 * Compute the period-aware budget guard status from a (full or windowed) daily-usage
 * series. Only rows whose `date` falls in the current calendar month (UTC) contribute
 * to `spentUsd`, so the caller may pass the whole series.
 *
 * Projection is linear month-to-date: if half the period has elapsed and $X is spent,
 * the projection is ~2·$X. The elapsed fraction is measured in ms from `periodStart` to
 * `now`, floored at one day so a projection on day 1 isn't a divide-by-zero blow-up; a
 * `now` at/after the period end projects exactly `spentUsd` (the period is complete).
 *
 * With no cap (`null`) — or a non-positive one — `fraction` is 0 and `state` is "ok":
 * there's nothing to grade, but `spentUsd`/`projectedUsd` are still reported.
 */
export function budgetGuardStatus(
  capUsd: number | null | undefined,
  daily: DailyUsage[],
  opts: BudgetGuardOptions = {},
): BudgetGuardStatus {
  const now = opts.now ?? new Date();
  const start = monthStart(now);
  const end = monthEnd(now);
  const periodStart = start.toISOString();
  const periodEnd = end.toISOString();
  const prefix = periodStart.slice(0, 7); // `YYYY-MM`

  let spentUsd = 0;
  for (const d of daily) {
    if (d.date.startsWith(prefix)) spentUsd += d.costUsd;
  }

  // Linear projection: spend scaled by (whole period / elapsed so far). Elapsed is
  // floored at one day to avoid a tiny denominator early in the period; once `now` is
  // at/after the period end, the period is complete so the projection is just spend.
  const ONE_DAY_MS = 86_400_000;
  const total = end.getTime() - start.getTime();
  const elapsed = Math.min(total, Math.max(ONE_DAY_MS, now.getTime() - start.getTime()));
  const projectedUsd = elapsed >= total ? spentUsd : spentUsd * (total / elapsed);

  const cap = capUsd ?? null;
  if (cap == null || cap <= 0) {
    return {
      capUsd: cap,
      spentUsd,
      remainingUsd: null,
      fraction: 0,
      state: "ok",
      projectedUsd,
      periodStart,
      periodEnd,
    };
  }

  const fraction = spentUsd / cap;
  const warnAt = resolveWarnFraction(opts.warnFraction);
  const state: BudgetState = fraction >= 1 ? "over" : fraction >= warnAt ? "warn" : "ok";
  return {
    capUsd: cap,
    spentUsd,
    remainingUsd: Math.max(0, cap - spentUsd),
    fraction,
    state,
    projectedUsd,
    periodStart,
    periodEnd,
  };
}

/** Options for {@link guardTurn}. */
export interface GuardTurnOptions extends BudgetGuardOptions {
  /**
   * Estimated USD this upcoming turn will cost. Folded into the "over" check so a turn
   * that WOULD push spend past the cap is treated as over even if current spend isn't.
   * Defaults to 0 (judge against current spend only).
   */
  estimatedUsd?: number;
  /**
   * Whether being "over" actually BLOCKS the turn. Default-on (true): when over, the
   * turn is disallowed. Set false to make the guard purely informational — `allow`
   * stays true and the caller can surface the warning itself.
   */
  enforce?: boolean;
}

/**
 * A cheap pre-turn decision. `allow` is false ONLY when the (estimate-inclusive) spend
 * is already "over" the cap AND enforcement is on; otherwise `allow` is true — including
 * the "warn" band, where `reason` carries the advisory so a face can surface it without
 * blocking. `status` is the full {@link BudgetGuardStatus} the decision was made from
 * (graded against the BASE spend, not the estimate), so callers can render details.
 */
export interface TurnGuardDecision {
  allow: boolean;
  /** Human-readable rationale; present whenever the turn is over or in the warn band. */
  reason?: string;
  status: BudgetGuardStatus;
}

/** Round a USD figure to cents for stable, readable reason strings. */
function usd(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

/**
 * Pre-turn budget gate (pure). Computes the {@link budgetGuardStatus}, then decides:
 *   - no cap, or under the warn threshold -> allow, no reason.
 *   - "warn" band -> allow, with an advisory `reason`.
 *   - would be "over" (current spend + `estimatedUsd` >= cap) -> blocked when `enforce`
 *     (the default), else allowed with an "over" `reason`.
 *
 * ADVISORY: a caller opts in by calling this; it never spawns or cancels a turn itself,
 * so the CLI driver's behavior is unchanged unless a caller consults the decision.
 */
export function guardTurn(
  capUsd: number | null | undefined,
  daily: DailyUsage[],
  opts: GuardTurnOptions = {},
): TurnGuardDecision {
  const status = budgetGuardStatus(capUsd, daily, opts);
  const cap = status.capUsd;

  // No cap to enforce -> always allow (projection is still in `status`).
  if (cap == null || cap <= 0) return { allow: true, status };

  const estimatedUsd = Math.max(0, opts.estimatedUsd ?? 0);
  const enforce = opts.enforce ?? true;
  const wouldBeOver = status.spentUsd + estimatedUsd >= cap;

  if (wouldBeOver) {
    const projected = estimatedUsd > 0 ? status.spentUsd + estimatedUsd : status.spentUsd;
    const reason = `Spend ${usd(projected)} reaches the ${usd(cap)} budget cap for this period`;
    return { allow: !enforce, reason, status };
  }

  if (status.state === "warn") {
    const reason = `Spend ${usd(status.spentUsd)} is ${Math.round(status.fraction * 100)}% of the ${usd(cap)} budget cap`;
    return { allow: true, reason, status };
  }

  return { allow: true, status };
}
