/**
 * Per-day token & cost time series — the data behind a usage/spend chart.
 *
 * Reuses the transcript index (one SQL query, no transcript reads). The index
 * stores per-SESSION aggregates (total token buckets, the session's model, its
 * last-activity timestamp), not per-message timestamps, so each session's totals
 * are bucketed on the UTC calendar day of its `lastTs` — the same "day of last
 * activity" convention the activity sparkline uses. Cost is computed per session
 * with {@link costUsd} so each session is priced by its own model tier, then summed
 * into its day's bucket.
 *
 * Kept in its own module so the query/aggregation stays separate from the
 * per-project reads in index-db.ts; `TranscriptIndex` owns the db handle and runs
 * this via {@link dailyUsage}.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { costUsd } from "./pricing.js";

/** Filters for a daily-usage rollup. All optional; an empty object covers everything. */
export interface DailyUsageOptions {
  /** Lower bound (inclusive) on a session's last-activity ISO timestamp, e.g. "2026-06-01". */
  since?: string;
  /** Upper bound (inclusive) on a session's last-activity ISO timestamp. */
  until?: string;
  /** Restrict to one project (stable projectId / sha1 of cwd). */
  projectId?: string;
}

/** One day's rolled-up token usage, cost, and session count. */
export interface DailyUsage {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** APPROXIMATE summed USD spend for the day (per-session costUsd, model-priced). */
  costUsd: number;
  /** Number of sessions whose last activity fell on this day. */
  sessions: number;
}

function n(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

/** Raw row shape pulled from the sessions table for rollup. */
interface UsageRow {
  lastTs: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Per-day token & cost series, oldest→newest. Each session contributes its totals
 * to the UTC day of its `lastTs`; sessions with no timestamp are skipped (they
 * can't be placed on the calendar). Days with no activity are simply absent — the
 * caller can zero-fill a fixed window if it wants a dense axis.
 *
 * `since`/`until` filter on the same `lastTs`, so a session is included iff its last
 * activity is within the (inclusive) range; `projectId` restricts to one project.
 */
export function dailyUsage(db: SqliteDatabase, opts: DailyUsageOptions = {}): DailyUsage[] {
  const clauses: string[] = ["lastTs IS NOT NULL"];
  const params: string[] = [];
  if (opts.since) {
    clauses.push("lastTs >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    clauses.push("lastTs <= ?");
    params.push(opts.until);
  }
  if (opts.projectId) {
    clauses.push("projectId = ?");
    params.push(opts.projectId);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT lastTs, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens
       FROM sessions${where}`,
    )
    .all(...params) as unknown as UsageRow[];

  const byDay = new Map<string, DailyUsage>();
  for (const r of rows) {
    // ISO `lastTs` is already `YYYY-MM-DD...` in UTC; the first 10 chars are the day.
    const day = (r.lastTs ?? "").slice(0, 10);
    if (day.length !== 10) continue;
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = {
        date: day,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        sessions: 0,
      };
      byDay.set(day, bucket);
    }
    const usage = {
      inputTokens: n(r.inputTokens),
      outputTokens: n(r.outputTokens),
      cacheReadTokens: n(r.cacheReadTokens),
      cacheCreationTokens: n(r.cacheCreationTokens),
    };
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
    bucket.cacheReadTokens += usage.cacheReadTokens;
    bucket.cacheCreationTokens += usage.cacheCreationTokens;
    bucket.costUsd += costUsd(r.model, usage);
    bucket.sessions += 1;
  }

  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
