/**
 * A single BOUNDED per-project aggregate for a project deep-dive view.
 *
 * One project page wants several rollups at once — headline totals, a per-model
 * split, the top tools, a recent daily-cost series, and the tag cloud. Computing
 * each from a fresh per-session scan would be O(sessions) work done five times over.
 * Instead this assembles the overview from a FEW bounded queries, reusing the engine's
 * existing rollup machinery rather than re-deriving any of it:
 *
 *  - headline + byModel: one `GROUP BY model` over the project's sessions (the
 *    `idx_sessions_project` index narrows to the project; the grouping is O(distinct
 *    models), not O(sessions)). This mirrors how `aggregates.usageByModel` prices each
 *    model bucket, just scoped to one projectId — each session is priced by its OWN
 *    model tier via {@link costUsd}, then summed into that model's bucket. Headline
 *    totals (sessionCount/tokens/cost/firstTs/lastTs) fall out of the same grouped rows.
 *  - topTools: REUSES {@link toolStats} scoped to the project (its single indexed
 *    `GROUP BY toolName`), capped to a small top-N.
 *  - dailyCost: REUSES {@link dailyUsage} scoped to the project + a `since` lower bound,
 *    so it's the same per-session-day rollup the dashboard chart uses, last ~30 days.
 *  - tagCloud: one indexed join of `session_meta` -> `sessions` on the project, then the
 *    (small) JSON tag arrays are counted in JS — bounded by the project's session count,
 *    no transcript reads.
 *
 * Nothing here loops a query per session. An unknown projectId yields a well-formed
 * EMPTY overview (zeros + empty arrays), never a throw — the caller can render it as-is.
 *
 * Read-only module over the live DB handle, in the rollups.ts / tool-stats.ts style;
 * delegated by `TranscriptIndex.projectOverview` and surfaced on `Engine.projectOverview`.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { costUsd } from "./pricing.js";
import { projectName } from "./paths.js";
import { parseTags } from "./tags.js";
import { dailyUsage } from "./rollups.js";
import { toolStats } from "./tool-stats.js";
import type { TokenUsage } from "./types.js";

/** How many days of the daily-cost series to return (today + the prior 29, UTC). */
const DAILY_WINDOW_DAYS = 30;
/** Cap on the ranked tools surfaced in the overview (the full set still lives in toolStats). */
const TOP_TOOLS_LIMIT = 10;

/** One model's slice of a project's usage (token total + approximate USD + session count). */
export interface ProjectModelUsage {
  /** The model id ("unknown" for sessions with no recorded model). */
  model: string;
  /** Sessions on this model within the project. */
  sessions: number;
  /** Total tokens (all four buckets) attributed to this model. */
  tokens: number;
  /** APPROXIMATE summed USD spend for this model (per-session costUsd). */
  costUsd: number;
}

/** One tool's headline count for the project (a trimmed {@link ToolStat}). */
export interface ProjectTopTool {
  /** The invoked tool's name. */
  toolName: string;
  /** Invocations within the project. */
  count: number;
  /** Failed-invocation rate in 0..1 — real for (re)indexed sessions, 0 otherwise. */
  errorRate: number;
}

/** One day's spend/tokens for the project (a trimmed {@link DailyUsage}). */
export interface ProjectDailyCost {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** APPROXIMATE summed USD spend for the day. */
  costUsd: number;
  /** Total tokens (all four buckets) for the day. */
  tokens: number;
}

/** One tag and how many of the project's sessions carry it. */
export interface ProjectTag {
  tag: string;
  count: number;
}

/** The assembled deep-dive overview for one project. */
export interface ProjectOverview {
  /** Stable projectId (sha1 of cwd) — echoed back even for an unknown project. */
  projectId: string;
  /** True cwd of the project, or null when the project isn't indexed. */
  cwd: string | null;
  /** Display name (last cwd segment), or null when unknown. */
  name: string | null;
  /** Sessions indexed under this project. */
  sessionCount: number;
  /** APPROXIMATE total USD spend across the project (per-session model-priced). */
  totalCostUsd: number;
  /** Total tokens (all four buckets) across the project. */
  totalTokens: number;
  /** Earliest session first-activity ISO timestamp, or null. */
  firstTs: string | null;
  /** Latest session last-activity ISO timestamp, or null. */
  lastTs: string | null;
  /** Per-model split, sorted by cost descending. */
  byModel: ProjectModelUsage[];
  /** Top tools by invocation count (capped), most-used first. */
  topTools: ProjectTopTool[];
  /** Per-day spend/tokens for the last ~30 days, oldest→newest. */
  dailyCost: ProjectDailyCost[];
  /** Distinct tags in use across the project's sessions, count desc then name asc. */
  tagCloud: ProjectTag[];
}

/** Injectable dependencies for deterministic project-overview aggregation. */
export interface ProjectOverviewOptions {
  /** Supplies the current instant used to anchor the rolling UTC daily-cost window. */
  now?: () => Date;
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

/** Per-model grouped row pulled from the project's sessions (one row per distinct model). */
interface ModelGroupRow {
  model: string | null;
  sessions: number;
  firstTs: string | null;
  lastTs: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** A well-formed empty overview (zeros + empty arrays) for an unknown/never-seen project. */
function emptyOverview(projectId: string): ProjectOverview {
  return {
    projectId,
    cwd: null,
    name: null,
    sessionCount: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    firstTs: null,
    lastTs: null,
    byModel: [],
    topTools: [],
    dailyCost: [],
    tagCloud: [],
  };
}

/** `YYYY-MM-DD` for the UTC day exactly `daysAgo` days before `now` (0 = its UTC day). */
function utcDayString(now: Date, daysAgo: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Assemble the deep-dive overview for one project in a FEW bounded queries (NOT a
 * per-session loop):
 *
 *  1. ONE `GROUP BY model` over the project's sessions (indexed on projectId) yields the
 *     per-model buckets AND, summed in JS over that tiny grouped set, the headline
 *     sessionCount/tokens/cost/firstTs/lastTs. Each model bucket is priced as the prior
 *     sessions were — but we price the GROUPED token sums per model here (one costUsd per
 *     model row), since all sessions in a bucket share the model's tier; that matches
 *     `usageByModel`'s per-model total to within float noise.
 *  2. {@link toolStats} scoped to the project (a single indexed `GROUP BY toolName`),
 *     capped to the top-N tools.
 *  3. {@link dailyUsage} scoped to the project + a 30-day `since` lower bound (the same
 *     per-session-day rollup the dashboard uses).
 *  4. ONE indexed join of `session_meta` -> `sessions` on the project to read the (small)
 *     JSON tag arrays, counted in JS for the tag cloud.
 *
 * An unknown projectId (no matching session row) short-circuits to {@link emptyOverview}
 * after step 1 finds nothing — zeros + empty arrays, never a throw.
 */
export function projectOverview(
  db: SqliteDatabase,
  projectId: string,
  options: ProjectOverviewOptions = {},
): ProjectOverview {
  // (1) Per-model grouping over just this project's sessions — O(distinct models) rows,
  //     the projectId index narrows the scan. firstTs/lastTs come from MIN/MAX in SQL.
  const modelRows = db
    .prepare(
      `SELECT
         model,
         COUNT(*) AS sessions,
         MIN(firstTs) AS firstTs,
         MAX(lastTs) AS lastTs,
         SUM(inputTokens) AS inputTokens,
         SUM(outputTokens) AS outputTokens,
         SUM(cacheReadTokens) AS cacheReadTokens,
         SUM(cacheCreationTokens) AS cacheCreationTokens
       FROM sessions
       WHERE projectId = ?
       GROUP BY model`,
    )
    .all(projectId) as unknown as ModelGroupRow[];

  // No session rows for this project -> a well-formed empty overview (never throw).
  if (modelRows.length === 0) return emptyOverview(projectId);

  let sessionCount = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  const byModel: ProjectModelUsage[] = [];

  for (const r of modelRows) {
    const usage: TokenUsage = {
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      cacheReadTokens: num(r.cacheReadTokens),
      cacheCreationTokens: num(r.cacheCreationTokens),
    };
    const tokens =
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
    const cost = costUsd(r.model, usage);
    const sessions = num(r.sessions);

    byModel.push({ model: r.model ?? "unknown", sessions, tokens, costUsd: cost });

    sessionCount += sessions;
    totalTokens += tokens;
    totalCostUsd += cost;
    // ISO timestamps sort lexicographically, so min/max-by-compare picks the true bound.
    if (r.firstTs && (firstTs === null || r.firstTs < firstTs)) firstTs = r.firstTs;
    if (r.lastTs && (lastTs === null || r.lastTs > lastTs)) lastTs = r.lastTs;
  }
  byModel.sort((a, b) => b.costUsd - a.costUsd);

  // The project's cwd/name: a single grouped row already has it (all sessions in a project
  // share one cwd). MIN(cwd) mirrors the rollups.ts convention; null only if every row's
  // cwd is null (a project with no cwd can't really happen, but stay defensive).
  const cwdRow = db
    .prepare("SELECT MIN(cwd) AS cwd FROM sessions WHERE projectId = ?")
    .get(projectId) as { cwd: string | null } | undefined;
  const cwd = cwdRow?.cwd ?? null;

  // (2) Top tools — reuse the existing bounded toolStats GROUP BY, scoped + capped.
  const tools = toolStats(db, { projectId, limit: TOP_TOOLS_LIMIT });
  const topTools: ProjectTopTool[] = tools.tools.map((t) => ({
    toolName: t.toolName,
    count: t.count,
    errorRate: t.errorRate,
  }));

  // (3) Daily cost — reuse the existing dailyUsage rollup, scoped to the project, over the
  //     last DAILY_WINDOW_DAYS UTC days (since-bound keeps the window bounded).
  const now = options.now?.() ?? new Date();
  const since = utcDayString(now, DAILY_WINDOW_DAYS - 1);
  const dailyCost: ProjectDailyCost[] = dailyUsage(db, { projectId, since }).map((d) => ({
    day: d.date,
    costUsd: d.costUsd,
    tokens:
      d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens,
  }));

  // (4) Tag cloud — one indexed join (session_meta -> sessions on projectId) reads the
  //     small JSON tag arrays for THIS project's sessions; counted in JS. Bounded by the
  //     project's tagged-session count, no transcript reads.
  const tagRows = db
    .prepare(
      `SELECT m.tags AS tags
       FROM session_meta m
       JOIN sessions s ON s.sessionId = m.sessionId
       WHERE s.projectId = ? AND m.tags IS NOT NULL`,
    )
    .all(projectId) as unknown as Array<{ tags: string | null }>;
  const tagCounts = new Map<string, number>();
  for (const row of tagRows) {
    for (const t of parseTags(row.tags)) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  const tagCloud: ProjectTag[] = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return {
    projectId,
    cwd,
    name: cwd ? projectName(cwd) : null,
    sessionCount,
    totalCostUsd,
    totalTokens,
    firstTs,
    lastTs,
    byModel,
    topTools,
    dailyCost,
    tagCloud,
  };
}
