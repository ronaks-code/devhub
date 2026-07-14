import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptIndex } from "../../src/index-db.js";
import { runMigrations } from "../../src/migrations.js";
import { PROVIDER_INDEX_SCHEMA_VERSION } from "../../src/provider-index/schema.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const PROVIDER_TABLES = [
  "provider_homes",
  "provider_sync_state",
  "provider_task_cache",
  "provider_turn_cache",
  "provider_event_cache",
  "provider_replay_receipts",
  "provider_task_meta",
  "provider_fork_links",
  "legacy_session_task_map",
  "legacy_session_provenance",
  "provider_reconciliation_state",
] as const;
type ProviderTableName = (typeof PROVIDER_TABLES)[number];

type TableInfoField = readonly [
  name: string,
  type: "TEXT" | "INTEGER",
  notnull: 0 | 1,
  dfltValue: string | null,
  pk: number,
];

const GOLDEN_TABLE_INFO: Record<ProviderTableName, readonly TableInfoField[]> = {
  provider_homes: [
    ["provider", "TEXT", 1, null, 1],
    ["home_fingerprint", "TEXT", 1, null, 2],
    ["canonical_home", "TEXT", 1, null, 0],
    ["registered_at", "INTEGER", 1, null, 0],
  ],
  provider_sync_state: [
    ["provider", "TEXT", 1, null, 1],
    ["home_fingerprint", "TEXT", 1, null, 2],
    ["active_generation", "INTEGER", 1, "0", 0],
    ["staging_generation", "INTEGER", 0, null, 0],
    ["staging_owner_token", "TEXT", 0, null, 0],
    ["staging_heartbeat_at", "INTEGER", 0, null, 0],
    ["staging_expires_at", "INTEGER", 0, null, 0],
    ["state", "TEXT", 1, "'idle'", 0],
    ["provider_version", "TEXT", 0, null, 0],
    ["last_completed_at", "INTEGER", 0, null, 0],
  ],
  provider_task_cache: [
    ["provider", "TEXT", 1, null, 1],
    ["home_fingerprint", "TEXT", 1, null, 2],
    ["native_task_id", "TEXT", 1, null, 3],
    ["title", "TEXT", 1, null, 0],
    ["cwd", "TEXT", 0, null, 0],
    ["model", "TEXT", 0, null, 0],
    ["status", "TEXT", 1, null, 0],
    ["created_at", "TEXT", 0, null, 0],
    ["updated_at", "TEXT", 0, null, 0],
    ["archived", "INTEGER", 0, null, 0],
    ["source", "TEXT", 1, null, 0],
    ["revision_updated_at", "INTEGER", 0, null, 0],
    ["revision_status", "TEXT", 0, null, 0],
    ["revision_last_turn_id", "TEXT", 0, null, 0],
    ["revision_last_turn_status", "TEXT", 0, null, 0],
    ["revision_last_item_id", "TEXT", 0, null, 0],
    ["revision_fingerprint", "TEXT", 0, null, 0],
    ["cache_generation", "INTEGER", 1, null, 4],
    ["observed_at", "INTEGER", 1, null, 0],
  ],
  provider_turn_cache: [
    ["provider", "TEXT", 1, null, 1],
    ["home_fingerprint", "TEXT", 1, null, 2],
    ["native_task_id", "TEXT", 1, null, 3],
    ["cache_generation", "INTEGER", 1, null, 4],
    ["native_turn_key", "TEXT", 1, null, 5],
    ["status", "TEXT", 1, null, 0],
    ["started_at", "TEXT", 0, null, 0],
    ["completed_at", "TEXT", 0, null, 0],
    ["ordinal", "INTEGER", 1, null, 0],
  ],
  provider_event_cache: [
    ["provider", "TEXT", 1, null, 1],
    ["home_fingerprint", "TEXT", 1, null, 2],
    ["native_task_id", "TEXT", 1, null, 3],
    ["cache_generation", "INTEGER", 1, null, 4],
    ["native_turn_key", "TEXT", 1, null, 5],
    ["native_item_key", "TEXT", 1, null, 6],
    ["replay_key", "TEXT", 1, null, 7],
    ["ordinal", "INTEGER", 1, null, 0],
    ["event_fingerprint", "TEXT", 1, null, 0],
    ["event_json", "TEXT", 1, null, 0],
  ],
  provider_replay_receipts: [
    ["provider", "TEXT", 1, null, 1],
    ["home_fingerprint", "TEXT", 1, null, 2],
    ["native_task_id", "TEXT", 1, null, 3],
    ["cache_generation", "INTEGER", 1, null, 4],
    ["replay_key", "TEXT", 1, null, 5],
    ["snapshot_fingerprint", "TEXT", 1, null, 0],
    ["event_count", "INTEGER", 1, null, 0],
    ["observed_at", "INTEGER", 1, null, 0],
  ],
  provider_task_meta: [
    ["provider", "TEXT", 1, null, 1],
    ["home_fingerprint", "TEXT", 1, null, 2],
    ["native_task_id", "TEXT", 1, null, 3],
    ["favorite", "INTEGER", 1, "0", 0],
    ["pinned", "INTEGER", 1, "0", 0],
    ["local_label", "TEXT", 0, null, 0],
    ["tags_json", "TEXT", 1, "'[]'", 0],
    ["notes", "TEXT", 0, null, 0],
    ["local_archived", "INTEGER", 1, "0", 0],
    ["ui_state_json", "TEXT", 1, "'{}'", 0],
    ["unsupported_local_json", "TEXT", 1, "'{}'", 0],
    ["updated_at", "INTEGER", 1, null, 0],
  ],
  provider_fork_links: [
    ["source_provider", "TEXT", 1, null, 1],
    ["source_home_fingerprint", "TEXT", 1, null, 2],
    ["source_native_task_id", "TEXT", 1, null, 3],
    ["target_provider", "TEXT", 1, null, 4],
    ["target_home_fingerprint", "TEXT", 1, null, 5],
    ["target_native_task_id", "TEXT", 1, null, 6],
    ["created_at", "INTEGER", 1, null, 0],
    ["transfer_digest", "TEXT", 1, null, 0],
  ],
  legacy_session_task_map: [
    ["legacy_session_id", "TEXT", 1, null, 1],
    ["provider", "TEXT", 1, null, 0],
    ["home_fingerprint", "TEXT", 1, null, 0],
    ["native_task_id", "TEXT", 1, null, 0],
    ["mapping_source", "TEXT", 1, null, 0],
    ["verified_at", "INTEGER", 1, null, 0],
  ],
  legacy_session_provenance: [
    ["legacy_session_id", "TEXT", 1, null, 1],
    ["provenance", "TEXT", 1, null, 0],
    ["observed_at", "INTEGER", 1, null, 0],
  ],
  provider_reconciliation_state: [
    ["provider", "TEXT", 1, null, 1],
    ["home_fingerprint", "TEXT", 1, null, 2],
    ["native_task_id", "TEXT", 1, null, 3],
    ["required", "INTEGER", 1, "0", 0],
    ["latch_revision", "INTEGER", 1, "0", 0],
    ["reviewed_fingerprint", "TEXT", 0, null, 0],
    ["native_fingerprint", "TEXT", 0, null, 0],
    ["writer_epoch", "INTEGER", 1, "0", 0],
    ["reason", "TEXT", 0, null, 0],
    ["updated_at", "INTEGER", 1, null, 0],
  ],
};

type ForeignKeyField = readonly [
  table: ProviderTableName,
  from: string,
  to: string,
  onUpdate: "RESTRICT",
  onDelete: "RESTRICT" | "CASCADE",
];

const GOLDEN_FOREIGN_KEYS: Record<ProviderTableName, readonly ForeignKeyField[]> = {
  provider_homes: [],
  provider_sync_state: [
    ["provider_homes", "provider", "provider", "RESTRICT", "RESTRICT"],
    ["provider_homes", "home_fingerprint", "home_fingerprint", "RESTRICT", "RESTRICT"],
  ],
  provider_task_cache: [
    ["provider_homes", "provider", "provider", "RESTRICT", "RESTRICT"],
    ["provider_homes", "home_fingerprint", "home_fingerprint", "RESTRICT", "RESTRICT"],
  ],
  provider_turn_cache: [
    ["provider_task_cache", "provider", "provider", "RESTRICT", "CASCADE"],
    ["provider_task_cache", "home_fingerprint", "home_fingerprint", "RESTRICT", "CASCADE"],
    ["provider_task_cache", "native_task_id", "native_task_id", "RESTRICT", "CASCADE"],
    ["provider_task_cache", "cache_generation", "cache_generation", "RESTRICT", "CASCADE"],
  ],
  provider_event_cache: [
    ["provider_turn_cache", "provider", "provider", "RESTRICT", "CASCADE"],
    ["provider_turn_cache", "home_fingerprint", "home_fingerprint", "RESTRICT", "CASCADE"],
    ["provider_turn_cache", "native_task_id", "native_task_id", "RESTRICT", "CASCADE"],
    ["provider_turn_cache", "cache_generation", "cache_generation", "RESTRICT", "CASCADE"],
    ["provider_turn_cache", "native_turn_key", "native_turn_key", "RESTRICT", "CASCADE"],
  ],
  provider_replay_receipts: [
    ["provider_task_cache", "provider", "provider", "RESTRICT", "CASCADE"],
    ["provider_task_cache", "home_fingerprint", "home_fingerprint", "RESTRICT", "CASCADE"],
    ["provider_task_cache", "native_task_id", "native_task_id", "RESTRICT", "CASCADE"],
    ["provider_task_cache", "cache_generation", "cache_generation", "RESTRICT", "CASCADE"],
  ],
  provider_task_meta: [],
  provider_fork_links: [],
  legacy_session_task_map: [],
  legacy_session_provenance: [],
  provider_reconciliation_state: [],
};

const HOME_FINGERPRINT = "a".repeat(64);
const TARGET_HOME_FINGERPRINT = "b".repeat(64);
const EVENT_FINGERPRINT = "c".repeat(64);
const SNAPSHOT_FINGERPRINT = "d".repeat(64);
const TRANSFER_DIGEST = "e".repeat(64);
const PRE_PROVIDER_INDEX_SCHEMA_VERSION = PROVIDER_INDEX_SCHEMA_VERSION - 1;

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devhub-provider-schema-"));
  dirs.push(dir);
  return dir;
}

function openDatabase(file = ":memory:"): TestDatabase {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function userVersion(db: TestDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint };
  return Number(row.user_version);
}

function providerSchema(db: TestDatabase): ReadonlyArray<Record<string, unknown>> {
  return db
    .prepare(`SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE tbl_name LIKE 'provider\\_%' ESCAPE '\\'
         OR tbl_name LIKE 'legacy\\_session\\_%' ESCAPE '\\'
      ORDER BY type, name`)
    .all() as Array<Record<string, unknown>>;
}

function migrateV13(db: TestDatabase): void {
  db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);
  runMigrations(db);
}

function registerHome(
  db: TestDatabase,
  provider = "openai",
  fingerprint = HOME_FINGERPRINT,
  home = "/tmp/devhub-openai-home",
): void {
  db.prepare(`INSERT INTO provider_homes
    (provider, home_fingerprint, canonical_home, registered_at)
    VALUES (?, ?, ?, ?)`)
    .run(provider, fingerprint, home, 1_000);
}

function insertTask(
  db: TestDatabase,
  options: {
    provider?: string;
    fingerprint?: string;
    nativeTaskId?: string;
    archived?: number | null;
    source?: string;
    cacheGeneration?: number;
  } = {},
): void {
  db.prepare(`INSERT INTO provider_task_cache (
    provider, home_fingerprint, native_task_id,
    title, cwd, model, status, created_at, updated_at, archived, source,
    revision_updated_at, revision_status, revision_last_turn_id,
    revision_last_turn_status, revision_last_item_id, revision_fingerprint,
    cache_generation, observed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      options.provider ?? "openai",
      options.fingerprint ?? HOME_FINGERPRINT,
      options.nativeTaskId ?? "task-1",
      "Schema task",
      "/tmp/project",
      "provider-model",
      "idle",
      "2026-07-13T00:00:00.000Z",
      "2026-07-13T00:01:00.000Z",
      options.archived === undefined ? 0 : options.archived,
      options.source ?? "native",
      1_000,
      "idle",
      "turn-1",
      "complete",
      "item-1",
      "openai:v1:revision",
      options.cacheGeneration ?? 1,
      2_000,
    );
}

function insertTurn(
  db: TestDatabase,
  options: {
    provider?: string;
    fingerprint?: string;
    cacheGeneration?: number;
    nativeTaskId?: string;
    nativeTurnKey?: string;
  } = {},
): void {
  db.prepare(`INSERT INTO provider_turn_cache (
    provider, home_fingerprint, native_task_id, cache_generation,
    native_turn_key, status, started_at, completed_at, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      options.provider ?? "openai",
      options.fingerprint ?? HOME_FINGERPRINT,
      options.nativeTaskId ?? "task-1",
      options.cacheGeneration ?? 1,
      options.nativeTurnKey ?? "native:v1:turn-1",
      "complete",
      "2026-07-13T00:00:00.000Z",
      "2026-07-13T00:01:00.000Z",
      0,
    );
}

function insertEvent(
  db: TestDatabase,
  options: {
    provider?: string;
    fingerprint?: string;
    cacheGeneration?: number;
    nativeTaskId?: string;
    nativeTurnKey?: string;
    nativeItemKey?: string;
    replayKey?: string;
    eventFingerprint?: string;
  } = {},
): void {
  db.prepare(`INSERT INTO provider_event_cache (
    provider, home_fingerprint, native_task_id, cache_generation,
    native_turn_key, native_item_key, replay_key, ordinal,
    event_fingerprint, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      options.provider ?? "openai",
      options.fingerprint ?? HOME_FINGERPRINT,
      options.nativeTaskId ?? "task-1",
      options.cacheGeneration ?? 1,
      options.nativeTurnKey ?? "native:v1:turn-1",
      options.nativeItemKey ?? "native:v1:item-1",
      options.replayKey ?? "replay:v1:0:event",
      0,
      options.eventFingerprint ?? EVENT_FINGERPRINT,
      '{"type":"message"}',
    );
}

function insertReceipt(
  db: TestDatabase,
  options: {
    provider?: string;
    fingerprint?: string;
    cacheGeneration?: number;
    nativeTaskId?: string;
    replayKey?: string;
    snapshotFingerprint?: string;
  } = {},
): void {
  db.prepare(`INSERT INTO provider_replay_receipts (
    provider, home_fingerprint, native_task_id, cache_generation,
    replay_key, snapshot_fingerprint, event_count, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      options.provider ?? "openai",
      options.fingerprint ?? HOME_FINGERPRINT,
      options.nativeTaskId ?? "task-1",
      options.cacheGeneration ?? 1,
      options.replayKey ?? "snapshot:v1:task-1",
      options.snapshotFingerprint ?? SNAPSHOT_FINGERPRINT,
      1,
      2_000,
    );
}

function expectedTableInfo(table: ProviderTableName): ReadonlyArray<Record<string, unknown>> {
  return GOLDEN_TABLE_INFO[table].map(([name, type, notnull, dfltValue, pk], cid) => ({
    cid,
    name,
    type,
    notnull,
    dflt_value: dfltValue,
    pk,
  }));
}

function expectedForeignKeys(table: ProviderTableName): ReadonlyArray<Record<string, unknown>> {
  return GOLDEN_FOREIGN_KEYS[table].map(
    ([referencedTable, from, to, onUpdate, onDelete], seq) => ({
      id: 0,
      seq,
      table: referencedTable,
      from,
      to,
      on_update: onUpdate,
      on_delete: onDelete,
      match: "NONE",
    }),
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider index v14 migration", () => {
  it("upgrades a v13 database additively and advances user_version to 14", () => {
    const db = openDatabase();
    migrateV13(db);

    expect(PROVIDER_INDEX_SCHEMA_VERSION).toBe(14);
    expect(userVersion(db)).toBe(PROVIDER_INDEX_SCHEMA_VERSION);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND (name LIKE 'provider\\_%' ESCAPE '\\'
            OR name LIKE 'legacy\\_session\\_%' ESCAPE '\\')
        ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([...PROVIDER_TABLES].sort());
    db.close();
  });

  it("matches the hardcoded table_info and foreign_key_list golden shapes", () => {
    const db = openDatabase();
    migrateV13(db);

    for (const table of PROVIDER_TABLES) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all()).toEqual(expectedTableInfo(table));
      expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all())
        .toEqual(expectedForeignKeys(table));
    }
    db.close();
  });

  it("creates the same provider/legacy sqlite_master shape for a fresh TranscriptIndex", () => {
    const dir = tempDir();
    const freshFile = path.join(dir, "fresh.db");
    const upgradedFile = path.join(dir, "upgraded.db");

    const index = new TranscriptIndex(freshFile);
    index.close();
    const fresh = openDatabase(freshFile);

    const upgraded = openDatabase(upgradedFile);
    migrateV13(upgraded);

    expect(userVersion(fresh)).toBe(PROVIDER_INDEX_SCHEMA_VERSION);
    expect(userVersion(upgraded)).toBe(PROVIDER_INDEX_SCHEMA_VERSION);
    expect(providerSchema(fresh)).toEqual(providerSchema(upgraded));
    fresh.close();
    upgraded.close();
  });

  it("is idempotent when rerun, including after user_version is reset to 13", () => {
    const db = openDatabase();
    migrateV13(db);
    const firstSchema = providerSchema(db);

    runMigrations(db);
    expect(providerSchema(db)).toEqual(firstSchema);

    db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);
    runMigrations(db);
    expect(userVersion(db)).toBe(PROVIDER_INDEX_SCHEMA_VERSION);
    expect(providerSchema(db)).toEqual(firstSchema);
    db.close();
  });

  it("rolls back every earlier v14 object and the version on a mid-DDL conflict", () => {
    const db = openDatabase();
    db.exec("CREATE VIEW provider_event_cache AS SELECT 1 AS conflict");
    db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);

    expect(() => runMigrations(db)).toThrow();

    expect(userVersion(db)).toBe(PRE_PROVIDER_INDEX_SCHEMA_VERSION);
    expect(
      db.prepare(`SELECT type, name FROM sqlite_master
        WHERE (name LIKE 'provider\\_%' ESCAPE '\\' OR name LIKE 'legacy\\_session\\_%' ESCAPE '\\')
        ORDER BY name`).all(),
    ).toEqual([{ type: "view", name: "provider_event_cache" }]);
    expect(
      db.prepare("SELECT conflict FROM provider_event_cache").get(),
    ).toEqual({ conflict: 1 });
    db.close();
  });

  it("rejects a lax preexisting provider table without replacing its sentinel row", () => {
    const db = openDatabase();
    db.exec("CREATE TABLE provider_homes (sentinel TEXT NOT NULL)");
    db.prepare("INSERT INTO provider_homes VALUES (?)").run("keep-table");
    db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);

    expect(() => runMigrations(db)).toThrow("provider index schema validation failed");

    expect(userVersion(db)).toBe(PRE_PROVIDER_INDEX_SCHEMA_VERSION);
    expect(db.prepare("SELECT * FROM provider_homes").all())
      .toEqual([{ sentinel: "keep-table" }]);
    expect(providerSchema(db)).toEqual([
      {
        type: "table",
        name: "provider_homes",
        tbl_name: "provider_homes",
        sql: "CREATE TABLE provider_homes (sentinel TEXT NOT NULL)",
      },
    ]);
    db.close();
  });

  it("rejects a preexisting provider-named view without replacing its sentinel value", () => {
    const db = openDatabase();
    db.exec("CREATE VIEW legacy_session_provenance AS SELECT 'keep-view' AS sentinel");
    db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);

    expect(() => runMigrations(db)).toThrow("provider index schema validation failed");

    expect(userVersion(db)).toBe(PRE_PROVIDER_INDEX_SCHEMA_VERSION);
    expect(db.prepare("SELECT * FROM legacy_session_provenance").all())
      .toEqual([{ sentinel: "keep-view" }]);
    expect(
      db.prepare(`SELECT type, name FROM sqlite_master
        WHERE name = 'legacy_session_provenance'`).all(),
    ).toEqual([{ type: "view", name: "legacy_session_provenance" }]);
    db.close();
  });

  it("leaves v13 session, metadata, and settings sentinel rows exactly unchanged", () => {
    const db = openDatabase();
    db.exec(`CREATE TABLE sessions (
      sessionId TEXT PRIMARY KEY,
      title TEXT,
      messageCount INTEGER NOT NULL
    );
    CREATE TABLE session_meta (
      sessionId TEXT PRIMARY KEY,
      customTitle TEXT,
      pinned INTEGER NOT NULL,
      tags TEXT,
      archived INTEGER NOT NULL,
      notes TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("legacy-session", "Original", 7);
    db.prepare("INSERT INTO session_meta VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy-session", "Local title", 1, '["kept"]', 0, "Legacy notes");
    db.prepare("INSERT INTO settings VALUES (?, ?)").run("theme", '"dark"');

    const before = {
      sessions: db.prepare("SELECT * FROM sessions ORDER BY sessionId").all(),
      meta: db.prepare("SELECT * FROM session_meta ORDER BY sessionId").all(),
      settings: db.prepare("SELECT * FROM settings ORDER BY key").all(),
    };

    migrateV13(db);

    expect({
      sessions: db.prepare("SELECT * FROM sessions ORDER BY sessionId").all(),
      meta: db.prepare("SELECT * FROM session_meta ORDER BY sessionId").all(),
      settings: db.prepare("SELECT * FROM settings ORDER BY key").all(),
    }).toEqual(before);
    db.close();
  });

  it("does not downgrade or mutate a future user_version", () => {
    const db = openDatabase();
    db.exec("CREATE TABLE future_sentinel (value TEXT NOT NULL)");
    db.prepare("INSERT INTO future_sentinel VALUES (?)").run("preserved");
    const futureVersion = PROVIDER_INDEX_SCHEMA_VERSION + 1;
    db.exec(`PRAGMA user_version = ${futureVersion}`);

    runMigrations(db);

    expect(userVersion(db)).toBe(futureVersion);
    expect(providerSchema(db)).toEqual([]);
    expect(db.prepare("SELECT * FROM future_sentinel").all()).toEqual([{ value: "preserved" }]);
    db.close();
  });

  it("rejects invalid provider homes and inconsistent staging state", () => {
    const db = openDatabase();
    migrateV13(db);

    expect(() => registerHome(db, "other")).toThrow();
    expect(() => registerHome(db, "openai", "A".repeat(64))).toThrow();
    expect(() => registerHome(db, "openai", HOME_FINGERPRINT, "bad\0home")).toThrow();

    registerHome(db);
    const stage = db.prepare(`INSERT INTO provider_sync_state (
      provider, home_fingerprint, active_generation, staging_generation,
      staging_owner_token, staging_heartbeat_at, staging_expires_at,
      state, provider_version, last_completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    expect(() => stage.run(
      "openai", HOME_FINGERPRINT, 0, 1, null, null, null, "staging", "1.0", null,
    )).toThrow();
    expect(() => stage.run(
      "openai", HOME_FINGERPRINT, 2, 2, "owner", 10, 20, "staging", "1.0", null,
    )).toThrow();
    expect(() => stage.run(
      "openai", HOME_FINGERPRINT, 0, 1, "   ", 10, 20, "staging", "1.0", null,
    )).toThrow();

    expect(() => stage.run(
      "openai", HOME_FINGERPRINT, 0, 1, "owner", 10, 20, "staging", "1.0", null,
    )).not.toThrow();
    db.close();
  });

  it.each([
    ["home_fingerprint", (db: TestDatabase) => {
      registerHome(db, "openai", `${HOME_FINGERPRINT}\0`);
    }],
    ["event_fingerprint", (db: TestDatabase) => {
      registerHome(db);
      insertTask(db);
      insertTurn(db);
      insertEvent(db, { eventFingerprint: `${EVENT_FINGERPRINT}\0` });
    }],
    ["snapshot_fingerprint", (db: TestDatabase) => {
      registerHome(db);
      insertTask(db);
      insertReceipt(db, { snapshotFingerprint: `${SNAPSHOT_FINGERPRINT}\0` });
    }],
    ["transfer_digest", (db: TestDatabase) => {
      db.prepare(`INSERT INTO provider_fork_links (
        source_provider, source_home_fingerprint, source_native_task_id,
        target_provider, target_home_fingerprint, target_native_task_id,
        created_at, transfer_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "openai", HOME_FINGERPRINT, "task-1",
          "anthropic", TARGET_HOME_FINGERPRINT, "task-2",
          3_000, `${TRANSFER_DIGEST}\0`,
        );
    }],
  ] as const)("rejects a 64-hex value with a NUL suffix for %s", (_family, write) => {
    const db = openDatabase();
    migrateV13(db);
    try {
      expect(() => write(db)).toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects invalid task cache values, oversized JSON, and missing parents", () => {
    const db = openDatabase();
    migrateV13(db);
    registerHome(db);

    expect(() => insertTask(db, { archived: 2 })).toThrow();
    expect(() => insertTask(db, { source: "guessed" })).toThrow();
    expect(() => insertTask(db, { fingerprint: TARGET_HOME_FINGERPRINT })).toThrow();

    expect(() => db.prepare(`INSERT INTO provider_task_meta (
      provider, home_fingerprint, native_task_id, favorite, pinned, local_label,
      tags_json, notes, local_archived, ui_state_json, unsupported_local_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "meta-oversize", 0, 0, null,
        "x".repeat(65_537), null, 0, "{}", "{}", 1,
      )).toThrow();

    insertTask(db);
    db.prepare(`INSERT INTO provider_turn_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, status, started_at, completed_at, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "task-1", 1,
        "native:v1:turn", "complete", null, null, 0,
      );
    expect(() => db.prepare(`INSERT INTO provider_event_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, native_item_key, replay_key, ordinal,
      event_fingerprint, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "task-1", 1,
        "native:v1:turn", "native:v1:item", "replay:v1:0:test", 0,
        EVENT_FINGERPRINT, "x".repeat(8_388_609),
      )).toThrow();
    db.close();
  });

  it("isolates cache children by exact generation and preserves generation 2 on generation 1 deletion", () => {
    const db = openDatabase();
    migrateV13(db);
    registerHome(db);
    insertTask(db, { cacheGeneration: 1 });
    insertTask(db, { cacheGeneration: 2 });
    insertTurn(db, { cacheGeneration: 1, nativeTurnKey: "native:v1:shared-turn" });

    expect(() => insertTurn(db, {
      cacheGeneration: 3,
      nativeTurnKey: "native:v1:shared-turn",
    })).toThrow();
    expect(() => insertEvent(db, {
      cacheGeneration: 2,
      nativeTurnKey: "native:v1:shared-turn",
    })).toThrow();
    expect(() => insertReceipt(db, { cacheGeneration: 3 })).toThrow();

    insertTurn(db, { cacheGeneration: 2, nativeTurnKey: "native:v1:shared-turn" });
    insertEvent(db, { cacheGeneration: 1, nativeTurnKey: "native:v1:shared-turn" });
    insertEvent(db, { cacheGeneration: 2, nativeTurnKey: "native:v1:shared-turn" });
    insertReceipt(db, { cacheGeneration: 1 });
    insertReceipt(db, { cacheGeneration: 2 });

    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?`)
      .run("openai", HOME_FINGERPRINT, "task-1", 1);

    for (const table of [
      "provider_task_cache",
      "provider_turn_cache",
      "provider_event_cache",
      "provider_replay_receipts",
    ]) {
      expect(db.prepare(`SELECT cache_generation FROM ${table}`).all())
        .toEqual([{ cache_generation: 2 }]);
    }
    db.close();
  });

  it("isolates identical native task IDs across providers and provider homes", () => {
    const db = openDatabase();
    migrateV13(db);
    registerHome(db, "openai", HOME_FINGERPRINT, "/tmp/openai-home-one");
    registerHome(db, "openai", TARGET_HOME_FINGERPRINT, "/tmp/openai-home-two");
    registerHome(db, "anthropic", HOME_FINGERPRINT, "/tmp/anthropic-home");

    const scopes = [
      { provider: "openai", fingerprint: HOME_FINGERPRINT },
      { provider: "openai", fingerprint: TARGET_HOME_FINGERPRINT },
      { provider: "anthropic", fingerprint: HOME_FINGERPRINT },
    ] as const;
    for (const locator of scopes) {
      insertTask(db, locator);
      insertTurn(db, locator);
      insertEvent(db, locator);
      insertReceipt(db, locator);
    }

    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?`)
      .run("openai", HOME_FINGERPRINT, "task-1", 1);

    const survivors = [
      { provider: "anthropic", home_fingerprint: HOME_FINGERPRINT },
      { provider: "openai", home_fingerprint: TARGET_HOME_FINGERPRINT },
    ];
    for (const table of [
      "provider_task_cache",
      "provider_turn_cache",
      "provider_event_cache",
      "provider_replay_receipts",
    ]) {
      expect(db.prepare(`SELECT provider, home_fingerprint FROM ${table}
        ORDER BY provider, home_fingerprint`).all()).toEqual(survivors);
    }
    db.close();
  });

  it("cascades only rebuildable cache children when a task generation is deleted", () => {
    const db = openDatabase();
    migrateV13(db);
    registerHome(db);
    const deleteHome = db.prepare(`DELETE FROM provider_homes
      WHERE provider = ? AND home_fingerprint = ?`);

    db.prepare(`INSERT INTO provider_sync_state (provider, home_fingerprint)
      VALUES (?, ?)`).run("openai", HOME_FINGERPRINT);
    expect(() => deleteHome.run("openai", HOME_FINGERPRINT)).toThrow();
    db.prepare(`DELETE FROM provider_sync_state
      WHERE provider = ? AND home_fingerprint = ?`)
      .run("openai", HOME_FINGERPRINT);

    insertTask(db);
    expect(() => deleteHome.run("openai", HOME_FINGERPRINT)).toThrow();

    db.prepare(`INSERT INTO provider_turn_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, status, started_at, completed_at, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "task-1", 1,
        "native:v1:turn-1", "complete",
        "2026-07-13T00:00:00.000Z", "2026-07-13T00:01:00.000Z", 0,
      );
    db.prepare(`INSERT INTO provider_event_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, native_item_key, replay_key, ordinal,
      event_fingerprint, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "task-1", 1,
        "native:v1:turn-1", "native:v1:item-1", "replay:v1:0:event", 0,
        EVENT_FINGERPRINT, '{"type":"message"}',
      );
    db.prepare(`INSERT INTO provider_replay_receipts (
      provider, home_fingerprint, native_task_id, cache_generation,
      replay_key, snapshot_fingerprint, event_count, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "task-1", 1,
        "snapshot:v1:task-1", SNAPSHOT_FINGERPRINT, 1, 2_000,
      );

    db.prepare(`INSERT INTO provider_task_meta (
      provider, home_fingerprint, native_task_id, favorite, pinned, local_label,
      tags_json, notes, local_archived, ui_state_json, unsupported_local_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "task-1", 1, 1, "Keep me",
        '["schema"]', "Durable notes", 0, "{}", "{}", 3_000,
      );
    db.prepare(`INSERT INTO provider_fork_links (
      source_provider, source_home_fingerprint, source_native_task_id,
      target_provider, target_home_fingerprint, target_native_task_id,
      created_at, transfer_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "task-1",
        "anthropic", TARGET_HOME_FINGERPRINT, "task-2",
        3_000, TRANSFER_DIGEST,
      );
    db.prepare(`INSERT INTO provider_reconciliation_state (
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai", HOME_FINGERPRINT, "task-1", 1, 1,
        "openai:v1:reviewed", "openai:v1:native", 2, "external-change", 4_000,
      );
    db.prepare(`INSERT INTO legacy_session_task_map (
      legacy_session_id, provider, home_fingerprint, native_task_id,
      mapping_source, verified_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        "legacy-mapped", "openai", HOME_FINGERPRINT, "task-1",
        "authoritative-native-observation", 5_000,
      );
    db.prepare(`INSERT INTO legacy_session_provenance (
      legacy_session_id, provenance, observed_at
    ) VALUES (?, ?, ?)`)
      .run("legacy-unresolved", "archive-v1-import", 5_000);

    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?`)
      .run("openai", HOME_FINGERPRINT, "task-1", 1);

    for (const table of [
      "provider_task_cache",
      "provider_turn_cache",
      "provider_event_cache",
      "provider_replay_receipts",
    ]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    for (const table of [
      "provider_task_meta",
      "provider_fork_links",
      "provider_reconciliation_state",
      "legacy_session_task_map",
      "legacy_session_provenance",
    ]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
    }

    expect(() => deleteHome.run("openai", HOME_FINGERPRINT)).not.toThrow();
    expect(db.prepare("SELECT count(*) AS count FROM provider_homes").get())
      .toEqual({ count: 0 });
    for (const table of [
      "provider_task_meta",
      "provider_fork_links",
      "provider_reconciliation_state",
      "legacy_session_task_map",
      "legacy_session_provenance",
    ]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
    }
    db.close();
  });
});
