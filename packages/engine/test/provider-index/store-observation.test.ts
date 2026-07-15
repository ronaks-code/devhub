import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrations.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";
import {
  taskLocator,
  type ProviderTaskLocator,
} from "../../src/provider-index/identity.js";
import { normalizeProviderEvent } from "../../src/providers/events.js";
import type { NativeTask, NativeTaskKey, NativeTaskSummary } from "../../src/providers/types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

interface ObservationMethods {
  issueTaskObservationToken(locator: ProviderTaskLocator): object;
  dropTaskObservationToken(token: object): void;
  markNativeTaskMissing(token: object): Readonly<{
    reconciliation: Readonly<{
      reason: string | null;
      latchRevision: number;
      reviewedFingerprint: string | null;
      nativeFingerprint: string | null;
      writerEpoch: number;
    }>;
    cache: Readonly<{
      taskCount: number;
      turnCount: number;
      eventCount: number;
      receiptCount: number;
    }>;
  }>;
  replaceObservedActiveSummary(
    token: object,
    summary: NativeTaskSummary,
    observedAt: number,
  ): Readonly<{ title: string }> | null;
  replaceObservedActiveSnapshot(
    token: object,
    task: NativeTask,
    observedAt: number,
  ): Readonly<{ title: string; turns: readonly unknown[] }> | null;
}

const databases: TestDatabase[] = [];
const directories: string[] = [];

function observationStore(store: ProviderTaskIndexStore): ProviderTaskIndexStore & ObservationMethods {
  return store as ProviderTaskIndexStore & ObservationMethods;
}

function openDatabase(filename = ":memory:", migrate = true): TestDatabase {
  const db = new DatabaseSync(filename);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  if (migrate) {
    db.exec("PRAGMA user_version = 13");
    runMigrations(db);
  }
  return db;
}

function temporaryDatabasePath(): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "devhub-observation-db-")));
  directories.push(directory);
  return path.join(directory, "provider-index.sqlite");
}

function fixture(options: Readonly<{
  filename?: string;
  now?: () => number;
}> = {}): Readonly<{
  db: TestDatabase;
  store: ProviderTaskIndexStore & ObservationMethods;
  locator: ProviderTaskLocator;
  key: NativeTaskKey;
}> {
  const db = openDatabase(options.filename);
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "devhub-observation-")));
  directories.push(home);
  const store = observationStore(new ProviderTaskIndexStore(db, { now: options.now ?? (() => 100) }));
  const registration = store.registerHome({ provider: "openai", home }, 1);
  const key = Object.freeze({ provider: "openai", home, nativeTaskId: "task-observed" } as const);
  return Object.freeze({
    db,
    store,
    key,
    locator: Object.freeze({
      version: 1,
      provider: "openai",
      homeFingerprint: registration.homeFingerprint,
      nativeTaskId: key.nativeTaskId,
    }),
  });
}

function summary(key: NativeTaskKey, title = "Observed task"): NativeTaskSummary {
  return Object.freeze({
    key,
    title,
    cwd: null,
    model: "provider-model",
    status: "idle",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:01:00.000Z",
    archived: false,
    source: "native",
    revision: Object.freeze({
      updatedAt: 1,
      status: "complete",
      lastTurnId: "turn-1",
      lastTurnStatus: "complete",
      lastItemId: "item-1",
      fingerprint: "openai:v1:observed-revision",
    }),
  });
}

function snapshot(key: NativeTaskKey, title = "Observed task"): NativeTask {
  const event = normalizeProviderEvent({
    type: "message",
    role: "assistant",
    text: "observed response",
    turnId: "turn-1",
    itemId: "item-1",
  }, {
    provider: key.provider,
    key,
    occurredAt: "2026-07-14T00:00:30.000Z",
  });
  return Object.freeze({
    ...summary(key, title),
    turns: Object.freeze([Object.freeze({
      id: "turn-1",
      status: "complete",
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:01:00.000Z",
      events: Object.freeze([event]),
    })]),
  });
}

function promoteSnapshot(
  store: ProviderTaskIndexStore,
  key: NativeTaskKey,
): void {
  const handle = store.beginStage({
    provider: key.provider,
    homeFingerprint: store.registerHome({ provider: key.provider, home: key.home }, 1)
      .homeFingerprint,
  });
  store.stageSnapshot(handle, key, snapshot(key));
  store.promoteStage(handle, {
    completedAt: 500,
    providerVersion: null,
    taskCount: 1,
    turnCount: 1,
    eventCount: 1,
    snapshotCount: 1,
    receiptCount: 1,
  });
}

function expectStoreError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected ProviderIndexStoreError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderIndexStoreError);
    expect((error as ProviderIndexStoreError).code).toBe(code);
  }
}

function totalChanges(db: TestDatabase): bigint {
  const statement = db.prepare("SELECT total_changes() AS count");
  statement.setReadBigInts(true);
  return (statement.get() as { count: bigint }).count;
}

afterEach(() => {
  while (databases.length > 0) {
    const db = databases.pop()!;
    try {
      db.close();
    } catch {
      // Tests that exercise unavailable storage may already have closed it.
    }
  }
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("ProviderTaskIndexStore observation capabilities", () => {
  it("issues a frozen property-free null-prototype token", () => {
    const { store, locator } = fixture();

    const token = store.issueTaskObservationToken(locator);

    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.getPrototypeOf(token)).toBeNull();
    expect(Reflect.ownKeys(token)).toEqual([]);
  });

  it("rejects a cloned token", () => {
    const { store, locator } = fixture();
    const token = store.issueTaskObservationToken(locator);
    const clone = Object.assign(Object.create(null), token) as object;

    expectStoreError(() => store.markNativeTaskMissing(clone), "INVALID_INPUT");
  });

  it("rejects a token issued by another store", () => {
    const first = fixture();
    const second = fixture();
    const token = first.store.issueTaskObservationToken(first.locator);

    expectStoreError(() => second.store.markNativeTaskMissing(token), "INVALID_INPUT");
  });

  it("explicitly drops a token without mutating durable state", () => {
    const { store, locator } = fixture();
    const before = store.getReconciliation(locator);
    const token = store.issueTaskObservationToken(locator);

    store.dropTaskObservationToken(token);

    expect(store.getReconciliation(locator)).toEqual(before);
    expectStoreError(() => store.markNativeTaskMissing(token), "INVALID_INPUT");
  });

  it("atomically marks an empty observed task missing", () => {
    const { store, locator } = fixture();
    const token = store.issueTaskObservationToken(locator);

    const result = store.markNativeTaskMissing(token);

    expect(result.cache).toEqual({ taskCount: 0, turnCount: 0, eventCount: 0, receiptCount: 0 });
    expect(result.reconciliation.reason).toBe("NATIVE_TASK_MISSING");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cache)).toBe(true);
    expect(Object.isFrozen(result.reconciliation)).toBe(true);
  });

  it("consumes a token after its first transaction attempt", () => {
    const { store, locator } = fixture();
    const token = store.issueTaskObservationToken(locator);

    store.markNativeTaskMissing(token);

    expectStoreError(() => store.markNativeTaskMissing(token), "INVALID_INPUT");
  });

  it("does not materialize active child rows while issuing or consuming missing authority", () => {
    const { db, store, key, locator } = fixture();
    promoteSnapshot(store, key);
    const originalPrepare = db.prepare.bind(db);
    let childMaterializationAttempts = 0;
    Object.defineProperty(db, "prepare", {
      configurable: true,
      value: (sql: string) => {
        const statement = originalPrepare(sql);
        if (!/^\s*SELECT[\s\S]*\bFROM provider_(?:turn_cache|event_cache)/u.test(sql)) {
          return statement;
        }
        const rejectMaterialization = () => {
          childMaterializationAttempts += 1;
          throw new Error("observation child materialization is forbidden");
        };
        return {
          all: rejectMaterialization,
          iterate: rejectMaterialization,
          get: (...parameters: Array<string | number | null>) => {
            if (!/COUNT\(\*\)/u.test(sql)) rejectMaterialization();
            return statement.get(...parameters);
          },
        };
      },
    });

    const token = store.issueTaskObservationToken(locator);
    const result = store.markNativeTaskMissing(token);

    expect(result.cache).toEqual({ taskCount: 1, turnCount: 1, eventCount: 1, receiptCount: 1 });
    expect(childMaterializationAttempts).toBe(0);
  });

  it("replaces an active summary through the observed token authority", () => {
    const { store, key, locator } = fixture();
    promoteSnapshot(store, key);
    const token = store.issueTaskObservationToken(locator);

    const result = store.replaceObservedActiveSummary(token, summary(key), 600);

    expect(result).toMatchObject({ title: "Observed task" });
    expect(store.read(locator)).toMatchObject({ observedAt: 600, cacheDetail: "snapshot" });
  });

  it("replaces an active snapshot through the observed token authority", () => {
    const { store, key, locator } = fixture();
    promoteSnapshot(store, key);
    const token = store.issueTaskObservationToken(locator);

    const result = store.replaceObservedActiveSnapshot(token, snapshot(key), 600);

    expect(result).toMatchObject({ title: "Observed task" });
    expect(result?.turns).toHaveLength(1);
    expect(store.read(locator)).toMatchObject({ observedAt: 600, cacheDetail: "snapshot" });
  });

  it("rejects a mismatched task key before consuming the token", () => {
    const { store, key, locator } = fixture();
    promoteSnapshot(store, key);
    const token = store.issueTaskObservationToken(locator);
    const wrongKey = Object.freeze({ ...key, nativeTaskId: "different-task" });

    expectStoreError(
      () => store.replaceObservedActiveSummary(token, summary(wrongKey), 600),
      "INVALID_INPUT",
    );
    expect(store.replaceObservedActiveSummary(token, summary(key), 600)).not.toBeNull();
  });

  it("consumes a token-backed null replacement and rejects replay", () => {
    const { store, key, locator } = fixture();
    const token = store.issueTaskObservationToken(locator);

    expect(store.replaceObservedActiveSummary(token, summary(key), 600)).toBeNull();
    expectStoreError(() => store.markNativeTaskMissing(token), "INVALID_INPUT");
  });

  it("rejects same-connection authority drift and consumes the attempted token", () => {
    const { store, key, locator } = fixture();
    promoteSnapshot(store, key);
    const token = store.issueTaskObservationToken(locator);
    store.replaceActiveSummary(key, summary(key, "Newer observation"), 550);

    expectStoreError(() => store.markNativeTaskMissing(token), "RECONCILIATION_CAS_MISMATCH");
    expectStoreError(() => store.markNativeTaskMissing(token), "INVALID_INPUT");
  });

  it("rejects byte-restored same-connection ABA through total_changes authority", () => {
    const { db, store, locator } = fixture();
    const token = store.issueTaskObservationToken(locator);
    db.prepare(`UPDATE provider_homes SET registered_at = registered_at + 1
      WHERE provider = ? AND home_fingerprint = ?`)
      .run(locator.provider, locator.homeFingerprint);
    db.prepare(`UPDATE provider_homes SET registered_at = registered_at - 1
      WHERE provider = ? AND home_fingerprint = ?`)
      .run(locator.provider, locator.homeFingerprint);

    expectStoreError(() => store.markNativeTaskMissing(token), "RECONCILIATION_CAS_MISMATCH");
    expectStoreError(() => store.markNativeTaskMissing(token), "INVALID_INPUT");
  });

  it("rejects peer-connection data-version ABA drift", () => {
    const filename = temporaryDatabasePath();
    const { store, locator } = fixture({ filename });
    const token = store.issueTaskObservationToken(locator);
    const peer = openDatabase(filename, false);
    peer.prepare(`UPDATE provider_homes SET registered_at = registered_at + 1
      WHERE provider = ? AND home_fingerprint = ?`)
      .run(locator.provider, locator.homeFingerprint);
    peer.prepare(`UPDATE provider_homes SET registered_at = registered_at - 1
      WHERE provider = ? AND home_fingerprint = ?`)
      .run(locator.provider, locator.homeFingerprint);

    expectStoreError(() => store.markNativeTaskMissing(token), "RECONCILIATION_CAS_MISMATCH");
  });

  it("keeps an orphan token for missing while rejecting observed replacement input", () => {
    const db = openDatabase();
    const store = observationStore(new ProviderTaskIndexStore(db, { now: () => 100 }));
    const home = "/tmp/orphan-provider-home";
    const key = Object.freeze({ provider: "openai", home, nativeTaskId: "orphan-task" } as const);
    const locator = taskLocator(key);
    const token = store.issueTaskObservationToken(locator);

    expectStoreError(
      () => store.replaceObservedActiveSummary(token, summary(key), 600),
      "INVALID_INPUT",
    );
    expect(store.markNativeTaskMissing(token).reconciliation.reason).toBe("NATIVE_TASK_MISSING");
  });

  it("distinguishes corrupt authority at issuance and consumption", () => {
    const first = fixture();
    promoteSnapshot(first.store, first.key);
    first.db.exec("PRAGMA ignore_check_constraints = ON");
    first.db.prepare(`UPDATE provider_task_cache SET cwd_redacted = 2
      WHERE native_task_id = ?`).run(first.key.nativeTaskId);
    expectStoreError(
      () => first.store.issueTaskObservationToken(first.locator),
      "CORRUPT_ROW",
    );

    const second = fixture();
    promoteSnapshot(second.store, second.key);
    const token = second.store.issueTaskObservationToken(second.locator);
    second.db.exec("PRAGMA ignore_check_constraints = ON");
    second.db.prepare(`UPDATE provider_task_cache SET cwd_redacted = 2
      WHERE native_task_id = ?`).run(second.key.nativeTaskId);
    expectStoreError(() => second.store.markNativeTaskMissing(token), "CORRUPT_ROW");
    expectStoreError(() => second.store.markNativeTaskMissing(token), "INVALID_INPUT");
  });

  it("rejects corrupt bounded receipt authority without reading transcript children", () => {
    const { db, store, key, locator } = fixture();
    promoteSnapshot(store, key);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(`UPDATE provider_replay_receipts
      SET snapshot_fingerprint = 'not-a-fingerprint'
      WHERE native_task_id = ?`).run(locator.nativeTaskId);

    expectStoreError(() => store.issueTaskObservationToken(locator), "CORRUPT_ROW");
  });

  it("deletes every generation exactly and derives the active reviewed fingerprint", () => {
    const { db, store, key, locator } = fixture();
    promoteSnapshot(store, key);
    const stage = store.beginStage({
      provider: locator.provider,
      homeFingerprint: locator.homeFingerprint,
    });
    store.stageSnapshot(stage, key, snapshot(key, "Staged copy"));
    const syncBefore = db.prepare(`SELECT * FROM provider_sync_state`).get();
    const token = store.issueTaskObservationToken(locator);
    const changesBefore = totalChanges(db);

    const result = store.markNativeTaskMissing(token);

    expect(result.cache).toEqual({ taskCount: 2, turnCount: 2, eventCount: 2, receiptCount: 2 });
    expect(result.reconciliation).toMatchObject({
      reviewedFingerprint: "openai:v1:observed-revision",
      nativeFingerprint: null,
      writerEpoch: 0,
      reason: "NATIVE_TASK_MISSING",
    });
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(syncBefore);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_task_cache`).get())
      .toEqual({ count: 0 });
    expect(totalChanges(db) - changesBefore).toBe(9n);
  });

  it("returns an exact idempotent missing latch without relatching", () => {
    const { db, store, locator } = fixture();
    store.markNativeTaskMissing(store.issueTaskObservationToken(locator));
    const before = store.getReconciliation(locator);
    const changesBefore = totalChanges(db);

    const repeated = store.markNativeTaskMissing(store.issueTaskObservationToken(locator));

    expect(repeated.cache).toEqual({ taskCount: 0, turnCount: 0, eventCount: 0, receiptCount: 0 });
    expect(repeated.reconciliation).toEqual(before);
    expect(totalChanges(db) - changesBefore).toBe(0n);
  });

  it("rolls back cache deletion when the reconciliation write is suppressed", () => {
    const { db, store, key, locator } = fixture();
    promoteSnapshot(store, key);
    const token = store.issueTaskObservationToken(locator);
    db.exec(`CREATE TRIGGER suppress_missing_latch
      BEFORE INSERT ON provider_reconciliation_state
      BEGIN SELECT RAISE(IGNORE); END`);

    expectStoreError(() => store.markNativeTaskMissing(token), "CORRUPT_ROW");
    expect(store.read(locator)).toMatchObject({ cacheDetail: "snapshot" });
    expect(store.getReconciliation(locator).reason).toBeNull();
  });

  it("rolls back cache deletion when latch revision is at capacity", () => {
    const { db, store, key, locator } = fixture();
    promoteSnapshot(store, key);
    db.prepare(`INSERT INTO provider_reconciliation_state (
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, NULL, 0, 'REPLAY_CONFLICT', 90)`)
      .run(
        locator.provider,
        locator.homeFingerprint,
        locator.nativeTaskId,
        Number.MAX_SAFE_INTEGER,
        "openai:v1:observed-revision",
      );
    const before = db.prepare(`SELECT * FROM provider_reconciliation_state`).get();
    const token = store.issueTaskObservationToken(locator);

    expectStoreError(() => store.markNativeTaskMissing(token), "CAPACITY");
    expect(store.read(locator)).toMatchObject({ cacheDetail: "snapshot" });
    expect(db.prepare(`SELECT * FROM provider_reconciliation_state`).get()).toEqual(before);
    expectStoreError(() => store.markNativeTaskMissing(token), "INVALID_INPUT");
  });

  it("retains a token before transaction admission or a successful clock sample", () => {
    let failClock = false;
    const { db, store, locator } = fixture({
      now: () => {
        if (failClock) throw new Error("clock unavailable");
        return 100;
      },
    });
    const token = store.issueTaskObservationToken(locator);
    db.exec("BEGIN");
    expectStoreError(() => store.markNativeTaskMissing(token), "DATABASE_UNAVAILABLE");
    db.exec("ROLLBACK");
    failClock = true;
    expectStoreError(() => store.markNativeTaskMissing(token), "CLOCK_FAILURE");
    failClock = false;
    expect(store.markNativeTaskMissing(token).reconciliation.reason).toBe("NATIVE_TASK_MISSING");
  });

  it("consumes a token when BEGIN is closed or busy", () => {
    const closed = fixture();
    const closedToken = closed.store.issueTaskObservationToken(closed.locator);
    closed.db.close();
    expectStoreError(() => closed.store.markNativeTaskMissing(closedToken), "DATABASE_UNAVAILABLE");
    expectStoreError(() => closed.store.markNativeTaskMissing(closedToken), "INVALID_INPUT");

    const filename = temporaryDatabasePath();
    const busy = fixture({ filename });
    const busyToken = busy.store.issueTaskObservationToken(busy.locator);
    const peer = openDatabase(filename, false);
    peer.exec("BEGIN IMMEDIATE");
    expectStoreError(() => busy.store.markNativeTaskMissing(busyToken), "DATABASE_UNAVAILABLE");
    peer.exec("ROLLBACK");
    expectStoreError(() => busy.store.markNativeTaskMissing(busyToken), "INVALID_INPUT");
  });

  it("preserves durable and foreign authority while clearing only the target", () => {
    const { db, store, key, locator } = fixture();
    promoteSnapshot(store, key);
    const foreignKey = Object.freeze({ ...key, nativeTaskId: "foreign-task" });
    const foreignLocator = taskLocator(foreignKey);
    store.replaceActiveSnapshot(foreignKey, snapshot(foreignKey, "Foreign"), 501);
    store.patchMeta(locator, { favorite: true });
    store.classifyLegacySession("legacy-observed", "imported", 3);
    store.mapVerifiedLegacySession("legacy-observed", locator, {
      mappingSource: "live-provider-observation",
      verifiedAt: 4,
    });
    store.linkFork(locator, foreignLocator, "a".repeat(64), 5);
    const tables = [
      "provider_homes",
      "provider_sync_state",
      "provider_task_meta",
      "provider_fork_links",
      "legacy_session_task_map",
      "legacy_session_provenance",
    ] as const;
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());

    store.markNativeTaskMissing(store.issueTaskObservationToken(locator));

    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(store.read(foreignLocator)).toMatchObject({ title: "Foreign" });
    expect(store.read(locator)).toBeNull();
  });
});
