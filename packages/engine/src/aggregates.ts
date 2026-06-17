/**
 * Project + stats rollups computed with SQL `GROUP BY` rather than JS iteration
 * over every session row.
 *
 * The old `getProjects`/`getStats` pulled every row into memory and summed in JS.
 * That's O(allSessions) work on every dashboard/project-list read. Here the engine
 * (SQLite) does the grouping: per-project token sums, last-activity, session count,
 * and the inputs for per-project / per-model cost. We then price the (small,
 * already-grouped) buckets in JS — pricing depends on per-session model, so the
 * money math stays in TS, but the heavy row-summing does not.
 *
 * A tiny in-memory cache holds the last computed rollups; it's invalidated whenever
 * the index writes (a session is added/updated). Reads between writes are free.
 *
 * IMPORTANT: output shape + ordering MUST stay identical to the prior JS version —
 * faces depend on it. The cost/usage-by-model helpers feed `Engine.getStats`; the
 * project rollup feeds `TranscriptIndex.getProjects`.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import path from "node:path";
import { costUsd } from "./pricing.js";
import type { TokenUsage } from "./types.js";

/** One project's purely-numeric rollup (no metadata decoration yet). */
export interface ProjectRollup {
  projectId: string;
  /** True cwd, taken from the project's sessions (all share one cwd by projectId). */
  cwd: string;
  sessionCount: number;
  lastActivity: string | null;
  totalUsage: TokenUsage;
  /** ~/.claude/projects folder basenames that map to this project (usually one). */
  encodedFolders: string[];
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

/**
 * SQLite dirname: `rtrim(filePath, <filePath without slashes>)` strips the trailing
 * basename chars, leaving the directory (with its trailing slash). DISTINCT collapses
 * to the small per-project folder set rather than one row per session.
 */
const DIRNAME_SQL = "rtrim(filePath, replace(filePath, '/', ''))";

interface RollupRow {
  projectId: string;
  cwd: string;
  sessionCount: number;
  lastActivity: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface CostRow {
  projectId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Per-project numeric rollups, grouped in SQL. Only sessions with both a projectId
 * and a cwd participate (matching the prior JS filter). Ordering of the returned
 * array is not significant — callers re-sort after decorating with metadata.
 */
export function projectRollups(db: SqliteDatabase): ProjectRollup[] {
  const rows = db
    .prepare(
      `SELECT
         projectId,
         MIN(cwd) AS cwd,
         COUNT(*) AS sessionCount,
         MAX(lastTs) AS lastActivity,
         SUM(inputTokens) AS inputTokens,
         SUM(outputTokens) AS outputTokens,
         SUM(cacheReadTokens) AS cacheReadTokens,
         SUM(cacheCreationTokens) AS cacheCreationTokens
       FROM sessions
       WHERE projectId IS NOT NULL AND cwd IS NOT NULL
       GROUP BY projectId`,
    )
    .all() as unknown as RollupRow[];

  // Distinct directories per project (a tiny set — one per ~/.claude/projects folder),
  // so the encoded-folder basenames are computed without scanning every session row.
  const dirRows = db
    .prepare(
      `SELECT DISTINCT projectId, ${DIRNAME_SQL} AS dir
       FROM sessions
       WHERE projectId IS NOT NULL AND cwd IS NOT NULL`,
    )
    .all() as unknown as Array<{ projectId: string; dir: string }>;
  const foldersById = new Map<string, string[]>();
  for (const r of dirRows) {
    // dir keeps its trailing slash; basename of the slash-stripped dir is the folder.
    const folder = path.basename(r.dir.replace(/[/\\]+$/, ""));
    const list = foldersById.get(r.projectId) ?? [];
    if (!list.includes(folder)) list.push(folder);
    foldersById.set(r.projectId, list);
  }

  return rows.map((r) => ({
    projectId: r.projectId,
    cwd: r.cwd,
    sessionCount: num(r.sessionCount),
    lastActivity: r.lastActivity,
    totalUsage: {
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      cacheReadTokens: num(r.cacheReadTokens),
      cacheCreationTokens: num(r.cacheCreationTokens),
    },
    encodedFolders: foldersById.get(r.projectId) ?? [],
  }));
}

/**
 * APPROXIMATE USD cost per project, priced PER SESSION (each session's own model
 * picks its tier) then summed by projectId. Null projectId buckets under "unknown".
 * Same contract as the prior `getCostByProject`.
 */
export function costByProject(db: SqliteDatabase): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT projectId, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens
       FROM sessions`,
    )
    .all() as unknown as CostRow[];
  const byProject = new Map<string, number>();
  for (const r of rows) {
    const cost = costUsd(r.model, {
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      cacheReadTokens: num(r.cacheReadTokens),
      cacheCreationTokens: num(r.cacheCreationTokens),
    });
    const id = r.projectId ?? "unknown";
    byProject.set(id, (byProject.get(id) ?? 0) + cost);
  }
  return byProject;
}

/**
 * APPROXIMATE usage rolled up by model: token total, USD cost, and session count
 * per model. Each session priced by its own model; null/unknown models bucket under
 * "unknown". Sorted by cost descending. Same contract as the prior `getUsageByModel`.
 */
export function usageByModel(
  db: SqliteDatabase,
): Array<{ model: string; tokens: number; costUsd: number; sessions: number }> {
  const rows = db
    .prepare(
      `SELECT model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens
       FROM sessions`,
    )
    .all() as unknown as CostRow[];
  const byModel = new Map<string, { tokens: number; costUsd: number; sessions: number }>();
  for (const r of rows) {
    const usage = {
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      cacheReadTokens: num(r.cacheReadTokens),
      cacheCreationTokens: num(r.cacheCreationTokens),
    };
    const key = r.model ?? "unknown";
    const tokens =
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
    const acc = byModel.get(key) ?? { tokens: 0, costUsd: 0, sessions: 0 };
    acc.tokens += tokens;
    acc.costUsd += costUsd(r.model, usage);
    acc.sessions += 1;
    byModel.set(key, acc);
  }
  return [...byModel.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * A small, invalidate-on-write cache over the rollups above. The index calls
 * {@link invalidate} after any session write so a stale rollup is never served.
 * Each getter memoizes until the next invalidation.
 */
export class AggregateCache {
  private projects?: ProjectRollup[];
  private cost?: Map<string, number>;
  private byModel?: Array<{ model: string; tokens: number; costUsd: number; sessions: number }>;

  constructor(private readonly db: SqliteDatabase) {}

  /** Drop all memoized rollups. Cheap; called on every index write. */
  invalidate(): void {
    this.projects = undefined;
    this.cost = undefined;
    this.byModel = undefined;
  }

  projectRollups(): ProjectRollup[] {
    return (this.projects ??= projectRollups(this.db));
  }

  costByProject(): Map<string, number> {
    return (this.cost ??= costByProject(this.db));
  }

  usageByModel(): Array<{ model: string; tokens: number; costUsd: number; sessions: number }> {
    return (this.byModel ??= usageByModel(this.db));
  }
}
