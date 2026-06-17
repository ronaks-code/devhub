/**
 * Single source of truth for the message-text FTS5 schema.
 *
 * Search mirrors every renderable message into `messages_fts` (an FTS5 virtual
 * table) so MATCH + bm25() + snippet() answer cross-project search fast. Two things
 * vary by environment and so are centralized here instead of scattered across
 * index-db.ts / migrations.ts:
 *
 *  1. WHETHER FTS5 EXISTS AT ALL. node:sqlite's bundled SQLite *usually* ships FTS5,
 *     but a build without it makes `CREATE VIRTUAL TABLE ... USING fts5` throw — the
 *     caller then falls back to a plain `messages_text` table scanned with LIKE.
 *
 *  2. WHICH TOKENIZER. We prefer the `trigram` tokenizer: it indexes every 3-char
 *     window, so a MATCH on `"ymentgate"` finds `configurePaymentGateway` — i.e.
 *     true SUBSTRING / code-token search, not just whole-word. trigram also stays
 *     compatible with our existing query shapes: quoted terms still match, a trailing
 *     `*` is still a prefix, bm25()/snippet() still work. If `trigram` is unavailable
 *     in this SQLite build we degrade to `porter` (word stemming) and then to the
 *     default `unicode61` — each detected by actually trying to CREATE a probe table,
 *     mirroring the fts5/like detection.
 *
 * The column layout is fixed at create time and shared by EVERY caller (the live
 * table, the migration's rebuilt table, and the LIKE fallback's plain table all use
 * the same five columns in the same order): `sessionId, role, seq, toolName, text`.
 * Only `text` is indexed; the rest are UNINDEXED (carried for display/filtering).
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";

/** The FTS table name (and, for parity, the LIKE-mode table is `messages_text`). */
export const FTS_TABLE = "messages_fts";

/**
 * The mirrored-message columns, in order. `text` is the only indexed column; the
 * others are UNINDEXED (carried for display + faceting, never tokenized). Used to
 * keep the FTS table, the rebuilt table, and the plain LIKE table identical.
 */
export const FTS_COLUMNS = ["sessionId", "role", "seq", "toolName", "text"] as const;

/** Tokenizers we know how to ask for, best → most-basic. */
export type FtsTokenizer = "trigram" | "porter" | "unicode61";

/**
 * Preference order. `trigram` (substring/code-token search) first; then `porter`
 * (word stemming); then the always-present `unicode61` default. We pick the first
 * one this SQLite build will actually create.
 */
export const TOKENIZER_PREFERENCE: readonly FtsTokenizer[] = ["trigram", "porter", "unicode61"];

/** The FTS5 `tokenize=` option string for a tokenizer (e.g. `"trigram"`). */
function tokenizeOption(tok: FtsTokenizer): string {
  // case_sensitive 0 keeps trigram matching case-insensitive (its default), made
  // explicit so search is case-folding regardless of the SQLite build's defaults.
  // porter/unicode61 are already case-folding; pass them bare.
  return tok === "trigram" ? `tokenize='trigram case_sensitive 0'` : `tokenize='${tok}'`;
}

/** The column list as it appears inside a CREATE VIRTUAL TABLE ... USING fts5(...). */
function ftsColumnDdl(): string {
  // Only `text` is indexed; everything else is UNINDEXED.
  return FTS_COLUMNS.map((c) => (c === "text" ? "text" : `${c} UNINDEXED`)).join(", ");
}

/**
 * The CREATE VIRTUAL TABLE statement for the FTS mirror under a given name +
 * tokenizer. `ifNotExists` guards the live table; the migration creates a fresh
 * (differently-named) table without it.
 */
export function createFtsTableSql(
  name: string,
  tokenizer: FtsTokenizer,
  opts: { ifNotExists?: boolean } = {},
): string {
  const guard = opts.ifNotExists ? "IF NOT EXISTS " : "";
  return `CREATE VIRTUAL TABLE ${guard}${name} USING fts5(${ftsColumnDdl()}, ${tokenizeOption(tokenizer)})`;
}

/** DDL for the plain LIKE-mode mirror (used when FTS5 is unavailable). Same columns. */
export function createLikeTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS messages_text (
     sessionId TEXT NOT NULL,
     role TEXT,
     seq INTEGER,
     toolName TEXT,
     text TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_messages_text_session ON messages_text(sessionId);
   CREATE INDEX IF NOT EXISTS idx_messages_text_text ON messages_text(text);`;
}

/**
 * Probe which tokenizer this SQLite build supports by actually trying to CREATE a
 * throwaway FTS5 table for each preference in turn (inside a savepoint so the probe
 * leaves no trace). Returns the first that succeeds, or null if FTS5 itself is
 * unavailable (every CREATE threw — the caller then falls back to LIKE mode).
 *
 * This mirrors how index-db.ts already detects fts5-vs-like: we don't trust a static
 * capability list, we ask the engine.
 */
export function detectFtsTokenizer(db: SqliteDatabase): FtsTokenizer | null {
  for (const tok of TOKENIZER_PREFERENCE) {
    const probe = `__fts_probe_${tok}`;
    try {
      db.exec("SAVEPOINT fts_probe");
      db.exec(createFtsTableSql(probe, tok));
      db.exec(`DROP TABLE ${probe}`);
      db.exec("RELEASE fts_probe");
      return tok;
    } catch {
      // Roll the failed probe back and try the next-most-basic tokenizer.
      try {
        db.exec("ROLLBACK TO fts_probe");
        db.exec("RELEASE fts_probe");
      } catch {
        /* savepoint may not have opened; ignore */
      }
    }
  }
  return null;
}

/** The tokenizer an existing `messages_fts` table was created with (parsed from its SQL). */
export function tokenizerOf(db: SqliteDatabase, table: string = FTS_TABLE): FtsTokenizer | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string | null } | undefined;
  const sql = row?.sql;
  if (!sql) return null;
  // The stored DDL echoes the tokenize= option, e.g. tokenize='trigram case_sensitive 0'.
  const m = sql.match(/tokenize\s*=\s*['"]\s*(\w+)/i);
  const tok = m?.[1]?.toLowerCase();
  if (tok === "trigram" || tok === "porter" || tok === "unicode61") return tok;
  // No explicit tokenize= means the FTS5 default (unicode61) — that's a legacy table
  // we want the migration to rebuild onto trigram.
  return sql.toLowerCase().includes("using fts5") ? "unicode61" : null;
}
