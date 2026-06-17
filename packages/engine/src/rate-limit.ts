/**
 * Detect rate-limit / budget / overload signals in a finished turn so a face can
 * show a banner or schedule a resume.
 *
 * Two sources feed this:
 *   1. A {@link TurnResult}'s `subtype` — the CLI reports terminal turn states like
 *      `error_max_budget_usd`, `error_max_turns`, etc. via the `result` frame's
 *      `subtype`. The budget/limit ones are classified here.
 *   2. Free error TEXT — a `result` frame's `result` body, an `onError` string, or any
 *      message the CLI/API surfaced (e.g. "rate_limit_exceeded", "overloaded_error",
 *      "Please retry after ..."). We scan it for the well-known Anthropic signals.
 *
 * PURE — no Node imports — so a browser face can call it on a {@link TurnResult} it
 * received over the wire just as easily as the server can on a fresh turn.
 */
import type { TurnResult } from "./driver/types.js";

/** What kind of throttling we detected, for a face to tailor its message. */
export type RateLimitReason =
  /** Per-account / per-org request or token rate limit (HTTP 429 family). */
  | "rate_limit"
  /** The turn hit the configured max USD budget for the run. */
  | "max_budget"
  /** The API is transiently overloaded (HTTP 529 / overloaded_error). */
  | "overloaded";

export interface RateLimitInfo {
  /** True when any throttling signal was detected. */
  limited: boolean;
  /** When the limit is expected to clear (epoch ms), if a reset time was parseable. */
  resetAt?: number;
  /** Which throttling signal classified it (only set when `limited`). */
  reason?: RateLimitReason;
  /** The raw signal text we matched on (the subtype or the offending error line). */
  signal?: string;
}

/** A not-limited result, reused so callers can `=== NOT_LIMITED` cheaply. */
const NOT_LIMITED: RateLimitInfo = { limited: false };

/**
 * TurnResult `subtype`s that mean "the run hit its configured spend ceiling". The CLI
 * has used a couple of spellings across versions, so match a small known set plus any
 * `*max_budget*` subtype defensively.
 */
const BUDGET_SUBTYPES = new Set(["error_max_budget_usd", "error_max_budget", "error_budget_exceeded"]);

/**
 * Lower-cased substrings that classify a piece of error text. Order matters: budget
 * before generic rate-limit (a budget message may also say "limit"), and overload is
 * its own bucket. Each maps to the reason it implies.
 */
const TEXT_SIGNALS: Array<{ needle: string; reason: RateLimitReason }> = [
  { needle: "max_budget", reason: "max_budget" },
  { needle: "budget exceeded", reason: "max_budget" },
  { needle: "exceeded your budget", reason: "max_budget" },
  { needle: "overloaded", reason: "overloaded" },
  { needle: "529", reason: "overloaded" },
  { needle: "rate_limit", reason: "rate_limit" },
  { needle: "rate limit", reason: "rate_limit" },
  { needle: "too many requests", reason: "rate_limit" },
  { needle: "429", reason: "rate_limit" },
];

/**
 * Classify a turn `subtype` alone (no text). Returns the budget reason for a known
 * budget subtype, else null. Generic rate-limit/overload don't have a dedicated
 * subtype — they surface as error text — so they're handled by {@link classifyText}.
 */
export function classifySubtype(subtype: string | null | undefined): RateLimitReason | null {
  if (!subtype) return null;
  const s = subtype.toLowerCase();
  if (BUDGET_SUBTYPES.has(s) || s.includes("max_budget")) return "max_budget";
  return null;
}

/**
 * Classify a free error string. Returns the first matching {@link RateLimitReason}
 * (budget > overload > rate-limit precedence via {@link TEXT_SIGNALS} order), or null
 * when nothing throttling-related is present. Case-insensitive.
 */
export function classifyText(text: string | null | undefined): RateLimitReason | null {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const { needle, reason } of TEXT_SIGNALS) {
    if (t.includes(needle)) return reason;
  }
  return null;
}

/**
 * Parse a reset / retry time out of error text into an epoch-ms timestamp, or
 * undefined when none is present. Understands the common shapes Anthropic/HTTP use:
 *   - `retry-after: 30` or `Please retry after 30 seconds`  -> now + 30s
 *   - `retry-after: 1718500000`  (a unix-seconds deadline > a year of seconds) -> that instant
 *   - `anthropic-ratelimit-*-reset: 2026-06-16T20:00:00Z` or any ISO 8601 instant
 *   - `resets at 2026-06-16T20:00:00Z`
 * `now` is injectable for deterministic tests (defaults to Date.now()).
 */
export function parseResetAt(text: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!text) return undefined;

  // 1) An explicit ISO 8601 instant (a `*-reset` header value, or "resets at <iso>").
  const iso = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const ms = Date.parse(iso[0].replace(" ", "T"));
    if (Number.isFinite(ms)) return ms;
  }

  // 2) A retry-after / "retry after N (seconds)" delay or absolute unix-seconds deadline.
  const retry = text.match(/retry[-\s]?after[:\s]+(\d+)/i) ?? text.match(/retry\s+(?:in|after)\s+(\d+)/i);
  if (retry) {
    const n = Number(retry[1]);
    if (Number.isFinite(n)) {
      // A value larger than ~one year in seconds is almost certainly an absolute
      // unix-SECONDS deadline, not a delay; treat it as an instant. Otherwise it's a
      // delay in seconds from `now`.
      const ONE_YEAR_S = 365 * 24 * 60 * 60;
      return n > ONE_YEAR_S ? n * 1000 : now + n * 1000;
    }
  }

  return undefined;
}

/**
 * Inspect a finished turn (a {@link TurnResult}) OR a raw error string for any
 * rate-limit / max-budget / overloaded signal.
 *
 *  - A TurnResult: classified by its `subtype` first (budget ceiling), then by its
 *    `resultText` (rate-limit / overload error bodies). A non-error success result is
 *    never limited.
 *  - A string: treated as error text (an `onError` message or API error body) and
 *    scanned directly.
 *
 * When limited, also tries to parse a `resetAt` from the available text so a face can
 * schedule a resume. `now` is injectable for deterministic tests.
 */
export function parseRateLimit(
  resultOrError: TurnResult | string | null | undefined,
  now: number = Date.now(),
): RateLimitInfo {
  if (resultOrError == null) return NOT_LIMITED;

  if (typeof resultOrError === "string") {
    const reason = classifyText(resultOrError);
    if (!reason) return NOT_LIMITED;
    return { limited: true, reason, signal: resultOrError, resetAt: parseResetAt(resultOrError, now) };
  }

  const result = resultOrError;
  // Subtype takes precedence: a budget-ceiling subtype is authoritative.
  const subtypeReason = classifySubtype(result.subtype);
  if (subtypeReason) {
    const text = result.resultText ?? "";
    return {
      limited: true,
      reason: subtypeReason,
      signal: result.subtype,
      resetAt: parseResetAt(text, now),
    };
  }

  // Otherwise look at the error body (only meaningful on an error result; a clean
  // success never carries a throttling message).
  if (result.isError || result.resultText) {
    const text = result.resultText ?? "";
    const reason = classifyText(text);
    if (reason) {
      return { limited: true, reason, signal: text, resetAt: parseResetAt(text, now) };
    }
  }

  return NOT_LIMITED;
}
