/**
 * Per-tool usage analytics, computed from the index with bounded GROUP BY aggregates
 * rather than any per-row / per-tool / per-session scan.
 *
 * TWO SOURCES, in priority order:
 *
 *  1. The `tool_calls` SIDECAR (W28). Indexing records one row per assistant `tool_use`
 *     in a regular table — `(sessionId, seq, toolName, isError, ts, durationMs)` — paired
 *     with its `tool_result`'s `is_error` flag and a use→result timestamp delta. Because
 *     it's a regular table (not the fixed-column FTS5 mirror), it can persist the two
 *     signals the mirror can't, so toolStats reports REAL `errorCount`/`errorRate`/`avgMs`
 *     for any (re)indexed session. The per-tool rollup is a single `GROUP BY toolName`
 *     with `COUNT`/`SUM(isError)`/`AVG(durationMs)` over an index on `toolName` (and
 *     `sessionId` for per-session scoping) — one bounded aggregate, O(distinct tools) rows.
 *
 *  2. The message-text MIRROR fallback. `tool_calls` only populates for sessions indexed
 *     AFTER W28; older un-reindexed sessions have no rows there yet (a forced reindex
 *     backfills them). To never regress, when `tool_calls` holds NOTHING for the scope we
 *     fall back to the original `COUNT(*) ... GROUP BY toolName` over the mirror's
 *     `role="tool"` invocation rows (`toolName` set) — the same count the pre-W28 code
 *     returned, with `errorCount`/`errorRate` 0 and `avgMs` omitted (the mirror can't
 *     derive them). So a partially-reindexed corpus degrades gracefully, never to nothing.
 *
 * Optional scoping narrows the SAME aggregate in either source: `sessionId` filters on the
 * row's own `sessionId`; `projectId` joins once to `sessions` (a tiny indexed join,
 * projectId is indexed). `limit` caps the ranked output. A tool-less corpus (or a scope
 * that matches nothing in either source) returns [] with a zeroed totals summary.
 *
 * Mirrors the read-only-rollup style of rollups.ts/aggregates.ts: a module function
 * over the live DB handle, delegated by `TranscriptIndex.toolStats` and surfaced on
 * `Engine.toolStats`.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";

/** Scoping options for {@link toolStats}. All optional; an empty object covers the whole corpus. */
export interface ToolStatsOptions {
  /** Restrict to one project (stable projectId / sha1 of cwd). */
  projectId?: string;
  /** Restrict to a single session by id. */
  sessionId?: string;
  /** Cap the ranked result to the top-N tools by invocation count (1..200). Unset = all. */
  limit?: number;
}

/** One tool's usage rollup. */
export interface ToolStat {
  /** The invoked tool's name (e.g. "Bash", "Edit", an MCP tool id). */
  toolName: string;
  /** How many times this tool was invoked across the (scoped) corpus. */
  count: number;
  /**
   * Invocations that failed (the matching `tool_result` was flagged `is_error`). Real
   * for sessions indexed under W28's `tool_calls` sidecar; 0 for the message-text-mirror
   * fallback (older un-reindexed sessions), which can't derive an error signal.
   */
  errorCount: number;
  /** `errorCount / count` in 0..1 (0 when count is 0). */
  errorRate: number;
  /**
   * Average call duration in ms (use→result timestamp delta), OMITTED when not derivable.
   * Real for `tool_calls`-backed scopes where calls carried a usable timestamp pair;
   * omitted (undefined) for the mirror fallback and for tools with no timed call.
   */
  avgMs?: number;
}

/** Corpus-wide totals accompanying the ranked per-tool array. */
export interface ToolStatsSummary {
  /** Distinct tool names seen in scope. */
  tools: number;
  /** Total tool invocations in scope (sum of every tool's `count`). */
  totalInvocations: number;
  /** Total failed invocations in scope (sum of every tool's `errorCount`). */
  totalErrors: number;
  /** `totalErrors / totalInvocations` in 0..1 (0 when none). */
  errorRate: number;
}

/** The full result of {@link toolStats}: a ranked per-tool array plus corpus totals. */
export interface ToolStatsResult {
  /** Per-tool rollups, ranked by `count` desc, then `toolName` asc. Capped by `opts.limit`. */
  tools: ToolStat[];
  /** Corpus-wide totals over the (scoped) tools. */
  summary: ToolStatsSummary;
}

/** Clamp bounds for the optional result cap (mirrors search/related clamp style). */
const MAX_LIMIT = 200;

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

/** The active mirrored-text table for this DB (FTS5 virtual table or the LIKE fallback). */
function textTable(db: SqliteDatabase): string {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='messages_fts'")
    .get() as { name?: string } | undefined;
  return row?.name === "messages_fts" ? "messages_fts" : "messages_text";
}

/** True when this DB has the W28 `tool_calls` sidecar table (a fresh/migrated DB does). */
function hasToolCallsTable(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'")
    .get() as { name?: string } | undefined;
  return row?.name === "tool_calls";
}

/** Empty result (tool-less corpus, or a scope matching nothing). */
function emptyResult(): ToolStatsResult {
  return { tools: [], summary: { tools: 0, totalInvocations: 0, totalErrors: 0, errorRate: 0 } };
}

/** Build the scope WHERE clauses + params for a given alias, optionally joining sessions. */
function scopeClauses(
  alias: string,
  opts: ToolStatsOptions,
): { clauses: string[]; params: string[]; join: string } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (opts.sessionId) {
    clauses.push(`${alias}.sessionId = ?`);
    params.push(opts.sessionId);
  }
  // projectId lives on the sessions row, not the per-call/mirror row; join once (projectId
  // is indexed) only when scoping by it, so the unscoped/per-session path stays single-table.
  const join = opts.projectId ? `JOIN sessions s ON s.sessionId = ${alias}.sessionId` : "";
  if (opts.projectId) {
    clauses.push("s.projectId = ?");
    params.push(opts.projectId);
  }
  return { clauses, params, join };
}

/** Assemble a ToolStatsResult from per-tool rollup rows (sort, total, cap by limit). */
function buildResult(
  rows: Array<{ toolName: string | null; count: number; errorCount: number; avgMs: number | null }>,
  opts: ToolStatsOptions,
): ToolStatsResult {
  let totalInvocations = 0;
  let totalErrors = 0;
  const tools: ToolStat[] = [];
  for (const r of rows) {
    if (!r.toolName) continue; // guarded by the WHERE, but stay defensive
    const count = num(r.count);
    const errorCount = num(r.errorCount);
    totalInvocations += count;
    totalErrors += errorCount;
    const stat: ToolStat = {
      toolName: r.toolName,
      count,
      errorCount,
      errorRate: count > 0 ? errorCount / count : 0,
    };
    // Only attach avgMs when a duration was actually derivable for this tool (AVG over a
    // non-null durationMs); omit it otherwise so the field stays "absent, not zero".
    if (r.avgMs != null) stat.avgMs = Math.round(num(r.avgMs));
    tools.push(stat);
  }

  // Rank: most-used first; ties broken by name so the order is deterministic.
  tools.sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName));

  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_LIMIT)
      : undefined;
  const ranked = limit ? tools.slice(0, limit) : tools;

  return {
    tools: ranked,
    summary: {
      tools: tools.length,
      totalInvocations,
      totalErrors,
      errorRate: totalInvocations > 0 ? totalErrors / totalInvocations : 0,
    },
  };
}

/**
 * Per-tool usage rollup, ranked by invocation count (desc), then name (asc).
 *
 * Prefers the W28 `tool_calls` sidecar (one bounded `GROUP BY toolName` aggregate with
 * `COUNT`/`SUM(isError)`/`AVG(durationMs)` over indexed columns) so `errorRate` + `avgMs`
 * are REAL for (re)indexed sessions. When the sidecar is absent (legacy DB) or holds no
 * row for the scope (the session(s) weren't reindexed under W28 yet), it falls back to the
 * original message-text-mirror COUNT — same per-tool counts as before, errors 0 + avgMs
 * omitted — so the result never regresses to nothing. Both paths sum the (small) per-tool
 * result in JS for the totals: no extra query, no per-row/per-session loop. `sessionId`
 * narrows on the row directly; `projectId` adds a single indexed join to `sessions`.
 * Returns [] (zeroed summary) for a tool-less corpus or an empty scope.
 */
export function toolStats(db: SqliteDatabase, opts: ToolStatsOptions = {}): ToolStatsResult {
  // 1) Prefer the tool_calls sidecar: it carries real isError + duration. A single GROUP
  //    BY over the (toolName)/(sessionId)-indexed table. AVG(durationMs) ignores NULLs, so
  //    a tool with no timed call yields avgMs=null (omitted by buildResult).
  if (hasToolCallsTable(db)) {
    const { clauses, params, join } = scopeClauses("c", opts);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT c.toolName AS toolName,
                COUNT(*) AS count,
                SUM(c.isError) AS errorCount,
                AVG(c.durationMs) AS avgMs
         FROM tool_calls c
         ${join}
         ${where}
         GROUP BY c.toolName`,
      )
      .all(...params) as unknown as Array<{
      toolName: string | null;
      count: number;
      errorCount: number;
      avgMs: number | null;
    }>;
    if (rows.length > 0) return buildResult(rows, opts);
    // No sidecar rows for this scope -> fall through to the mirror count (never regress).
  }

  // 2) Fallback: the message-text mirror's role="tool" invocation rows (tool_result rows
  //    carry toolName=null; subagent rows use a different role). Count only — the mirror
  //    can't derive errors/durations, so errorCount stays 0 and avgMs is omitted.
  const table = textTable(db);
  const { clauses, params, join } = scopeClauses("t", opts);
  clauses.unshift("t.toolName <> ''");
  clauses.unshift("t.toolName IS NOT NULL");
  clauses.unshift("t.role = 'tool'");

  const rows = db
    .prepare(
      `SELECT t.toolName AS toolName, COUNT(*) AS count
       FROM ${table} t
       ${join}
       WHERE ${clauses.join(" AND ")}
       GROUP BY t.toolName`,
    )
    .all(...params) as unknown as Array<{ toolName: string | null; count: number }>;

  if (rows.length === 0) return emptyResult();

  return buildResult(
    rows.map((r) => ({ toolName: r.toolName, count: r.count, errorCount: 0, avgMs: null })),
    opts,
  );
}
