/**
 * Per-tool usage analytics, computed from the index with a single GROUP BY aggregate
 * rather than any per-row / per-tool / per-session scan.
 *
 * The index already mirrors every assistant `tool_use` block as a row in the
 * message-text store (`messages_fts`, or the `messages_text` LIKE fallback): such a
 * row has `role="tool"` and its `toolName` set to the invoked tool (e.g. "Bash",
 * "Edit") — see parse-session.ts `toolTexts`. So "how often was each tool invoked" is
 * exactly a `COUNT(*) ... GROUP BY toolName` over those rows: one indexed aggregate,
 * O(distinct tools) result rows, NOT a loop over sessions or terms.
 *
 * WHAT IS NOT DERIVABLE FROM THE INDEX (and why these fields degrade, not lie):
 *  - ERRORS. A failed tool surfaces only as the matching `tool_result` block's
 *    `is_error` flag (parser.ts), and that flag is NOT persisted — the mirror stores a
 *    `tool_result` body as a SEPARATE row with `toolName=null` (it can't be attributed
 *    to a tool by any indexed column, and the bodies carry no reliable error marker).
 *    So `errorCount`/`errorRate` are reported as 0 here: the shape is kept stable for
 *    callers, but we never fabricate an error signal the index doesn't hold.
 *  - DURATION. The mirror keeps no per-message timestamp (only the session-level
 *    first/last `ts` on the `sessions` row), so no adjacent-timestamp delta is
 *    derivable per tool call. `avgMs` is therefore OMITTED (left undefined) rather
 *    than guessed — exactly the graceful-degradation contract.
 *
 * Optional scoping narrows the SAME single aggregate: `sessionId` filters on the
 * mirror row's own `sessionId`; `projectId` joins once to `sessions` (a tiny indexed
 * join, projectId is indexed). `limit` caps the ranked output. A tool-less corpus
 * (or a scope that matches nothing) returns [] with a zeroed totals summary.
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
   * Invocations that failed. Always 0 today: the index does not persist the
   * `tool_result.is_error` flag, so an error signal cannot be derived without
   * fabricating one. The field is kept so the shape is stable if errors are indexed later.
   */
  errorCount: number;
  /** `errorCount / count` in 0..1 (0 when count is 0). Always 0 today (see {@link errorCount}). */
  errorRate: number;
  /**
   * APPROXIMATE average call duration in ms, OMITTED when not derivable. The index
   * keeps no per-message timestamp, so this is currently always omitted (undefined).
   */
  avgMs?: number;
}

/** Corpus-wide totals accompanying the ranked per-tool array. */
export interface ToolStatsSummary {
  /** Distinct tool names seen in scope. */
  tools: number;
  /** Total tool invocations in scope (sum of every tool's `count`). */
  totalInvocations: number;
  /** Total failed invocations in scope. Always 0 today (see {@link ToolStat.errorCount}). */
  totalErrors: number;
  /** `totalErrors / totalInvocations` in 0..1 (0 when none). Always 0 today. */
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

/** Empty result (tool-less corpus, or a scope matching nothing). */
function emptyResult(): ToolStatsResult {
  return { tools: [], summary: { tools: 0, totalInvocations: 0, totalErrors: 0, errorRate: 0 } };
}

/**
 * Per-tool usage rollup, ranked by invocation count (desc), then name (asc).
 *
 * One indexed GROUP BY aggregate over the message-text mirror's `role="tool"`
 * invocation rows produces the per-tool counts; the (small) per-tool result is summed
 * in JS for the totals — no extra query, no per-row/per-session loop. `sessionId`
 * narrows on the mirror row directly; `projectId` adds a single indexed join to
 * `sessions`. Returns [] (zeroed summary) for a tool-less corpus or an empty scope.
 */
export function toolStats(db: SqliteDatabase, opts: ToolStatsOptions = {}): ToolStatsResult {
  const table = textTable(db);

  // Only assistant tool_use rows: role="tool" with a real toolName (tool_result rows
  // carry toolName=null; subagent rows use a different role). These are the invocations.
  const clauses: string[] = ["t.role = 'tool'", "t.toolName IS NOT NULL", "t.toolName <> ''"];
  const params: string[] = [];
  if (opts.sessionId) {
    clauses.push("t.sessionId = ?");
    params.push(opts.sessionId);
  }
  // projectId lives on the sessions row, not the mirror; join once (projectId is indexed)
  // only when scoping by it, so the unscoped/per-session path stays a single-table scan.
  const join = opts.projectId ? `JOIN sessions s ON s.sessionId = t.sessionId` : "";
  if (opts.projectId) {
    clauses.push("s.projectId = ?");
    params.push(opts.projectId);
  }

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

  let totalInvocations = 0;
  const tools: ToolStat[] = [];
  for (const r of rows) {
    if (!r.toolName) continue; // guarded by the WHERE, but stay defensive
    const count = num(r.count);
    totalInvocations += count;
    // errorCount/errorRate stay 0 and avgMs omitted — neither is derivable from the
    // indexed columns (see the file header). Reported, never fabricated.
    tools.push({ toolName: r.toolName, count, errorCount: 0, errorRate: 0 });
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
      totalErrors: 0,
      errorRate: 0,
    },
  };
}
