/**
 * Stable-rowid write path for the `tool_calls` analytics sidecar (the regular table
 * that lets toolStats report real error rates + durations, which the FTS mirror can't).
 *
 * This is the EXACT same discipline as fts-write.ts: every persisted row gets a
 * DETERMINISTIC, STABLE rowid derived from its identity within the session —
 * `(sessionId, seq, ordinal)` — so the SAME logical tool call always lands on the SAME
 * rowid. A re-index is then an idempotent UPSERT keyed by rowid (an unchanged call
 * re-inserts onto its own rowid, a genuinely new call gets a fresh one), and an
 * incremental append only inserts the new calls — never duplicating an existing one.
 *
 * Why a SEPARATE rowid derivation from fts-write's: a ToolCall's identity is
 * `(seq, ordinal)` only (one tool call per assistant tool_use block), whereas a search
 * row keys on `(seq, role, ordinal, text)`. Keeping the key in lockstep with the
 * accumulation order means re-scanning unchanged bytes reproduces identical rowids.
 *
 * ROWID DERIVATION matches fts-write.ts: a sha1 over the identity string, folded to
 * 52 bits so the rowid stays inside JS's safe-integer range, never 0.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { createHash } from "node:crypto";
import type { ToolCall } from "./parse-session.js";

/** The regular sidecar table name. */
export const TOOL_CALLS_TABLE = "tool_calls";

/**
 * Deterministic 52-bit positive rowid for a tool call, from its identity within the
 * session: `sessionId\0seq\0ordinal`. The duration/isError are NOT folded in (unlike
 * fts-write, which folds text) — a call's identity is its POSITION, and re-pairing the
 * same call with its result mustn't relocate the row, so a re-index overwrites the same
 * rowid in place with the (re-derived, identical) is_error + duration.
 */
export function stableToolCallRowid(sessionId: string, seq: number, ordinal: number): bigint {
  const h = createHash("sha1").update(`${sessionId}\0${seq}\0${ordinal}`).digest();
  let v = h.readBigUInt64BE(0) & 0xfffffffffffffn;
  if (v === 0n) v = 1n;
  return v;
}

/**
 * Write a session's tool calls onto STABLE rowids (the incremental-friendly path),
 * matching {@link writeFtsRows}:
 *  - `full` (a full re-index, startByte===0): clear the session's existing rows first,
 *    then insert every call on its stable rowid. Idempotent: identical end state to a
 *    DELETE+insert, but the rowids are reproducible so a re-index never duplicates.
 *  - `!full` (incremental append): do NOT clear; INSERT OR REPLACE each call onto its
 *    stable rowid, so re-inserting an already-present call is an idempotent overwrite
 *    rather than a duplicate.
 *
 * Runs inside the caller's transaction (no BEGIN/COMMIT here). Returns the rows written.
 */
export function writeToolCalls(
  db: SqliteDatabase,
  sessionId: string,
  calls: ToolCall[],
  full: boolean,
): number {
  if (full) {
    db.prepare(`DELETE FROM ${TOOL_CALLS_TABLE} WHERE sessionId = ?`).run(sessionId);
  }
  if (calls.length === 0) return 0;
  // INSERT OR REPLACE onto the explicit stable rowid: an unchanged call replaces itself
  // (same content), a new call inserts. This is what makes a re-index idempotent (no dup)
  // and an incremental append non-disturbing of the prior calls.
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ${TOOL_CALLS_TABLE}
       (rowid, sessionId, seq, toolName, isError, ts, durationMs)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const c of calls) {
    insert.run(
      stableToolCallRowid(sessionId, c.seq, c.ordinal),
      sessionId,
      c.seq,
      c.toolName,
      c.isError,
      c.ts,
      c.durationMs,
    );
    n++;
  }
  return n;
}
