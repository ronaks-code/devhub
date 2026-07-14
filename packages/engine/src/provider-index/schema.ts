import type { DatabaseSync as SqliteDatabase } from "node:sqlite";

export const PROVIDER_INDEX_SCHEMA_VERSION = 14;
export const PROVIDER_INDEX_LATEST_SCHEMA_VERSION = 15;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_PROVIDER_HOME_CHARS = 16_384;
const MAX_NATIVE_ID_CHARS = 512;
const MAX_CACHE_KEY_CHARS = 1_024;
const MAX_SHORT_TEXT_CHARS = 512;
const MAX_TITLE_CHARS = 65_536;
const MAX_TIMESTAMP_TEXT_CHARS = 64;
const MAX_JSON_CHARS = 65_536;
const MAX_NOTES_CHARS = 1_048_576;
const MAX_EVENT_JSON_CHARS = 8_388_608;
const MAX_REASON_CHARS = 4_096;

/**
 * These helpers receive only hard-coded column names below. They keep the DDL's
 * repeated trust-boundary checks readable; no caller-controlled value enters SQL.
 */
function requiredText(column: string, max: number, min = 1): string {
  return `typeof(${column}) = 'text'
    AND length(${column}) BETWEEN ${min} AND ${max}
    AND instr(${column}, char(0)) = 0`;
}

function optionalText(column: string, max: number, min = 1): string {
  return `${column} IS NULL OR (${requiredText(column, max, min)})`;
}

function safeInteger(column: string): string {
  return `typeof(${column}) = 'integer'
    AND ${column} BETWEEN 0 AND ${MAX_SAFE_INTEGER}`;
}

function optionalSafeInteger(column: string): string {
  return `${column} IS NULL OR (${safeInteger(column)})`;
}

function provider(column: string): string {
  return `typeof(${column}) = 'text' AND ${column} IN ('openai', 'anthropic')`;
}

function fingerprint(column: string): string {
  return `typeof(${column}) = 'text'
    AND length(${column}) = 64
    AND ${column} NOT GLOB '*[^0-9a-f]*'
    AND instr(${column}, char(0)) = 0`;
}

function booleanInteger(column: string): string {
  return `typeof(${column}) = 'integer' AND ${column} IN (0, 1)`;
}

function optionalBooleanInteger(column: string): string {
  return `${column} IS NULL OR (${booleanInteger(column)})`;
}

const PROVIDER_INDEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_homes (
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  canonical_home TEXT NOT NULL CHECK (${requiredText("canonical_home", MAX_PROVIDER_HOME_CHARS)}),
  registered_at INTEGER NOT NULL CHECK (${safeInteger("registered_at")}),
  PRIMARY KEY (provider, home_fingerprint),
  UNIQUE (provider, canonical_home)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_sync_state (
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  active_generation INTEGER NOT NULL DEFAULT 0 CHECK (${safeInteger("active_generation")}),
  staging_generation INTEGER CHECK (${optionalSafeInteger("staging_generation")}),
  staging_owner_token TEXT CHECK (${optionalText("staging_owner_token", MAX_SHORT_TEXT_CHARS)}),
  staging_heartbeat_at INTEGER CHECK (${optionalSafeInteger("staging_heartbeat_at")}),
  staging_expires_at INTEGER CHECK (${optionalSafeInteger("staging_expires_at")}),
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'staging')),
  provider_version TEXT CHECK (${optionalText("provider_version", MAX_CACHE_KEY_CHARS)}),
  last_completed_at INTEGER CHECK (${optionalSafeInteger("last_completed_at")}),
  PRIMARY KEY (provider, home_fingerprint),
  FOREIGN KEY (provider, home_fingerprint)
    REFERENCES provider_homes (provider, home_fingerprint)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (state = 'idle'
      AND staging_generation IS NULL
      AND staging_owner_token IS NULL
      AND staging_heartbeat_at IS NULL
      AND staging_expires_at IS NULL)
    OR
    (state = 'staging'
      AND staging_generation IS NOT NULL
      AND staging_owner_token IS NOT NULL
      AND staging_owner_token = trim(staging_owner_token)
      AND length(staging_owner_token) > 0
      AND staging_heartbeat_at IS NOT NULL
      AND staging_expires_at IS NOT NULL
      AND staging_generation > active_generation
      AND staging_heartbeat_at < staging_expires_at)
  )
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_task_cache (
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  native_task_id TEXT NOT NULL CHECK (${requiredText("native_task_id", MAX_NATIVE_ID_CHARS)}),
  title TEXT NOT NULL CHECK (${requiredText("title", MAX_TITLE_CHARS, 0)}),
  cwd TEXT CHECK (${optionalText("cwd", MAX_PROVIDER_HOME_CHARS)}),
  cwd_redacted INTEGER NOT NULL DEFAULT 0 CHECK (${booleanInteger("cwd_redacted")}),
  model TEXT CHECK (${optionalText("model", MAX_SHORT_TEXT_CHARS)}),
  status TEXT NOT NULL CHECK (${requiredText("status", MAX_SHORT_TEXT_CHARS)}),
  created_at TEXT CHECK (${optionalText("created_at", MAX_TIMESTAMP_TEXT_CHARS)}),
  updated_at TEXT CHECK (${optionalText("updated_at", MAX_TIMESTAMP_TEXT_CHARS)}),
  archived INTEGER CHECK (${optionalBooleanInteger("archived")}),
  source TEXT NOT NULL CHECK (source IN ('native', 'legacy-history', 'degraded-fallback')),
  revision_updated_at INTEGER CHECK (${optionalSafeInteger("revision_updated_at")}),
  revision_status TEXT CHECK (${optionalText("revision_status", MAX_SHORT_TEXT_CHARS)}),
  revision_last_turn_id TEXT CHECK (${optionalText("revision_last_turn_id", MAX_NATIVE_ID_CHARS)}),
  revision_last_turn_status TEXT CHECK (${optionalText("revision_last_turn_status", MAX_SHORT_TEXT_CHARS)}),
  revision_last_item_id TEXT CHECK (${optionalText("revision_last_item_id", MAX_NATIVE_ID_CHARS)}),
  revision_fingerprint TEXT CHECK (${optionalText("revision_fingerprint", MAX_CACHE_KEY_CHARS)}),
  cache_generation INTEGER NOT NULL CHECK (${safeInteger("cache_generation")}),
  observed_at INTEGER NOT NULL CHECK (${safeInteger("observed_at")}),
  PRIMARY KEY (provider, home_fingerprint, native_task_id, cache_generation),
  FOREIGN KEY (provider, home_fingerprint)
    REFERENCES provider_homes (provider, home_fingerprint)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (cwd_redacted = 0 OR cwd IS NULL)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_turn_cache (
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  native_task_id TEXT NOT NULL CHECK (${requiredText("native_task_id", MAX_NATIVE_ID_CHARS)}),
  cache_generation INTEGER NOT NULL CHECK (${safeInteger("cache_generation")}),
  native_turn_key TEXT NOT NULL CHECK (${requiredText("native_turn_key", MAX_CACHE_KEY_CHARS)}),
  status TEXT NOT NULL CHECK (${requiredText("status", MAX_SHORT_TEXT_CHARS)}),
  started_at TEXT CHECK (${optionalText("started_at", MAX_TIMESTAMP_TEXT_CHARS)}),
  completed_at TEXT CHECK (${optionalText("completed_at", MAX_TIMESTAMP_TEXT_CHARS)}),
  ordinal INTEGER NOT NULL CHECK (${safeInteger("ordinal")}),
  PRIMARY KEY (
    provider, home_fingerprint, native_task_id, cache_generation, native_turn_key
  ),
  FOREIGN KEY (provider, home_fingerprint, native_task_id, cache_generation)
    REFERENCES provider_task_cache (
      provider, home_fingerprint, native_task_id, cache_generation
    ) ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_event_cache (
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  native_task_id TEXT NOT NULL CHECK (${requiredText("native_task_id", MAX_NATIVE_ID_CHARS)}),
  cache_generation INTEGER NOT NULL CHECK (${safeInteger("cache_generation")}),
  native_turn_key TEXT NOT NULL CHECK (${requiredText("native_turn_key", MAX_CACHE_KEY_CHARS)}),
  native_item_key TEXT NOT NULL CHECK (${requiredText("native_item_key", MAX_CACHE_KEY_CHARS)}),
  replay_key TEXT NOT NULL CHECK (${requiredText("replay_key", MAX_CACHE_KEY_CHARS)}),
  ordinal INTEGER NOT NULL CHECK (${safeInteger("ordinal")}),
  event_fingerprint TEXT NOT NULL CHECK (${fingerprint("event_fingerprint")}),
  event_json TEXT NOT NULL CHECK (${requiredText("event_json", MAX_EVENT_JSON_CHARS)}),
  PRIMARY KEY (
    provider, home_fingerprint, native_task_id, cache_generation,
    native_turn_key, native_item_key, replay_key
  ),
  FOREIGN KEY (
    provider, home_fingerprint, native_task_id, cache_generation, native_turn_key
  ) REFERENCES provider_turn_cache (
    provider, home_fingerprint, native_task_id, cache_generation, native_turn_key
  ) ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_replay_receipts (
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  native_task_id TEXT NOT NULL CHECK (${requiredText("native_task_id", MAX_NATIVE_ID_CHARS)}),
  cache_generation INTEGER NOT NULL CHECK (${safeInteger("cache_generation")}),
  replay_key TEXT NOT NULL CHECK (${requiredText("replay_key", MAX_CACHE_KEY_CHARS)}),
  snapshot_fingerprint TEXT NOT NULL CHECK (${fingerprint("snapshot_fingerprint")}),
  event_count INTEGER NOT NULL CHECK (${safeInteger("event_count")}),
  observed_at INTEGER NOT NULL CHECK (${safeInteger("observed_at")}),
  PRIMARY KEY (
    provider, home_fingerprint, native_task_id, cache_generation, replay_key
  ),
  FOREIGN KEY (provider, home_fingerprint, native_task_id, cache_generation)
    REFERENCES provider_task_cache (
      provider, home_fingerprint, native_task_id, cache_generation
    ) ON UPDATE RESTRICT ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_task_meta (
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  native_task_id TEXT NOT NULL CHECK (${requiredText("native_task_id", MAX_NATIVE_ID_CHARS)}),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (${booleanInteger("favorite")}),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (${booleanInteger("pinned")}),
  local_label TEXT CHECK (${optionalText("local_label", MAX_TITLE_CHARS)}),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (${requiredText("tags_json", MAX_JSON_CHARS)}),
  notes TEXT CHECK (${optionalText("notes", MAX_NOTES_CHARS)}),
  local_archived INTEGER NOT NULL DEFAULT 0 CHECK (${booleanInteger("local_archived")}),
  ui_state_json TEXT NOT NULL DEFAULT '{}' CHECK (${requiredText("ui_state_json", MAX_JSON_CHARS)}),
  unsupported_local_json TEXT NOT NULL DEFAULT '{}'
    CHECK (${requiredText("unsupported_local_json", MAX_JSON_CHARS)}),
  updated_at INTEGER NOT NULL CHECK (${safeInteger("updated_at")}),
  PRIMARY KEY (provider, home_fingerprint, native_task_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_fork_links (
  source_provider TEXT NOT NULL CHECK (${provider("source_provider")}),
  source_home_fingerprint TEXT NOT NULL CHECK (${fingerprint("source_home_fingerprint")}),
  source_native_task_id TEXT NOT NULL CHECK (${requiredText("source_native_task_id", MAX_NATIVE_ID_CHARS)}),
  target_provider TEXT NOT NULL CHECK (${provider("target_provider")}),
  target_home_fingerprint TEXT NOT NULL CHECK (${fingerprint("target_home_fingerprint")}),
  target_native_task_id TEXT NOT NULL CHECK (${requiredText("target_native_task_id", MAX_NATIVE_ID_CHARS)}),
  created_at INTEGER NOT NULL CHECK (${safeInteger("created_at")}),
  transfer_digest TEXT NOT NULL CHECK (${fingerprint("transfer_digest")}),
  PRIMARY KEY (
    source_provider, source_home_fingerprint, source_native_task_id,
    target_provider, target_home_fingerprint, target_native_task_id
  ),
  CHECK (
    source_provider <> target_provider
    OR source_home_fingerprint <> target_home_fingerprint
    OR source_native_task_id <> target_native_task_id
  )
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS legacy_session_task_map (
  legacy_session_id TEXT NOT NULL CHECK (${requiredText("legacy_session_id", MAX_NATIVE_ID_CHARS)}),
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  native_task_id TEXT NOT NULL CHECK (${requiredText("native_task_id", MAX_NATIVE_ID_CHARS)}),
  mapping_source TEXT NOT NULL CHECK (${requiredText("mapping_source", MAX_SHORT_TEXT_CHARS)}),
  verified_at INTEGER NOT NULL CHECK (${safeInteger("verified_at")}),
  PRIMARY KEY (legacy_session_id),
  UNIQUE (provider, home_fingerprint, native_task_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS legacy_session_provenance (
  legacy_session_id TEXT NOT NULL CHECK (${requiredText("legacy_session_id", MAX_NATIVE_ID_CHARS)}),
  provenance TEXT NOT NULL CHECK (${requiredText("provenance", MAX_SHORT_TEXT_CHARS)}),
  observed_at INTEGER NOT NULL CHECK (${safeInteger("observed_at")}),
  PRIMARY KEY (legacy_session_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_reconciliation_state (
  provider TEXT NOT NULL CHECK (${provider("provider")}),
  home_fingerprint TEXT NOT NULL CHECK (${fingerprint("home_fingerprint")}),
  native_task_id TEXT NOT NULL CHECK (${requiredText("native_task_id", MAX_NATIVE_ID_CHARS)}),
  required INTEGER NOT NULL DEFAULT 0 CHECK (${booleanInteger("required")}),
  latch_revision INTEGER NOT NULL DEFAULT 0 CHECK (${safeInteger("latch_revision")}),
  reviewed_fingerprint TEXT CHECK (${optionalText("reviewed_fingerprint", MAX_CACHE_KEY_CHARS)}),
  native_fingerprint TEXT CHECK (${optionalText("native_fingerprint", MAX_CACHE_KEY_CHARS)}),
  writer_epoch INTEGER NOT NULL DEFAULT 0 CHECK (${safeInteger("writer_epoch")}),
  reason TEXT CHECK (${optionalText("reason", MAX_REASON_CHARS)}),
  updated_at INTEGER NOT NULL CHECK (${safeInteger("updated_at")}),
  PRIMARY KEY (provider, home_fingerprint, native_task_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_provider_task_cache_active_list
  ON provider_task_cache (
    updated_at DESC, provider, home_fingerprint, native_task_id, cache_generation
  );

CREATE INDEX IF NOT EXISTS idx_provider_event_cache_order
  ON provider_event_cache (
    provider, home_fingerprint, native_task_id, cache_generation,
    native_turn_key, ordinal, native_item_key, replay_key
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_turn_cache_task_ordinal
  ON provider_turn_cache (
    provider, home_fingerprint, native_task_id, cache_generation, ordinal
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_event_cache_task_ordinal
  ON provider_event_cache (
    provider, home_fingerprint, native_task_id, cache_generation, ordinal
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_replay_receipts_task_generation
  ON provider_replay_receipts (
    provider, home_fingerprint, native_task_id, cache_generation
  );

CREATE INDEX IF NOT EXISTS idx_provider_task_meta_updated
  ON provider_task_meta (updated_at DESC, provider, home_fingerprint, native_task_id);

CREATE INDEX IF NOT EXISTS idx_provider_fork_links_target
  ON provider_fork_links (
    target_provider, target_home_fingerprint, target_native_task_id, created_at
  );

CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_required
  ON provider_reconciliation_state (
    required, updated_at, provider, home_fingerprint, native_task_id
  ) WHERE required = 1;
`;

interface ProviderIndexSchemaObject {
  readonly type: "table" | "index";
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

function normalizedSchemaSql(value: string): string {
  return value
    .replace(/\bIF NOT EXISTS\s+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function expectedSchemaObjects(): readonly ProviderIndexSchemaObject[] {
  const objects: ProviderIndexSchemaObject[] = [];
  for (const rawStatement of PROVIDER_INDEX_SCHEMA_SQL.split(";")) {
    const statement = rawStatement.trim();
    if (statement.length === 0) continue;
    const table = /^CREATE TABLE IF NOT EXISTS ([a-z_]+)\b/u.exec(statement);
    if (table?.[1]) {
      objects.push({
        type: "table",
        name: table[1],
        tbl_name: table[1],
        sql: normalizedSchemaSql(statement),
      });
      continue;
    }
    const index = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+)\s+ON\s+([a-z_]+)\b/u
      .exec(statement);
    if (index?.[1] && index[2]) {
      objects.push({
        type: "index",
        name: index[1],
        tbl_name: index[2],
        sql: normalizedSchemaSql(statement),
      });
      continue;
    }
    throw new Error("provider index schema definition is invalid");
  }
  return Object.freeze(objects.sort((left, right) => {
    if (left.type !== right.type) return left.type < right.type ? -1 : 1;
    if (left.name === right.name) return 0;
    return left.name < right.name ? -1 : 1;
  }));
}

const EXPECTED_V14_SCHEMA_OBJECTS = expectedSchemaObjects();

const PROVIDER_INDEX_GENERATION_EPOCH_COLUMN_SQL = `generation_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (${safeInteger("generation_epoch")})`;

const EXPECTED_V15_SCHEMA_OBJECTS = Object.freeze(EXPECTED_V14_SCHEMA_OBJECTS.map((object) => {
  if (object.name !== "provider_sync_state") return object;
  return {
    ...object,
    sql: object.sql.replace(
      /, PRIMARY KEY \(provider, home_fingerprint\)/u,
      `, ${normalizedSchemaSql(PROVIDER_INDEX_GENERATION_EPOCH_COLUMN_SQL)}, PRIMARY KEY (provider, home_fingerprint)`,
    ),
  };
}));

function actualSchemaObjects(db: SqliteDatabase): readonly ProviderIndexSchemaObject[] {
  const actual = db.prepare(`SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE (
      type IN ('table', 'view')
      AND (
        name LIKE 'provider\\_%' ESCAPE '\\'
        OR name LIKE 'legacy\\_session\\_%' ESCAPE '\\'
      )
    ) OR (
      type IN ('index', 'trigger')
      AND sql IS NOT NULL
      AND (
        tbl_name LIKE 'provider\\_%' ESCAPE '\\'
        OR tbl_name LIKE 'legacy\\_session\\_%' ESCAPE '\\'
      )
    )
    ORDER BY type, name`).all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  return actual.map((object) => ({
    type: object.type as "table" | "index",
    name: object.name,
    tbl_name: object.tbl_name,
    sql: typeof object.sql === "string" ? normalizedSchemaSql(object.sql) : "",
  }));
}

function validateSchemaObjects(
  db: SqliteDatabase,
  expected: readonly ProviderIndexSchemaObject[],
): void {
  if (JSON.stringify(actualSchemaObjects(db)) !== JSON.stringify(expected)) {
    throw new Error("provider index schema validation failed");
  }
}

function hasGenerationEpoch(db: SqliteDatabase): boolean {
  const columns = db.prepare("PRAGMA table_info(provider_sync_state)").all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === "generation_epoch");
}

/** Validate the exact historical schema introduced by migration v14. */
export function validateProviderIndexSchema(db: SqliteDatabase): void {
  validateSchemaObjects(db, EXPECTED_V14_SCHEMA_OBJECTS);
}

/** Validate the exact additive v15 layout plus its monotonic epoch invariants. */
export function validateProviderIndexLatestSchema(db: SqliteDatabase): void {
  validateSchemaObjects(db, EXPECTED_V15_SCHEMA_OBJECTS);
  const invalid = db.prepare(`SELECT 1 AS invalid
    FROM provider_sync_state
    WHERE generation_epoch < active_generation
      OR (state = 'staging' AND generation_epoch <> staging_generation)
    LIMIT 1`).get();
  if (invalid !== undefined) {
    throw new Error("provider index schema validation failed");
  }
}

/** Create the complete additive provider-index schema. Safe to call repeatedly. */
export function createProviderIndexSchema(db: SqliteDatabase): void {
  db.exec(PROVIDER_INDEX_SCHEMA_SQL);
  if (hasGenerationEpoch(db)) {
    validateProviderIndexLatestSchema(db);
  } else {
    validateProviderIndexSchema(db);
  }
}

/**
 * Add the v15 monotonic generation allocator. The historical v14 table remains
 * intact; SQLite appends one constrained column and the owned migration
 * transaction backfills every existing scope from its greatest allocated
 * generation.
 */
export function addProviderIndexGenerationEpoch(db: SqliteDatabase): void {
  if (hasGenerationEpoch(db)) {
    validateProviderIndexLatestSchema(db);
    return;
  }

  validateProviderIndexSchema(db);
  db.exec(`ALTER TABLE provider_sync_state
    ADD COLUMN ${PROVIDER_INDEX_GENERATION_EPOCH_COLUMN_SQL}`);
  db.exec(`UPDATE provider_sync_state
    SET generation_epoch = CASE
      WHEN staging_generation IS NOT NULL AND staging_generation > active_generation
        THEN staging_generation
      ELSE active_generation
    END`);
  validateProviderIndexLatestSchema(db);
}
