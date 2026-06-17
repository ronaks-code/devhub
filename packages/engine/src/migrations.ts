/**
 * Schema migrations gated by SQLite's `PRAGMA user_version`.
 *
 * The base schema is still created with CREATE TABLE IF NOT EXISTS in index-db.ts
 * (so a brand-new DB stands up fully). Migrations here are ADDITIVE ONLY — they
 * add columns / indexes / tables on top of an already-populated DB and never drop
 * or recreate a table that holds data. Each step must be idempotent (guarded by
 * IF NOT EXISTS or a column-presence check) so re-running is harmless.
 *
 * To add a migration: append a step to MIGRATIONS. Its index+1 becomes the new
 * user_version. Never reorder or remove existing steps.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import {
  FTS_TABLE,
  FTS_COLUMNS,
  createFtsTableSql,
  detectFtsTokenizer,
  tokenizerOf,
} from "./fts-schema.js";

type Migration = (db: SqliteDatabase) => void;

/** True when `table` already has a column named `column`. */
function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/** True when a table named `table` exists. */
function hasTable(db: SqliteDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;
  return !!row;
}

/**
 * Ordered, append-only list of migration steps. Step at index i takes the DB from
 * user_version i to i+1. Keep every step idempotent.
 */
const MIGRATIONS: Migration[] = [
  // v1: settings key/value table. Idempotent via IF NOT EXISTS.
  // (SettingsStore also creates this lazily; defining it here keeps user_version
  //  meaningful and lets future settings-related migrations chain off a known base.)
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );`);
  },
  // v2: per-project UI metadata (favorite/archived/sort/color). Keyed by the
  // stable projectId (sha1 of true cwd). Additive: a fresh DB gets it here, and
  // an existing DB picks it up on the next startup. Idempotent via IF NOT EXISTS.
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS project_meta (
      projectId TEXT PRIMARY KEY,
      favorite INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      color TEXT
    );`);
  },
  // v3: session tags. Stored as a JSON array string in session_meta.tags. A fresh
  // DB already gets this column from the base SCHEMA, but a DB created before tags
  // existed won't have it — add it here, guarded by a column-presence check so the
  // step is idempotent and harmless on a DB that already has the column.
  (db) => {
    // session_meta is created by the base SCHEMA, so it always exists by now.
    if (!hasColumn(db, "session_meta", "tags")) {
      db.exec(`ALTER TABLE session_meta ADD COLUMN tags TEXT`);
    }
  },
  // v4: per-session model id (the assistant model the session ran on). A fresh DB
  // gets this column from the base SCHEMA; a DB created before model tracking won't
  // have it — add it here, guarded by a column-presence check so the step is
  // idempotent. Existing rows read NULL until a forced reindex backfills them.
  (db) => {
    // sessions is created by the base SCHEMA before migrations run, so it normally
    // exists by now; guard with hasTable anyway so the step is a harmless no-op if
    // it's ever run against a DB without the base schema.
    if (hasTable(db, "sessions") && !hasColumn(db, "sessions", "model")) {
      db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`);
    }
  },
  // v5: per-session head signature (a fingerprint of the transcript's first bytes).
  // Lets the incremental indexer detect a PREFIX REWRITE / rotation (the file was
  // re-created rather than appended to) and force a full re-index from byte 0
  // instead of trusting indexedBytes. A fresh DB gets the column from the base
  // SCHEMA; a legacy DB picks it up here. Existing rows read NULL until their next
  // index pass populates it (a null signature is treated as "unknown", which the
  // indexer handles conservatively). Guarded by a column-presence check.
  (db) => {
    if (hasTable(db, "sessions") && !hasColumn(db, "sessions", "headSig")) {
      db.exec(`ALTER TABLE sessions ADD COLUMN headSig TEXT`);
    }
  },
  // v6: per-session `archived` flag in session_meta (our own data — archived
  // sessions drop out of the default lists). A fresh DB gets the column from the
  // base SCHEMA; a legacy DB picks it up here. Guarded by a column-presence check
  // so the step is idempotent. Existing rows read 0 (not archived).
  (db) => {
    // session_meta is created by the base SCHEMA before migrations run.
    if (hasTable(db, "session_meta") && !hasColumn(db, "session_meta", "archived")) {
      db.exec(`ALTER TABLE session_meta ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    }
  },
  // v7: saved views ("smart folders") — a named (query + facets JSON) the user can
  // re-run. Our own data; never touches transcripts. Idempotent via IF NOT EXISTS.
  // `facets` is a JSON object string (the SearchFacets); `query` is the text query.
  // A fresh DB also gets this from the base SCHEMA; a legacy DB picks it up here.
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS saved_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      query TEXT NOT NULL DEFAULT '',
      facets TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );`);
  },
  // v8: switch the messages_fts tokenizer to FTS5 `trigram` so search matches
  // SUBSTRINGS / code tokens (a MATCH on "ymentgate" finds "configurePaymentGateway"),
  // not just whole words. DATA-PRESERVING: an FTS5 tokenizer is fixed at create time,
  // so we can't ALTER it — instead we build a fresh table on the new tokenizer, COPY
  // every existing row across (which re-tokenizes/re-indexes the already-mirrored text
  // under trigram — no transcript re-read needed), then drop the old table and rename.
  // The whole step runs inside the migration runner's transaction, so search either
  // sees the old table or the fully-rebuilt new one — never a half-migrated state.
  //
  // Guards (idempotent + safe on every DB shape):
  //   - No messages_fts yet (brand-new DB): nothing to migrate. index-db.ts will
  //     CREATE it directly on the best tokenizer right after migrations run.
  //   - LIKE-mode DB (FTS5 unavailable, only messages_text exists): nothing to do.
  //   - Already on the best available tokenizer: no-op.
  //   - FTS5 present but `trigram` unavailable in this build: rebuild onto the next
  //     best tokenizer the engine actually supports (porter, else unicode61), so the
  //     step still converges and never throws.
  migrateFtsTokenizer,
  // v9: per-project DEFAULT model + permission mode, stored on the existing
  // project_meta row (additive columns). A fresh DB also gets these from the base
  // project_meta CREATE in index-db.ts; a legacy DB picks them up here. Guarded by a
  // column-presence check so the step is idempotent. Existing rows read NULL = "no
  // project-specific default; use the app-wide setting".
  (db) => {
    if (hasTable(db, "project_meta")) {
      if (!hasColumn(db, "project_meta", "defaultModel")) {
        db.exec(`ALTER TABLE project_meta ADD COLUMN defaultModel TEXT`);
      }
      if (!hasColumn(db, "project_meta", "defaultPermissionMode")) {
        db.exec(`ALTER TABLE project_meta ADD COLUMN defaultPermissionMode TEXT`);
      }
    }
  },
];

/**
 * Migration v8 body (extracted for readability): rebuild `messages_fts` onto the best
 * available tokenizer (trigram → porter → unicode61), copying existing rows so no
 * mirrored text is lost or needs a transcript re-read. See the MIGRATIONS comment.
 */
function migrateFtsTokenizer(db: SqliteDatabase): void {
  // Nothing to migrate unless an FTS5 messages_fts already exists. A brand-new DB has
  // no such table yet (index-db.ts creates it post-migration); a LIKE-mode DB only has
  // messages_text. tokenizerOf returns null in both cases.
  const current = tokenizerOf(db, FTS_TABLE);
  if (current == null) return;

  // The best tokenizer this SQLite build supports. detectFtsTokenizer can't return
  // null here (FTS5 clearly works — messages_fts exists), but guard anyway.
  const target = detectFtsTokenizer(db);
  if (target == null || target === current) return;

  // Rebuild: fresh table on the target tokenizer, copy every row across (re-indexing
  // the mirrored text under the new tokenizer), drop the old, rename into place. The
  // column list is the single source of truth from fts-schema.ts, so the copy lines up
  // 1:1. A unique temp name avoids colliding with anything.
  const tmp = `${FTS_TABLE}_rebuild`;
  const cols = FTS_COLUMNS.join(", ");
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(createFtsTableSql(tmp, target));
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${FTS_TABLE}`);
  db.exec(`DROP TABLE ${FTS_TABLE}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${FTS_TABLE}`);
}

/**
 * Bring `db` up to the latest schema version. Reads PRAGMA user_version, runs each
 * pending step inside its own transaction, then bumps user_version. Safe to call on
 * every startup; a fully-migrated DB does no work.
 */
export function runMigrations(db: SqliteDatabase): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  let current = row ? Number(row.user_version) : 0;

  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v]!;
    db.exec("BEGIN");
    try {
      step(db);
      // user_version doesn't accept bound params; v+1 is a trusted integer.
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    current = v + 1;
  }
}

// Re-export so callers can guard column-adding migrations without re-implementing.
export { hasColumn };
