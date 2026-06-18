/**
 * Index INTEGRITY: a read-only diagnostic over OUR OWN index DB, plus a SAFE repair
 * that prefers RE-DERIVATION (reindex) over destruction.
 *
 * The index is a constellation of one canonical table (`sessions`) and several sidecar
 * tables keyed by `sessionId` that have NO foreign keys to it: the search-text mirror
 * (`messages_fts` / `messages_text`), the per-call analytics sidecar (`tool_calls`),
 * our custom metadata (`session_meta`), and the permission audit log (`permission_audit`).
 * Because there are no FKs, a sidecar row can be ORPHANED — its `sessionId` no longer has
 * a `sessions` row (e.g. a session deleted out from under it, or a half-applied write).
 * A session can also have a present transcript but EMPTY mirrored text (an interrupted
 * index pass), so search silently misses it. And the SQLite file itself can develop
 * page-level corruption. None of these are caught by the normal index path.
 *
 * {@link checkIntegrity} runs a fixed set of BOUNDED diagnostic queries (anti-joins and
 * single aggregates over indexed columns — never a per-row scan or a per-session loop of
 * queries) and reports problems WITHOUT mutating anything. {@link repairIntegrity} fixes
 * what is safely fixable: it deletes only clearly-orphaned sidecar/FTS rows whose parent
 * `sessions` row is GONE (so a delete can never touch a live session's data), and for a
 * session whose transcript still exists but has empty mirrored text it RE-DERIVES the rows
 * by re-running {@link TranscriptIndex.indexSession} (force) — never a destructive guess.
 * It NEVER touches ~/.claude transcripts; it only writes our index DB, inside a single
 * transaction, and is idempotent (a second run finds nothing to do).
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { existsSync } from "node:fs";
import type { TranscriptIndex } from "./index-db.js";

/** A single problem the check surfaced, with how many rows/sessions it affects. */
export interface IntegrityIssue {
  /** Stable machine-readable category (one of the checks below). */
  kind:
    | "orphan-session-meta"
    | "orphan-tool-calls"
    | "orphan-fts"
    | "orphan-audit"
    | "missing-mirror-text"
    | "missing-transcript"
    | "sqlite-corruption";
  /** Human-readable one-line explanation (safe to show in a UI). */
  detail: string;
  /** How many rows / sessions are affected. */
  count: number;
  /** How serious it is: "error" = data-integrity problem; "warning" = recoverable/expected. */
  severity: "error" | "warning";
}

/** Row/aggregate counts captured during the check (for context + a healthy baseline). */
export interface IntegrityCounts {
  sessions: number;
  sessionMeta: number;
  toolCalls: number;
  ftsRows: number;
  auditRows: number;
}

/** The structured result of {@link checkIntegrity}. Read-only; nothing was mutated. */
export interface IntegrityReport {
  /** True when no issues were found (the index is sound). */
  ok: boolean;
  /** When the check ran (ms epoch). */
  checkedAt: number;
  /** SQLite `PRAGMA user_version` — the migration/schema version this DB is on. */
  userVersion: number;
  /** Result of `PRAGMA integrity_check`: "ok" when sound, else the first reported error. */
  sqliteIntegrity: string;
  /** Every problem found (empty when ok). */
  issues: IntegrityIssue[];
  /** Row/aggregate counts captured during the check. */
  counts: IntegrityCounts;
}

/** Options for {@link repairIntegrity}. */
export interface RepairOptions {
  /**
   * When false (the default), repair re-derives missing mirror text by reindexing the
   * session's still-present transcript. When true it SKIPS that reindex step and only
   * removes clearly-orphaned sidecar rows (the purely-destructive-of-orphans subset),
   * for callers that want the fast structural cleanup without any file I/O.
   */
  skipReindex?: boolean;
}

/** What one repair pass did. */
export interface RepairResult {
  /** Orphaned sidecar/FTS rows removed, grouped by which table they came from. */
  repaired: Array<{ kind: IntegrityIssue["kind"]; count: number }>;
  /** Sessions whose missing/empty mirror text was re-derived via a forced reindex. */
  reindexed: number;
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

/**
 * The active mirrored-text table for this DB: the FTS5 virtual table when present, else
 * the plain LIKE table. Same probe tool-stats.ts uses, so the integrity check looks at
 * whichever backend search actually runs against.
 */
function textTable(db: SqliteDatabase): string {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='messages_fts'")
    .get() as { name?: string } | undefined;
  return row?.name === "messages_fts" ? "messages_fts" : "messages_text";
}

/** True when a regular/virtual table named `table` exists (sidecars are optional on legacy DBs). */
function hasTable(db: SqliteDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?")
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

/** A single COUNT(*) over a table (0 when the table is absent). */
function countRows(db: SqliteDatabase, table: string): number {
  if (!hasTable(db, table)) return 0;
  return num((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: unknown }).c);
}

/**
 * COUNT of rows in `child` whose `sessionId` has NO matching `sessions` row — the orphan
 * count. A single anti-join aggregate over the child's `sessionId` index (idx_tool_calls_session
 * / idx_messages_text_session / session_meta's PK) — bounded, never a per-row scan. The FTS5
 * virtual table has no btree index on sessionId, but FTS5 answers this column read directly,
 * and we still issue ONE aggregate (not one query per row/session). Returns 0 when `child` is
 * absent (a legacy DB may lack a sidecar).
 */
function orphanCount(db: SqliteDatabase, child: string): number {
  if (!hasTable(db, child)) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${child} c
       WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.sessionId = c.sessionId)`,
    )
    .get() as { c: unknown };
  return num(row.c);
}

/**
 * COUNT of DISTINCT sessions that have a transcript path but ZERO mirrored search rows —
 * a session search would silently miss (an interrupted/half-applied index pass). One
 * anti-join aggregate over the active mirror's `sessionId`, scoped to sessions that
 * actually carry text (messageCount > 0) so a genuinely empty session isn't flagged. Also
 * returns the affected sessionIds (capped) so repair can reindex only those, never a scan.
 */
function missingMirror(
  db: SqliteDatabase,
  table: string,
  limit: number,
): { count: number; sessionIds: string[] } {
  const where = `s.messageCount > 0
       AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.sessionId = s.sessionId)`;
  const count = num(
    (db.prepare(`SELECT COUNT(*) AS c FROM sessions s WHERE ${where}`).get() as { c: unknown }).c,
  );
  const rows = db
    .prepare(`SELECT s.sessionId AS sessionId FROM sessions s WHERE ${where} LIMIT ?`)
    .all(limit) as Array<{ sessionId: string }>;
  return { count, sessionIds: rows.map((r) => r.sessionId) };
}

/**
 * Sessions whose on-disk transcript file (`sessions.filePath`) is missing. We read every
 * (sessionId, filePath) pair once — bounded by the session count, a single indexed select,
 * not a per-row query — and `existsSync` each. A missing transcript is expected after
 * Claude Code's ~30-day auto-delete (we keep a gzip archive), so it is a WARNING, never an
 * error, and is NEVER repaired by deleting the session — the session row is a permanent
 * archive of metadata. Capped at `limit` reported sessionIds.
 */
function missingTranscripts(db: SqliteDatabase, limit: number): { count: number; sessionIds: string[] } {
  const rows = db
    .prepare("SELECT sessionId, filePath FROM sessions WHERE filePath IS NOT NULL")
    .all() as Array<{ sessionId: string; filePath: string }>;
  const missing: string[] = [];
  for (const r of rows) {
    if (!existsSync(r.filePath)) missing.push(r.sessionId);
  }
  return { count: missing.length, sessionIds: missing.slice(0, limit) };
}

/** Cap on how many sessionIds a single issue carries forward to repair (keeps work bounded). */
const REPAIR_BATCH = 500;

/**
 * Run the full read-only integrity diagnostic over `db`. Mutates nothing. Every check is a
 * single bounded query (anti-join aggregate / one indexed select / a PRAGMA) — there is no
 * per-row or per-session query loop. The active mirror table is resolved the same way
 * search does (FTS5 virtual table else the LIKE table). Returns a structured
 * {@link IntegrityReport}.
 */
export function checkIntegrity(db: SqliteDatabase): IntegrityReport {
  const checkedAt = Date.now();
  const userVersion = num(
    (db.prepare("PRAGMA user_version").get() as { user_version: unknown }).user_version,
  );

  // PRAGMA integrity_check reports "ok" (one row) when sound, else one row per problem;
  // we surface the first message. It is bounded by SQLite (a structural page check), not
  // a query we shape.
  const integrityRows = db.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check?: string;
  }>;
  const firstMsg = integrityRows[0]?.integrity_check ?? "ok";
  const sqliteIntegrity = firstMsg === "ok" ? "ok" : firstMsg;

  const table = textTable(db);
  const issues: IntegrityIssue[] = [];

  // -- Orphaned sidecar rows (parent sessions row is gone) -------------------
  const orphanMeta = orphanCount(db, "session_meta");
  if (orphanMeta > 0) {
    issues.push({
      kind: "orphan-session-meta",
      detail: `${orphanMeta} session_meta row(s) reference a sessionId with no sessions row`,
      count: orphanMeta,
      severity: "error",
    });
  }
  const orphanTools = orphanCount(db, "tool_calls");
  if (orphanTools > 0) {
    issues.push({
      kind: "orphan-tool-calls",
      detail: `${orphanTools} tool_calls row(s) reference a sessionId with no sessions row`,
      count: orphanTools,
      severity: "error",
    });
  }
  const orphanFts = orphanCount(db, table);
  if (orphanFts > 0) {
    issues.push({
      kind: "orphan-fts",
      detail: `${orphanFts} mirrored search row(s) reference a sessionId with no sessions row`,
      count: orphanFts,
      severity: "error",
    });
  }
  // Audit rows may legitimately carry a NULL sessionId (a decision not tied to a session),
  // so only NON-NULL sessionIds with no parent are orphans. A bounded anti-join aggregate.
  let orphanAudit = 0;
  if (hasTable(db, "permission_audit")) {
    orphanAudit = num(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM permission_audit a
             WHERE a.sessionId IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.sessionId = a.sessionId)`,
          )
          .get() as { c: unknown }
      ).c,
    );
    if (orphanAudit > 0) {
      issues.push({
        kind: "orphan-audit",
        detail: `${orphanAudit} permission_audit row(s) reference a sessionId with no sessions row`,
        count: orphanAudit,
        severity: "warning",
      });
    }
  }

  // -- Sessions that should have mirrored text but have none -----------------
  const noText = missingMirror(db, table, REPAIR_BATCH);
  if (noText.count > 0) {
    issues.push({
      kind: "missing-mirror-text",
      detail: `${noText.count} session(s) with messages have zero mirrored search rows`,
      count: noText.count,
      severity: "error",
    });
  }

  // -- Sessions whose on-disk transcript is missing (expected after auto-delete) --
  const noFile = missingTranscripts(db, REPAIR_BATCH);
  if (noFile.count > 0) {
    issues.push({
      kind: "missing-transcript",
      detail: `${noFile.count} session(s) have an on-disk transcript that no longer exists`,
      count: noFile.count,
      severity: "warning",
    });
  }

  // -- SQLite page-level corruption ------------------------------------------
  if (sqliteIntegrity !== "ok") {
    issues.push({
      kind: "sqlite-corruption",
      detail: `PRAGMA integrity_check reported: ${sqliteIntegrity}`,
      count: integrityRows.length,
      severity: "error",
    });
  }

  const counts: IntegrityCounts = {
    sessions: countRows(db, "sessions"),
    sessionMeta: countRows(db, "session_meta"),
    toolCalls: countRows(db, "tool_calls"),
    ftsRows: countRows(db, table),
    auditRows: countRows(db, "permission_audit"),
  };

  return {
    ok: issues.length === 0,
    checkedAt,
    userVersion,
    sqliteIntegrity,
    issues,
    counts,
  };
}

/**
 * SAFELY repair what's fixable, preferring RE-DERIVATION over destruction.
 *
 *  - DELETE clearly-orphaned sidecar/FTS rows whose parent `sessions` row is GONE. Each
 *    delete is gated on `NOT EXISTS (... sessions ...)`, so it can NEVER remove a row whose
 *    session still exists. (Audit orphans only when sessionId is non-null + parent gone.)
 *  - For sessions with a present transcript but empty mirrored text, RE-INDEX them
 *    (force) so the rows are re-derived from disk — never a destructive guess. Skipped when
 *    `opts.skipReindex` is set, or when the transcript no longer exists (can't re-derive).
 *
 * The destructive (orphan-delete) part runs inside a SINGLE transaction so the DB is never
 * left half-cleaned; the reindex part runs after (it manages its own transactions per
 * session via {@link TranscriptIndex.indexSession}). NEVER touches ~/.claude transcripts.
 * Idempotent: a second run finds no orphans and no empty-mirror sessions, so it does nothing.
 */
export async function repairIntegrity(
  index: TranscriptIndex,
  db: SqliteDatabase,
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const table = textTable(db);
  const repaired: RepairResult["repaired"] = [];

  // Discover what's reparable BEFORE mutating, so the deletes below are exactly the rows
  // the check would report (and so the transaction wraps a known, bounded set).
  const orphanMeta = orphanCount(db, "session_meta");
  const orphanTools = orphanCount(db, "tool_calls");
  const orphanFts = orphanCount(db, table);

  // Single transaction for the orphan deletes: all-or-nothing structural cleanup. Each
  // DELETE is gated on the parent sessions row being absent, so a live session is untouchable.
  db.exec("BEGIN");
  try {
    if (orphanMeta > 0) {
      db.exec(
        `DELETE FROM session_meta WHERE sessionId IN (
           SELECT sessionId FROM session_meta
           WHERE sessionId NOT IN (SELECT sessionId FROM sessions)
         )`,
      );
      repaired.push({ kind: "orphan-session-meta", count: orphanMeta });
    }
    if (orphanTools > 0) {
      db.exec(
        `DELETE FROM tool_calls
         WHERE sessionId NOT IN (SELECT sessionId FROM sessions)`,
      );
      repaired.push({ kind: "orphan-tool-calls", count: orphanTools });
    }
    if (orphanFts > 0) {
      db.exec(
        `DELETE FROM ${table}
         WHERE sessionId NOT IN (SELECT sessionId FROM sessions)`,
      );
      repaired.push({ kind: "orphan-fts", count: orphanFts });
    }
    if (hasTable(db, "permission_audit")) {
      const orphanAudit = num(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM permission_audit a
               WHERE a.sessionId IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.sessionId = a.sessionId)`,
            )
            .get() as { c: unknown }
        ).c,
      );
      if (orphanAudit > 0) {
        db.exec(
          `DELETE FROM permission_audit
           WHERE sessionId IS NOT NULL
             AND sessionId NOT IN (SELECT sessionId FROM sessions)`,
        );
        repaired.push({ kind: "orphan-audit", count: orphanAudit });
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Re-derive empty mirrors by reindexing the (still-present) transcript. Done AFTER the
  // orphan-delete transaction so reindex's own per-session transactions don't nest. We
  // reindex ONLY sessions whose transcript file still exists — a missing file can't be
  // re-derived (and is never deleted; the session row stays a metadata archive).
  let reindexed = 0;
  if (!opts.skipReindex) {
    const noText = missingMirror(db, table, REPAIR_BATCH);
    for (const sessionId of noText.sessionIds) {
      const row = db
        .prepare("SELECT filePath FROM sessions WHERE sessionId = ?")
        .get(sessionId) as { filePath: string | null } | undefined;
      const filePath = row?.filePath;
      if (!filePath || !existsSync(filePath)) continue; // can't re-derive a gone transcript
      const result = await index.indexSession(filePath, { force: true });
      if (result === "added" || result === "updated") reindexed++;
    }
  }

  return { repaired, reindexed };
}
