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
  ftsTableColumns,
  ftsLacksColumn,
} from "./fts-schema.js";
import {
  createProviderIndexSchema,
  PROVIDER_INDEX_SCHEMA_VERSION,
} from "./provider-index/schema.js";

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
  // v10: permission-decision audit log — a durable trail of allow/deny verdicts for
  // tool calls (see audit.ts). Our own data; never touches transcripts. Idempotent
  // via IF NOT EXISTS. A fresh DB also gets this from the base SCHEMA in index-db.ts;
  // a legacy DB picks it up here.
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS permission_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      toolName TEXT NOT NULL,
      decision TEXT NOT NULL,
      scope TEXT,
      reason TEXT,
      ts INTEGER NOT NULL
    );`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_permission_audit_session ON permission_audit(sessionId)`,
    );
  },
  // v11: free-form session NOTES (markdown) in session_meta.notes. Our own data — a
  // scratchpad the user attaches to a session; never derived from the transcript. A
  // fresh DB gets the column from the base SCHEMA; a legacy DB picks it up here.
  // Guarded by a column-presence check so the step is idempotent. Existing rows read
  // NULL (no notes).
  (db) => {
    if (hasTable(db, "session_meta") && !hasColumn(db, "session_meta", "notes")) {
      db.exec(`ALTER TABLE session_meta ADD COLUMN notes TEXT`);
    }
  },
  // v12: self-heal a PRE-WAVE-4 messages_fts that lacks the `toolName` column. Those
  // old tables were created as (sessionId, role, seq, text) — without toolName — so the
  // tool-name facet + display break against them. Like the v8 tokenizer swap, an FTS5
  // column set is fixed at create time, so we can't ALTER one in; we REBUILD:
  // create a fresh table on the current (5-column) layout + best tokenizer, copy every
  // legacy row across (mapping the OLD table's columns; the new `toolName` reads NULL
  // for those rows until a forced reindex backfills it), drop the old, rename. Runs in
  // the migration runner's transaction, so search sees only the old or fully-rebuilt
  // table — never a half-migrated one. No transcript re-read needed.
  migrateFtsAddToolName,
  // v13: per-tool-call analytics sidecar. The FTS mirror's column set is fixed at create
  // time (FTS5 columns can't be ALTERed), so it can only persist sessionId/role/seq/
  // toolName/text — enough for an invocation COUNT, but NOT the tool_result.is_error flag
  // nor per-message timestamps. This is a REGULAR table (freely extensible) holding one
  // row per assistant tool_use: its toolName, the result's is_error, the use's timestamp,
  // and a use→result duration when both timestamps exist — so toolStats can report real
  // errorRate + avgMs. DATA-PRESERVING + idempotent: pure CREATE ... IF NOT EXISTS, never
  // touches transcripts or existing tables. A fresh DB also gets this from the base SCHEMA
  // in index-db.ts; a legacy DB picks it up here. It is empty until a (re)index populates
  // it — old un-reindexed sessions have no tool_calls rows yet (the server lane's reindex
  // route, or indexAll({ force:true }), backfills them), and toolStats falls back to the
  // FTS COUNT for any scope with no rows yet, so it never regresses. Indexes on (toolName)
  // and (sessionId) keep the toolStats GROUP BY + per-session scoping bounded (no scan).
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
      sessionId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      toolName TEXT NOT NULL,
      isError INTEGER NOT NULL DEFAULT 0,
      ts TEXT,
      durationMs INTEGER
    );`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(toolName)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(sessionId)`);
  },
  // v14: provider-native task index. These tables separate rebuildable provider
  // cache from DevHub-owned metadata, mappings, fork links, and reconciliation
  // latches. Keep this DDL migration-only (not in index-db.ts's legacy base schema)
  // so a v13 database reaches the full shape atomically in this version transaction.
  createProviderIndexSchema,
];

if (
  MIGRATIONS.length !== PROVIDER_INDEX_SCHEMA_VERSION ||
  MIGRATIONS[PROVIDER_INDEX_SCHEMA_VERSION - 1] !== createProviderIndexSchema
) {
  throw new Error("provider index migration version is inconsistent");
}

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

  // Rebuild: fresh table on the target tokenizer (always the current full layout),
  // copy every row across (re-indexing the mirrored text under the new tokenizer),
  // drop the old, rename into place. We copy only the columns the OLD table actually
  // has (its intersection with the current layout) — a PRE-`toolName` legacy table
  // would otherwise make `SELECT toolName` throw here. The new `toolName` stays NULL
  // for those rows; the v12 repair leaves it as-is once the tokenizer is current. A
  // unique temp name avoids colliding with anything.
  const oldCols = new Set(ftsTableColumns(db, FTS_TABLE));
  const cols = FTS_COLUMNS.filter((c) => oldCols.has(c)).join(", ");
  const tmp = `${FTS_TABLE}_rebuild`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(createFtsTableSql(tmp, target));
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${FTS_TABLE}`);
  db.exec(`DROP TABLE ${FTS_TABLE}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${FTS_TABLE}`);
}

/**
 * Migration v12 body: REPAIR a legacy `messages_fts` that predates the `toolName`
 * column (pre-wave-4 4-column schema), rebuilding it onto the current 5-column layout
 * so old DBs self-heal. See the MIGRATIONS comment.
 *
 * Idempotent + safe on every DB shape:
 *   - No messages_fts (fresh / LIKE-mode DB): nothing to repair — ftsLacksColumn is false.
 *   - Already has toolName (current schema): no-op.
 *   - FTS5 unavailable here: an FTS5 messages_fts can't exist, so this never fires.
 *
 * The copy maps only the columns the OLD table actually has (its intersection with the
 * current layout); any missing column — `toolName` for a legacy table — is simply not
 * inserted, so it reads NULL until a forced reindex backfills the real tool names. We
 * preserve the existing tokenizer when we can detect it (so this repair doesn't also
 * silently change the tokenizer); otherwise we fall back to the best available one.
 */
function migrateFtsAddToolName(db: SqliteDatabase): void {
  if (!ftsLacksColumn(db, "toolName", FTS_TABLE)) return;

  // Keep the table's current tokenizer if we can read it; else use the best available.
  // detectFtsTokenizer can't be null here (FTS5 clearly works — messages_fts exists).
  const target = tokenizerOf(db, FTS_TABLE) ?? detectFtsTokenizer(db);
  if (target == null) return; // defensive: no FTS5 -> nothing to do

  // Only copy columns present in BOTH the old table and the current layout. A legacy
  // table is (sessionId, role, seq, text); `toolName` is absent and stays NULL.
  const oldCols = new Set(ftsTableColumns(db, FTS_TABLE));
  const shared = FTS_COLUMNS.filter((c) => oldCols.has(c));
  const sharedList = shared.join(", ");

  const tmp = `${FTS_TABLE}_addtool`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(createFtsTableSql(tmp, target));
  db.exec(`INSERT INTO ${tmp} (${sharedList}) SELECT ${sharedList} FROM ${FTS_TABLE}`);
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
