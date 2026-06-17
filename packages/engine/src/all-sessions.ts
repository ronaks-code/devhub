/**
 * Cross-project session listing — the data behind a global "All Sessions" view.
 *
 * Reuses the existing transcript index (one SQL query, no transcript reads) to
 * return {@link SessionSummary}s across EVERY project, with optional filtering
 * (projectId / tag / model) and sorting (recent / tokens / messages) plus
 * limit/offset paging. Kept in its own module so the listing's options/SQL stay
 * separate from the per-project reads in index-db.ts; `TranscriptIndex` owns the
 * db handle and runs the query via {@link listAllSessions}.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { costUsd } from "./pricing.js";
import type { SessionSummary } from "./types.js";

/** Options for a cross-project session listing. All fields optional. */
export interface ListAllSessionsOptions {
  /**
   * Sort order:
   *  - "recent"   (default) — newest last activity first (lastTs desc).
   *  - "tokens"   — most total tokens first.
   *  - "messages" — most messages first.
   *  - "cost"     — highest estimated spend first (per-session {@link costUsd} over
   *    the stored token usage, evaluated per the session's model). Useful for a
   *    "top-spending sessions" dashboard.
   */
  sort?: "recent" | "tokens" | "messages" | "cost";
  /** Only sessions in this project (stable projectId / sha1 of cwd). */
  projectId?: string;
  /** Only sessions carrying this tag (case-insensitive; matched against session_meta.tags). */
  tag?: string;
  /** Only sessions that ran on this model id (exact match against sessions.model). */
  model?: string;
  /** Max rows to return (clamped to 1..500; default 100). */
  limit?: number;
  /** Rows to skip before returning (for paging; default 0). */
  offset?: number;
  /** Include archived sessions (hidden by default). */
  includeArchived?: boolean;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * ORDER BY fragment per SQL-sortable mode. Pinned never floats here (this is a flat
 * global list). "cost" is intentionally absent: it can't be expressed as a SQL
 * column order (it depends on per-model pricing), so {@link listAllSessions} sorts
 * those rows in JS instead — see that function.
 */
const ORDER_BY: Record<"recent" | "tokens" | "messages", string> = {
  recent: "s.lastTs DESC",
  tokens:
    "(s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens) DESC",
  messages: "s.messageCount DESC",
};

/**
 * Build the WHERE clause + positional params for the optional filters. The tag
 * facet matches the JSON-array token in `session_meta.tags` (lower-cased, with
 * LIKE metachars escaped) — mirrors the search module's tag matching.
 */
function whereClause(opts: ListAllSessionsOptions): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  // Archived sessions drop out by default (COALESCE: no meta row => not archived).
  if (!opts.includeArchived) {
    clauses.push("COALESCE(m.archived, 0) = 0");
  }
  if (opts.projectId) {
    clauses.push("s.projectId = ?");
    params.push(opts.projectId);
  }
  if (opts.model) {
    clauses.push("s.model = ?");
    params.push(opts.model);
  }
  const tag = (opts.tag ?? "").trim().toLowerCase();
  if (tag) {
    const escaped = tag.replace(/[\\%_"]/g, (c) => `\\${c}`);
    clauses.push("m.tags LIKE ? ESCAPE '\\'");
    params.push(`%"${escaped}"%`);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * Cross-project session listing. `selectCols` is the index's shared SELECT column
 * list (sessions `s` LEFT JOIN session_meta `m`), and `rowToSummary` maps a raw row
 * to a {@link SessionSummary} — both supplied by `TranscriptIndex` so this module
 * stays free of the row shape. A secondary `s.sessionId` sort makes paging stable
 * when the primary key ties.
 */
export function listAllSessions<Row>(
  db: SqliteDatabase,
  selectCols: string,
  rowToSummary: (row: Row) => SessionSummary,
  opts: ListAllSessionsOptions = {},
): SessionSummary[] {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);
  const { sql: where, params } = whereClause(opts);

  // "cost" can't be a SQL ORDER BY (it needs per-model pricing applied to the token
  // buckets), so fetch the full filtered set, map to summaries, compute each cost
  // with the same `costUsd` the rest of the engine uses, sort desc, then page in JS.
  // The result row count stays bounded by `limit`, matching the SQL paths.
  if (opts.sort === "cost") {
    const all = db
      .prepare(
        `SELECT ${selectCols} FROM sessions s LEFT JOIN session_meta m USING (sessionId)${where}`,
      )
      .all(...params) as unknown as Row[];
    return all
      .map(rowToSummary)
      .map((s) => ({ s, cost: costUsd(s.model, s.usage) }))
      // Highest spend first; ties broken by sessionId for stable paging.
      .sort((a, b) => b.cost - a.cost || (a.s.sessionId < b.s.sessionId ? -1 : 1))
      .slice(offset, offset + limit)
      .map((x) => x.s);
  }

  const order = ORDER_BY[opts.sort ?? "recent"];
  const rows = db
    .prepare(
      `SELECT ${selectCols} FROM sessions s LEFT JOIN session_meta m USING (sessionId)${where}
       ORDER BY ${order}, s.sessionId ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as Row[];
  return rows.map(rowToSummary);
}
