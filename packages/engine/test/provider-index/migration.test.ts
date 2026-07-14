import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptIndex } from "../../src/index-db.js";
import { runMigrations } from "../../src/migrations.js";

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

const HOME_FINGERPRINT = "a".repeat(64);
const TARGET_HOME_FINGERPRINT = "b".repeat(64);
const EVENT_FINGERPRINT = "c".repeat(64);
const SNAPSHOT_FINGERPRINT = "d".repeat(64);
const TRANSFER_DIGEST = "e".repeat(64);

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
  db.exec("PRAGMA user_version = 13");
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

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider index v14 migration", () => {
  it("upgrades a v13 database additively and advances user_version to 14", () => {
    const db = openDatabase();
    migrateV13(db);

    expect(userVersion(db)).toBe(14);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${PROVIDER_TABLES.map(() => "?").join(", ")}) ORDER BY name`)
      .all(...PROVIDER_TABLES) as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([...PROVIDER_TABLES].sort());
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

    expect(userVersion(fresh)).toBe(14);
    expect(userVersion(upgraded)).toBe(14);
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

    db.exec("PRAGMA user_version = 13");
    runMigrations(db);
    expect(userVersion(db)).toBe(14);
    expect(providerSchema(db)).toEqual(firstSchema);
    db.close();
  });

  it("rolls back every earlier v14 object and the version on a mid-DDL conflict", () => {
    const db = openDatabase();
    db.exec("CREATE VIEW provider_event_cache AS SELECT 1 AS conflict");
    db.exec("PRAGMA user_version = 13");

    expect(() => runMigrations(db)).toThrow();

    expect(userVersion(db)).toBe(13);
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
    db.exec("PRAGMA user_version = 15");

    runMigrations(db);

    expect(userVersion(db)).toBe(15);
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

  it("cascades only rebuildable cache children when a task generation is deleted", () => {
    const db = openDatabase();
    migrateV13(db);
    registerHome(db);
    insertTask(db);

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
    ]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
    }
    db.close();
  });
});
