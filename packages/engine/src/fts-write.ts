/**
 * Stable-rowid write path for the message-text search store (FTS5 / LIKE table).
 *
 * THE PROBLEM. The original per-session write (index-db.ts `writeSearchText`) replaces
 * a session's search rows wholesale on a FULL pass: `DELETE FROM messages_fts WHERE
 * sessionId = ?` then re-insert every row. On an incremental append that's fine
 * (it appends), but any full re-index (a prefix rewrite, a tokenizer rebuild, a
 * re-scan) churns EVERY row of the session even though most are byte-for-byte the same
 * as last pass. For a large session that is a lot of needless FTS index work.
 *
 * THE FIX. Give every mirrored row a DETERMINISTIC, STABLE rowid derived from its
 * identity within the session — `(sessionId, role, seq, ordinal-within-(seq,role))`
 * plus the row text — so the SAME logical row always lands on the SAME rowid. Then a
 * re-index becomes an idempotent UPSERT keyed by rowid:
 *
 *   - a row that is unchanged re-inserts onto its own rowid (a no-op replace),
 *   - a genuinely NEW appended row gets a fresh rowid and is inserted,
 *   - nothing else in the session is disturbed.
 *
 * This keeps `search()` results IDENTICAL to the full-replace approach: the same set
 * of (sessionId, role, seq, toolName, text) tuples is present afterward, just without
 * deleting+reinserting the rows that didn't change. The rowid is an internal detail —
 * search never exposes or orders by it (it ranks by bm25/seq), so making it stable is
 * invisible to callers.
 *
 * ROWID DERIVATION. SQLite rowids are signed 63-bit integers, but we deliberately
 * fold the hash down to 52 bits so every rowid stays within JS's safe-integer range
 * (Number.MAX_SAFE_INTEGER). Search never reads the rowid into JS (it only joins on it
 * inside SQL), so 52 vs 63 bits is invisible to results — but staying safe-integer
 * sized means any future code that DOES read a rowid can't silently overflow. The
 * identity key INCLUDES the text, so if a row's text ever changes the rowid moves (old
 * row is left for the caller's reconcile/replace step) — but for append-only
 * transcripts (the normal case) prior rows never change, so their rowids are stable
 * pass-over-pass. The tiny theoretical hash-collision risk only ever costs an
 * over-write of one row's text with identical-key content; it can never corrupt
 * another session's rows (the sessionId is part of the key).
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { createHash } from "node:crypto";
import type { SearchText } from "./parse-session.js";

/** A mirrored search row plus the columns the store carries (matches FTS_COLUMNS order). */
export interface FtsRow {
  sessionId: string;
  role: string;
  seq: number;
  toolName: string | null;
  text: string;
}

/**
 * Deterministic 63-bit positive rowid for a mirrored row, from its identity within the
 * session. `ordinal` disambiguates rows that share the same (seq, role) — e.g. a single
 * assistant message can emit several role="tool" rows at the same seq, so the caller
 * passes 0,1,2,… in their stable insertion order. The text is folded in too so a
 * changed body relocates rather than silently shadowing the old content.
 *
 * Folded as a sha1 of `sessionId\0role\0seq\0ordinal\0text`, taking 8 bytes as a
 * big-endian unsigned value and masking to 52 bits so the result is a positive rowid
 * that also fits JS's safe-integer range (and is never 0, which SQLite treats
 * specially as "assign one for me").
 */
export function stableRowid(
  sessionId: string,
  role: string,
  seq: number,
  ordinal: number,
  text: string,
): bigint {
  const h = createHash("sha1")
    .update(`${sessionId}\0${role}\0${seq}\0${ordinal}\0${text}`)
    .digest();
  // Big-endian unsigned 64-bit from the first 8 bytes, masked to 52 bits so it is a
  // positive, safe-integer-sized SQLite rowid. `| 1n` keeps it strictly non-zero.
  let v = h.readBigUInt64BE(0) & 0xfffffffffffffn;
  if (v === 0n) v = 1n;
  return v;
}

/**
 * Assign each row in `rows` its {@link stableRowid}, advancing an `ordinal` per
 * (seq, role) group so rows that collide on (seq, role) still get distinct ids in a
 * deterministic order. Returns the rows paired with their rowids, preserving input
 * order. Pure — used by the writer and directly by tests.
 */
export function assignStableRowids(rows: FtsRow[]): Array<{ rowid: bigint; row: FtsRow }> {
  const ordinals = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.seq}\0${row.role}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    return { rowid: stableRowid(row.sessionId, row.role, row.seq, ordinal, row.text), row };
  });
}

/**
 * Write a session's mirrored rows onto STABLE rowids (the incremental-friendly path).
 *
 * Semantics, by design, MATCH the legacy full-replace `writeSearchText` externally:
 *  - `full` (a full re-index, startByte===0): clear the session's existing rows first,
 *    then insert every row on its stable rowid. Identical end state to a DELETE+insert,
 *    but the rowids are now reproducible so the NEXT pass can be incremental.
 *  - `!full` (an incremental append): do NOT touch existing rows. Insert ONLY the new
 *    rows, each `INSERT OR REPLACE` onto its stable rowid — so an accidental re-insert
 *    of an already-present row is idempotent (replaces itself) rather than a duplicate.
 *
 * `table` is the active store ("messages_fts" or "messages_text"); both carry the same
 * five columns. Runs inside the caller's transaction (no BEGIN/COMMIT here). Returns the
 * number of rows inserted (for diagnostics/tests).
 */
export function writeFtsRows(
  db: SqliteDatabase,
  table: string,
  sessionId: string,
  rows: SearchText[],
  full: boolean,
): number {
  if (full) {
    db.prepare(`DELETE FROM ${table} WHERE sessionId = ?`).run(sessionId);
  }
  if (rows.length === 0) return 0;

  const ftsRows: FtsRow[] = rows.map((r) => ({
    sessionId,
    role: r.role,
    seq: r.seq,
    toolName: r.toolName,
    text: r.text,
  }));
  // INSERT OR REPLACE so re-writing a row that already exists on its stable rowid is an
  // idempotent overwrite (same content) rather than a UNIQUE/duplicate. The explicit
  // rowid is what makes a re-index idempotent and an append non-disturbing.
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ${table} (rowid, sessionId, role, seq, toolName, text) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const { rowid, row } of assignStableRowids(ftsRows)) {
    insert.run(rowid, row.sessionId, row.role, row.seq, row.toolName, row.text);
    n++;
  }
  return n;
}
