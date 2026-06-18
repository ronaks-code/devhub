/**
 * Rate-limit-aware turn RETRY policy — decide whether a finished turn should be
 * retried, and after how long, when the CLI/API throttled it.
 *
 * This sits one layer above {@link parseRateLimit}: that function CLASSIFIES a turn's
 * result/error into a {@link RateLimitInfo} signal; this one TURNS that signal into a
 * concrete retry decision (retry yes/no + a delay), folding in the current attempt
 * number and a backoff schedule.
 *
 * The policy is OPT-IN and conservative — a caller chooses to consult it; it never
 * spawns, cancels, or sleeps itself. A normal turn (no throttling signal) always
 * decides `shouldRetry: false`, so existing turn behavior is unchanged unless a caller
 * acts on a retry decision. Retries are bounded by `maxAttempts` so a caller can never
 * loop unboundedly.
 *
 * Retry rules:
 *   - `rate_limit` / `overloaded`  -> TRANSIENT, retry (the throttle clears with time).
 *   - `max_budget`                 -> do NOT retry: retrying spends nothing new because
 *     the run hit its configured USD ceiling; the user must raise the cap.
 *   - a clean success, a user interrupt, or any unrecognized error -> do NOT retry.
 *
 * Delay: prefer the parsed `resetAt` deadline (when the limit actually clears), clamped
 * to a sane max so a far-future or bogus reset can't strand a caller; otherwise a capped
 * exponential backoff (base · 2^attempt) plus a DETERMINISTIC jitter derived from the
 * attempt number (no `Math.random`, so the decision is reproducible in tests and avoids
 * a thundering herd when many turns back off in lockstep).
 *
 * PURE — no Node imports, `now` injectable — so a browser face can compute a retry
 * decision on a {@link TurnResult} it received over the wire exactly as the server can.
 */
import type { TurnResult } from "./driver/types.js";
import { parseRateLimit, type RateLimitReason } from "./rate-limit.js";

/** Tunables for {@link computeRetry}. All optional; an empty object is the default. */
export interface RetryOptions {
  /**
   * Hard cap on attempts (counting the original try as attempt 0). With the default of
   * 5, attempts 0..3 may retry and attempt 4 is the last one (so `shouldRetry` is false
   * from attempt `maxAttempts - 1` onward). A non-positive / non-finite value falls back
   * to the default.
   */
  maxAttempts?: number;
  /** Base backoff in ms for the exponential schedule (default 2000 = 2s). */
  baseDelayMs?: number;
  /**
   * Upper bound on ANY computed delay (default 600_000 = 10 min). Caps both the
   * exponential backoff and a `resetAt`-derived wait, so a far-future or malformed reset
   * can never produce an absurd sleep.
   */
  maxDelayMs?: number;
  /** Injectable "now" (epoch ms) for deterministic tests; production callers omit it. */
  now?: number;
}

/** The default attempt cap (original try + retries). */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** The default exponential-backoff base (2s). */
export const DEFAULT_BASE_DELAY_MS = 2_000;
/** The default ceiling on any single delay (10 min). */
export const DEFAULT_MAX_DELAY_MS = 600_000;

/** The retry reasons that are TRANSIENT — worth retrying after a wait. */
const RETRYABLE: ReadonlySet<RateLimitReason> = new Set<RateLimitReason>(["rate_limit", "overloaded"]);

/** A retry decision for one finished turn. */
export interface RetryDecision {
  /** True only for a transient throttle below the attempt cap. */
  shouldRetry: boolean;
  /**
   * How long to wait before the next attempt, in ms. Always >= 0 and <= `maxDelayMs`.
   * 0 when `shouldRetry` is false, or when a `resetAt` is already in the past.
   */
  delayMs: number;
  /** Which throttling signal drove the retry, when one did (mirrors {@link RateLimitReason}). */
  reason?: RateLimitReason;
  /** Echo of the attempt this decision was made for (0-based), for logging/telemetry. */
  attempt: number;
}

/**
 * A small DETERMINISTIC jitter fraction in [0, 1) derived purely from the attempt
 * number — no `Math.random`, so a decision is reproducible and two callers on the same
 * attempt don't back off to the exact same instant only by luck. A cheap integer hash
 * (xorshift-style mix) spreads consecutive attempts across the range.
 */
function jitterFraction(attempt: number): number {
  let x = (attempt + 1) * 2654435761; // Knuth multiplicative hash on a non-zero seed.
  x ^= x >>> 13;
  x = Math.imul(x, 0x5bd1e995);
  x ^= x >>> 15;
  // `>>> 0` makes it an unsigned 32-bit int; divide by 2^32 for a fraction in [0, 1).
  return (x >>> 0) / 4294967296;
}

/** Clamp `n` into [0, max]; a non-finite `n` becomes 0. */
function clampDelay(n: number, max: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

/** Resolve `maxAttempts`, falling back to the default for a bad value. */
function resolveMaxAttempts(v: number | undefined): number {
  if (v == null || !Number.isFinite(v) || v <= 0) return DEFAULT_MAX_ATTEMPTS;
  return Math.floor(v);
}

/**
 * Capped exponential backoff with deterministic jitter: `base · 2^attempt`, plus up to
 * one extra `base · jitter(attempt)`, clamped to `maxDelayMs`. The exponent is computed
 * in float and the result clamped, so a large `attempt` can't overflow into nonsense —
 * it just saturates at the cap.
 */
function backoffDelay(attempt: number, base: number, max: number): number {
  const exp = base * Math.pow(2, Math.max(0, attempt));
  const jitter = base * jitterFraction(attempt);
  return clampDelay(exp + jitter, max);
}

/**
 * Decide whether a finished turn should be retried and, if so, after how long.
 *
 * `resultOrError` is the same shape {@link parseRateLimit} accepts: a {@link TurnResult},
 * a raw error string, or null/undefined (a clean/aborted turn). `attempt` is the 0-based
 * index of the try that just finished.
 *
 *   - No throttling signal (success, user-interrupt, unrecognized error) -> no retry.
 *   - `max_budget` -> no retry (retrying won't help; the user must raise the cap), but
 *     the `reason` is still reported so a caller can surface it.
 *   - `rate_limit` / `overloaded` AND `attempt < maxAttempts - 1` -> retry. The delay is
 *     the parsed `resetAt` (clamped) when present, else capped exponential backoff.
 *   - the same transient signal AT/PAST the last attempt -> no retry (cap reached).
 *
 * Pure & deterministic — inject `opts.now` for tests.
 */
export function computeRetry(
  resultOrError: TurnResult | string | null | undefined,
  attempt: number,
  opts: RetryOptions = {},
): RetryDecision {
  const now = opts.now ?? Date.now();
  const maxAttempts = resolveMaxAttempts(opts.maxAttempts);
  const baseDelayMs = Number.isFinite(opts.baseDelayMs as number) && (opts.baseDelayMs as number) > 0
    ? (opts.baseDelayMs as number)
    : DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = Number.isFinite(opts.maxDelayMs as number) && (opts.maxDelayMs as number) > 0
    ? (opts.maxDelayMs as number)
    : DEFAULT_MAX_DELAY_MS;
  // Normalize a negative/non-finite attempt to 0 so callers can't compute a bogus index.
  const at = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;

  const info = parseRateLimit(resultOrError, now);

  // Not throttled, or throttled by a non-retryable reason (max_budget): never retry.
  if (!info.limited || !info.reason || !RETRYABLE.has(info.reason)) {
    return { shouldRetry: false, delayMs: 0, reason: info.reason, attempt: at };
  }

  // Transient throttle, but the attempt cap is reached: stop (no more retries).
  if (at >= maxAttempts - 1) {
    return { shouldRetry: false, delayMs: 0, reason: info.reason, attempt: at };
  }

  // Prefer the parsed reset deadline (clamped); a reset already in the past -> 0 delay
  // (retry immediately). Otherwise fall back to capped exponential backoff.
  const delayMs =
    info.resetAt != null
      ? clampDelay(info.resetAt - now, maxDelayMs)
      : backoffDelay(at, baseDelayMs, maxDelayMs);

  return { shouldRetry: true, delayMs, reason: info.reason, attempt: at };
}
