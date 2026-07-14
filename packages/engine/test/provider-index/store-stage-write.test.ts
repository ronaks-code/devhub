import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrations.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import { normalizeProviderEvent } from "../../src/providers/events.js";
import type {
  ProviderIndexCompletion,
  ProviderIndexStage,
  ProviderIndexStoreOptions,
} from "../../src/provider-index/store-types.js";
import { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";
import type {
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
} from "../../src/providers/types.js";

const { DatabaseSync, constants } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const databases: TestDatabase[] = [];
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "devhub-provider-stage-write-"));
  directories.push(directory);
  return realpathSync(directory);
}

function openDatabase(filename = ":memory:"): TestDatabase {
  const db = new DatabaseSync(filename);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA user_version = 13");
  runMigrations(db);
  return db;
}

function reopenDatabase(filename: string): TestDatabase {
  const db = new DatabaseSync(filename);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function fixture(options: ProviderIndexStoreOptions = {}): Readonly<{
  db: TestDatabase;
  store: ProviderTaskIndexStore;
  key: NativeTaskKey;
  stage: ProviderIndexStage;
  nowCalls: () => number;
}> {
  const db = openDatabase();
  const home = tempDirectory();
  let now = 100;
  let nowCallCount = 0;
  const store = new ProviderTaskIndexStore(db, {
    ...options,
    now: options.now ?? (() => {
      nowCallCount += 1;
      const value = now;
      now += 100;
      return value;
    }),
    tokenFactory: options.tokenFactory ?? (() => "stage-write-owner"),
  });
  const registration = store.registerHome({ provider: "openai", home }, 1);
  const key = Object.freeze({ provider: "openai", home, nativeTaskId: "task-1" } as const);
  const stage = store.beginStage({
    provider: registration.provider,
    homeFingerprint: registration.homeFingerprint,
  });
  return Object.freeze({ db, store, key, stage, nowCalls: () => nowCallCount });
}

function summary(key: NativeTaskKey): NativeTaskSummary {
  return Object.freeze({
    key,
    title: "Staged summary",
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
      lastTurnId: null,
      lastTurnStatus: null,
      lastItemId: null,
      fingerprint: "openai:v1:stage-write",
    }),
  });
}

function snapshot(
  key: NativeTaskKey,
  options: Readonly<{
    title?: string;
    revisionFingerprint?: string;
    eventTexts?: readonly string[];
  }> = {},
): NativeTask {
  const base = summary(key);
  const title = options.title ?? base.title;
  const revision = Object.freeze({
    ...base.revision!,
    fingerprint: options.revisionFingerprint ?? base.revision!.fingerprint,
  });
  const eventTexts = options.eventTexts ?? [];
  const turns = eventTexts.length === 0 ? [] : [
    Object.freeze({
      id: "turn-1",
      status: "complete",
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:01:00.000Z",
      events: Object.freeze(eventTexts.map((text, index) => normalizeProviderEvent({
        type: "message",
        role: "assistant",
        text,
        turnId: "turn-1",
        itemId: `item-${String(index)}`,
      }, {
        provider: key.provider,
        key,
        occurredAt: `2026-07-14T00:00:0${String(index)}.000Z`,
      }))),
    }),
  ];
  return Object.freeze({ ...base, title, revision, turns: Object.freeze(turns) });
}

function summaryFrom(task: NativeTask): NativeTaskSummary {
  const { turns: _turns, ...value } = task;
  return Object.freeze(value);
}

function cacheRows(db: TestDatabase): Readonly<Record<string, readonly Record<string, unknown>[]>> {
  const rows = (table: string, order: string): readonly Record<string, unknown>[] =>
    db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[];
  return Object.freeze({
    tasks: rows("provider_task_cache", "native_task_id, cache_generation"),
    turns: rows("provider_turn_cache", "native_task_id, cache_generation, ordinal"),
    events: rows("provider_event_cache", "native_task_id, cache_generation, ordinal"),
    receipts: rows("provider_replay_receipts", "native_task_id, cache_generation"),
  });
}

function expectStoreError(operation: () => unknown, code: ProviderIndexStoreError["code"]): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ProviderIndexStoreError);
  expect(thrown).toMatchObject({ code });
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // Closed-database cases are added after the API exists.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProviderTaskIndexStore staged cache writes", () => {
  it("stages a summary in the owned generation", () => {
    const { db, store, key, stage } = fixture();

    store.stageSummary(stage, key, summary(key));

    expect(db.prepare(`SELECT native_task_id, cache_generation
      FROM provider_task_cache`).all()).toEqual([{
      native_task_id: key.nativeTaskId,
      cache_generation: stage.generation,
    }]);
  });

  it("stages a complete zero-event snapshot with one receipt", () => {
    const { db, store, key, stage } = fixture();

    store.stageSnapshot(stage, key, snapshot(key));

    expect(db.prepare(`SELECT event_count FROM provider_replay_receipts`).all())
      .toEqual([{ event_count: 0 }]);
  });

  it("persists complete turn/event rows with task-global ordinals", () => {
    const { db, store, key, stage } = fixture();

    store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["one", "two"] }));

    expect(db.prepare(`SELECT ordinal FROM provider_turn_cache ORDER BY ordinal`).all())
      .toEqual([{ ordinal: 0 }]);
    expect(db.prepare(`SELECT ordinal FROM provider_event_cache ORDER BY ordinal`).all())
      .toEqual([{ ordinal: 0 }, { ordinal: 1 }]);
    expect(db.prepare(`SELECT event_count FROM provider_replay_receipts`).get())
      .toEqual({ event_count: 2 });
  });

  it("preserves a snapshot for an unchanged summary and demotes it when hash fields change", () => {
    const { db, store, key, stage } = fixture();
    const task = snapshot(key, { eventTexts: ["preserved"] });
    store.stageSnapshot(stage, key, task);
    const snapshotted = cacheRows(db);

    store.stageSummary(stage, key, summaryFrom(task));
    expect(cacheRows(db)).toMatchObject({
      turns: snapshotted.turns,
      events: snapshotted.events,
      receipts: snapshotted.receipts,
    });

    store.stageSummary(stage, key, { ...summaryFrom(task), title: "changed title" });
    expect(db.prepare(`SELECT title FROM provider_task_cache`).get())
      .toEqual({ title: "changed title" });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_turn_cache`).get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_event_cache`).get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_replay_receipts`).get())
      .toEqual({ count: 0 });
  });

  it("makes exact snapshot replay byte-idempotent and replaces a changed receipt key", () => {
    const { db, store, key, stage } = fixture();
    const original = snapshot(key, { eventTexts: ["old"] });
    store.stageSnapshot(stage, key, original);
    const first = cacheRows(db);

    store.stageSnapshot(stage, key, original);
    expect(cacheRows(db)).toEqual(first);

    const changed = snapshot(key, {
      revisionFingerprint: "openai:v1:stage-write-2",
      eventTexts: ["new-one", "new-two"],
    });
    store.stageSnapshot(stage, key, changed);
    expect(db.prepare(`SELECT event_count FROM provider_replay_receipts`).get())
      .toEqual({ event_count: 2 });
    expect(db.prepare(`SELECT event_json FROM provider_event_cache ORDER BY ordinal`).all())
      .not.toEqual(first.events.map((row) => ({ event_json: row.event_json })));
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_replay_receipts`).get())
      .toEqual({ count: 1 });
  });

  it("commits a whole-stage abort and durable latch before reporting replay conflict", () => {
    const { db, store, key, stage } = fixture();
    const original = snapshot(key, { eventTexts: ["trusted"] });
    store.stageSnapshot(stage, key, original);

    expectStoreError(
      () => store.stageSnapshot(stage, key, snapshot(key, {
        title: "same native revision but changed snapshot",
        eventTexts: ["changed"],
      })),
      "REPLAY_CONFLICT",
    );

    expect(db.prepare(`SELECT active_generation, staging_generation, state, generation_epoch
      FROM provider_sync_state`).get()).toEqual({
      active_generation: 0,
      staging_generation: null,
      state: "idle",
      generation_epoch: stage.generation,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_task_cache`).get())
      .toEqual({ count: 0 });
    const latch = db.prepare(`SELECT required, latch_revision, reviewed_fingerprint,
      native_fingerprint, writer_epoch, reason
      FROM provider_reconciliation_state`).get() as Record<string, unknown>;
    expect(latch).toMatchObject({
      required: 1,
      latch_revision: 1,
      writer_epoch: 0,
      reason: "REPLAY_CONFLICT",
    });
    expect(latch.reviewed_fingerprint).toMatch(/^provider-index-snapshot:v1:[0-9a-f]{64}$/u);
    expect(latch.native_fingerprint).toMatch(/^provider-index-snapshot:v1:[0-9a-f]{64}$/u);
    expect(latch.reviewed_fingerprint).not.toBe(latch.native_fingerprint);
    expectStoreError(() => store.stageSnapshot(stage, key, original), "STAGE_LOST");
  });

  it("enforces post-replacement generation capacity without changing cache or lease", () => {
    const { db, store, key, stage } = fixture({
      maxTasksPerGeneration: 1,
      maxEventsPerTask: 2,
      maxEventsPerGeneration: 2,
    });
    store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["one", "two"] }));
    const beforeRows = cacheRows(db);
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
    const secondKey = Object.freeze({ ...key, nativeTaskId: "task-2" });

    expectStoreError(
      () => store.stageSnapshot(stage, secondKey, snapshot(secondKey, { eventTexts: ["three"] })),
      "CAPACITY",
    );

    expect(cacheRows(db)).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
  });

  it("rejects lost and exactly expired authority while renewing a successful write", () => {
    const lost = fixture();
    const beforeLost = lost.db.prepare(`SELECT * FROM provider_sync_state`).get();
    expectStoreError(() => lost.store.stageSummary(
      Object.freeze({ ...lost.stage, ownerToken: "wrong-owner" }),
      lost.key,
      summary(lost.key),
    ), "STAGE_LOST");
    expect(lost.db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeLost);

    const expired = fixture();
    expired.db.exec(`UPDATE provider_sync_state SET staging_expires_at = 200`);
    expectStoreError(
      () => expired.store.stageSummary(expired.stage, expired.key, summary(expired.key)),
      "STAGE_EXPIRED",
    );
    expect(expired.db.prepare(`SELECT staging_heartbeat_at, staging_expires_at
      FROM provider_sync_state`).get()).toEqual({
      staging_heartbeat_at: 100,
      staging_expires_at: 200,
    });

    const valid = fixture();
    valid.store.stageSummary(valid.stage, valid.key, summary(valid.key));
    expect(valid.db.prepare(`SELECT staging_heartbeat_at, staging_expires_at
      FROM provider_sync_state`).get()).toEqual({
      staging_heartbeat_at: 200,
      staging_expires_at: 30_200,
    });
  });

  it("rejects hostile summary input before sampling the clock", () => {
    const { store, key, stage, nowCalls } = fixture();
    const hostile = Object.defineProperty({}, "key", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    }) as NativeTaskSummary;

    expectStoreError(() => store.stageSummary(stage, key, hostile), "INVALID_INPUT");
    expect(nowCalls()).toBe(1);
  });

  it("does not trust a caller-forged public store error", () => {
    const { store, key, stage, nowCalls } = fixture();
    const forged = new Proxy(summary(key), {
      ownKeys: () => {
        throw new ProviderIndexStoreError("CAPACITY");
      },
    });

    expectStoreError(() => store.stageSummary(stage, key, forged), "INVALID_INPUT");
    expect(nowCalls()).toBe(1);
  });

  it("rejects a task from another registered home without touching either scope", () => {
    const { db, store, stage, nowCalls } = fixture();
    const otherHome = tempDirectory();
    store.registerHome({ provider: "openai", home: otherHome }, 2);
    const otherKey = Object.freeze({
      provider: "openai",
      home: otherHome,
      nativeTaskId: "other-task",
    } as const);
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).all();

    expectStoreError(
      () => store.stageSummary(stage, otherKey, summary(otherKey)),
      "INVALID_INPUT",
    );

    expect(nowCalls()).toBe(1);
    expect(cacheRows(db)).toEqual({ tasks: [], turns: [], events: [], receipts: [] });
    expect(db.prepare(`SELECT * FROM provider_sync_state`).all()).toEqual(beforeSync);
  });

  it("rolls back a trigger-injected sibling task and the lease renewal", () => {
    const { db, store, key, stage } = fixture();
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
    db.exec(`CREATE TRIGGER inject_sibling_task AFTER INSERT ON provider_task_cache
      WHEN NEW.native_task_id = 'task-1'
      BEGIN
        INSERT INTO provider_task_cache (
          provider, home_fingerprint, native_task_id, title, status, source,
          cache_generation, observed_at
        ) VALUES (
          NEW.provider, NEW.home_fingerprint, 'trigger-task', 'injected',
          'idle', 'degraded-fallback', NEW.cache_generation, NEW.observed_at
        );
      END`);

    expectStoreError(() => store.stageSummary(stage, key, summary(key)), "CORRUPT_ROW");

    expect(cacheRows(db)).toEqual({ tasks: [], turns: [], events: [], receipts: [] });
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
  });

  it.each([
    "provider_turn_cache",
    "provider_event_cache",
    "provider_replay_receipts",
  ] as const)("rolls back a suppressed %s insert", (table) => {
    const { db, store, key, stage } = fixture();
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
    db.exec(`CREATE TRIGGER suppress_stage_child BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(IGNORE); END`);

    expectStoreError(
      () => store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["event"] })),
      "CORRUPT_ROW",
    );

    expect(cacheRows(db)).toEqual({ tasks: [], turns: [], events: [], receipts: [] });
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
  });

  it("rolls back the whole replay conflict when the latch revision is exhausted", () => {
    const { db, store, key, stage } = fixture();
    const original = snapshot(key, { eventTexts: ["trusted"] });
    store.stageSnapshot(stage, key, original);
    db.prepare(`INSERT INTO provider_reconciliation_state (
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 0,
      'REPLAY_CONFLICT', 1)`)
      .run(
        stage.provider,
        stage.homeFingerprint,
        key.nativeTaskId,
        Number.MAX_SAFE_INTEGER,
        `openai:v1:${"a".repeat(64)}`,
        `openai:v1:${"b".repeat(64)}`,
      );
    const beforeRows = cacheRows(db);
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
    const beforeLatch = db.prepare(`SELECT * FROM provider_reconciliation_state`).get();

    expectStoreError(() => store.stageSnapshot(stage, key, snapshot(key, {
      title: "conflicting title",
      eventTexts: ["changed"],
    })), "CAPACITY");

    expect(cacheRows(db)).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
    expect(db.prepare(`SELECT * FROM provider_reconciliation_state`).get()).toEqual(beforeLatch);
  });

  it("reports abort trigger corruption instead of a replay conflict and rolls back", () => {
    const { db, store, key, stage } = fixture();
    const original = snapshot(key, { eventTexts: ["trusted"] });
    store.stageSnapshot(stage, key, original);
    const beforeRows = cacheRows(db);
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
    db.exec(`CREATE TRIGGER corrupt_conflict_abort AFTER UPDATE ON provider_sync_state
      WHEN OLD.state = 'staging' AND NEW.state = 'idle'
      BEGIN
        UPDATE provider_sync_state SET generation_epoch = generation_epoch + 1
        WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint;
      END`);

    expectStoreError(() => store.stageSnapshot(stage, key, snapshot(key, {
      title: "conflicting title",
      eventTexts: ["changed"],
    })), "CORRUPT_ROW");

    expect(cacheRows(db)).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_reconciliation_state`).get())
      .toEqual({ count: 0 });
  });

  it("rolls back a staged write when COMMIT is denied", () => {
    const { db, store, key, stage } = fixture();
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
    const authorizable = db as TestDatabase & {
      setAuthorizer(callback: ((actionCode: number, arg1: string | null) => number) | null): void;
    };
    authorizable.setAuthorizer((actionCode, arg1) => (
      actionCode === constants.SQLITE_TRANSACTION && arg1 === "COMMIT"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK
    ));
    try {
      expectStoreError(() => store.stageSummary(stage, key, summary(key)), "DATABASE_UNAVAILABLE");
    } finally {
      authorizable.setAuthorizer(null);
    }

    expect(cacheRows(db)).toEqual({ tasks: [], turns: [], events: [], receipts: [] });
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
  });

  it("persists the committed replay abort and latch across restart", () => {
    const root = tempDirectory();
    const filename = path.join(root, "restart.db");
    const home = tempDirectory();
    const db = openDatabase(filename);
    let now = 100;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        const value = now;
        now += 100;
        return value;
      },
      tokenFactory: () => "restart-owner",
    });
    const registration = store.registerHome({ provider: "openai", home }, 1);
    const key = Object.freeze({ provider: "openai", home, nativeTaskId: "task-restart" } as const);
    const stage = store.beginStage({
      provider: registration.provider,
      homeFingerprint: registration.homeFingerprint,
    });
    store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["trusted"] }));
    expectStoreError(() => store.stageSnapshot(stage, key, snapshot(key, {
      title: "conflicting title",
      eventTexts: ["changed"],
    })), "REPLAY_CONFLICT");
    db.close();

    const restarted = reopenDatabase(filename);
    expect(restarted.prepare(`SELECT state, staging_generation, generation_epoch
      FROM provider_sync_state`).get()).toEqual({
      state: "idle",
      staging_generation: null,
      generation_epoch: stage.generation,
    });
    expect(restarted.prepare(`SELECT required, latch_revision, reason
      FROM provider_reconciliation_state`).get()).toEqual({
      required: 1,
      latch_revision: 1,
      reason: "REPLAY_CONFLICT",
    });
    expect(restarted.prepare(`SELECT COUNT(*) AS count FROM provider_task_cache`).get())
      .toEqual({ count: 0 });
  });
});

describe("ProviderTaskIndexStore atomic promotion", () => {
  it("promotes an exact empty census", () => {
    const { db, store, stage } = fixture();
    const completion: ProviderIndexCompletion = Object.freeze({
      completedAt: 300,
      providerVersion: null,
      taskCount: 0,
      turnCount: 0,
      eventCount: 0,
      snapshotCount: 0,
      receiptCount: 0,
    });

    const promoted = store.promoteStage(stage, completion);

    expect(promoted).toMatchObject({
      previousGeneration: 0,
      activeGeneration: stage.generation,
      taskCount: 0,
      turnCount: 0,
      eventCount: 0,
      snapshotCount: 0,
    });
    expect(db.prepare(`SELECT active_generation, state FROM provider_sync_state`).get())
      .toEqual({ active_generation: stage.generation, state: "idle" });
  });

  it("promotes a populated mixed census and retires only the prior scoped generation", () => {
    const { db, store, key, stage } = fixture();
    db.prepare(`INSERT INTO provider_task_cache (
      provider, home_fingerprint, native_task_id, title, status, source,
      cache_generation, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 1)`)
      .run(stage.provider, stage.homeFingerprint, "old-task", "old", "idle", "degraded-fallback");
    store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["one", "two"] }));
    const summaryKey = Object.freeze({ ...key, nativeTaskId: "task-2" });
    store.stageSummary(stage, summaryKey, summary(summaryKey));

    const promoted = store.promoteStage(stage, {
      completedAt: 500,
      providerVersion: "provider-v1",
      taskCount: 2,
      turnCount: 1,
      eventCount: 2,
      snapshotCount: 1,
      receiptCount: 1,
    });

    expect(promoted).toMatchObject({
      previousGeneration: 0,
      activeGeneration: stage.generation,
      taskCount: 2,
      turnCount: 1,
      eventCount: 2,
      snapshotCount: 1,
    });
    expect(db.prepare(`SELECT active_generation, state, provider_version,
      last_completed_at, generation_epoch FROM provider_sync_state`).get()).toEqual({
      active_generation: stage.generation,
      state: "idle",
      provider_version: "provider-v1",
      last_completed_at: 500,
      generation_epoch: stage.generation,
    });
    expect(db.prepare(`SELECT native_task_id FROM provider_task_cache
      ORDER BY native_task_id`).all()).toEqual([
      { native_task_id: "task-1" },
      { native_task_id: "task-2" },
    ]);
  });

  it("rejects claim mismatches without changing the live stage", () => {
    const { db, store, key, stage } = fixture();
    store.stageSummary(stage, key, summary(key));
    const before = db.prepare(`SELECT * FROM provider_sync_state`).get();

    expectStoreError(() => store.promoteStage(stage, {
      completedAt: 500,
      providerVersion: null,
      taskCount: 0,
      turnCount: 0,
      eventCount: 0,
      snapshotCount: 0,
      receiptCount: 0,
    }), "STAGE_INCOMPLETE");

    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_task_cache`).get())
      .toEqual({ count: 1 });
  });

  it.each([
    "taskCount",
    "turnCount",
    "eventCount",
    "snapshotCount",
    "receiptCount",
  ] as const)("rejects an exact %s mismatch", (field) => {
    const { db, store, key, stage } = fixture();
    store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["one"] }));
    const beforeRows = cacheRows(db);
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
    const completion: ProviderIndexCompletion = {
      completedAt: 500,
      providerVersion: null,
      taskCount: 1,
      turnCount: 1,
      eventCount: 1,
      snapshotCount: 1,
      receiptCount: 1,
      [field]: 0,
    };

    expectStoreError(() => store.promoteStage(stage, completion), "STAGE_INCOMPLETE");
    expect(cacheRows(db)).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
  });

  it("rejects receipt event-count and task-global ordinal corruption", () => {
    for (const corruption of ["receipt-count", "event-gap", "event-duplicate"] as const) {
      const { db, store, key, stage } = fixture();
      store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["one", "two"] }));
      if (corruption === "receipt-count") {
        db.exec(`UPDATE provider_replay_receipts SET event_count = 1`);
      } else if (corruption === "event-duplicate") {
        db.exec(`DROP INDEX idx_provider_event_cache_task_ordinal;
          UPDATE provider_event_cache SET ordinal = 0`);
      } else {
        db.exec(`UPDATE provider_event_cache SET ordinal = ordinal + 5`);
      }

      expectStoreError(() => store.promoteStage(stage, {
        completedAt: 500,
        providerVersion: null,
        taskCount: 1,
        turnCount: 1,
        eventCount: 2,
        snapshotCount: 1,
        receiptCount: 1,
      }), "STAGE_INCOMPLETE");
      expect(db.prepare(`SELECT state FROM provider_sync_state`).get())
        .toEqual({ state: "staging" });
    }
  });

  it("rejects children attached to a summary-only task even when totals match", () => {
    const { db, store, key, stage } = fixture();
    store.stageSummary(stage, key, summary(key));
    db.prepare(`INSERT INTO provider_turn_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, status, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        stage.provider,
        stage.homeFingerprint,
        key.nativeTaskId,
        stage.generation,
        "native:v1:dHVybi1jb3JydXB0",
        "complete",
        0,
      );

    expectStoreError(() => store.promoteStage(stage, {
      completedAt: 500,
      providerVersion: null,
      taskCount: 1,
      turnCount: 1,
      eventCount: 0,
      snapshotCount: 0,
      receiptCount: 0,
    }), "STAGE_INCOMPLETE");
  });

  it("rejects compensated per-task receipt corruption when global counts still match", () => {
    const { db, store, key, stage } = fixture();
    const secondKey = Object.freeze({ ...key, nativeTaskId: "task-2" });
    store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["one"] }));
    store.stageSnapshot(stage, secondKey, snapshot(secondKey, { eventTexts: ["two"] }));
    db.prepare(`DELETE FROM provider_event_cache
      WHERE native_task_id = ?`).run(key.nativeTaskId);
    db.prepare(`INSERT INTO provider_event_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, native_item_key, replay_key, ordinal,
      event_fingerprint, event_json
    ) SELECT
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, native_item_key || '-extra', replay_key || '-extra', 1,
      event_fingerprint, event_json
    FROM provider_event_cache WHERE native_task_id = ?`).run(secondKey.nativeTaskId);

    expectStoreError(() => store.promoteStage(stage, {
      completedAt: 500,
      providerVersion: null,
      taskCount: 2,
      turnCount: 2,
      eventCount: 2,
      snapshotCount: 2,
      receiptCount: 2,
    }), "STAGE_INCOMPLETE");
    expect(db.prepare(`SELECT state FROM provider_sync_state`).get())
      .toEqual({ state: "staging" });
  });

  it.each(["sync-rewrite", "retirement-ignore"] as const)(
    "rolls back promotion on %s trigger corruption",
    (failure) => {
      const { db, store, key, stage } = fixture();
      db.prepare(`INSERT INTO provider_task_cache (
        provider, home_fingerprint, native_task_id, title, status, source,
        cache_generation, observed_at
      ) VALUES (?, ?, 'old-task', 'old', 'idle', 'degraded-fallback', 0, 1)`)
        .run(stage.provider, stage.homeFingerprint);
      store.stageSummary(stage, key, summary(key));
      const beforeRows = cacheRows(db);
      const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
      db.exec(failure === "sync-rewrite"
        ? `CREATE TRIGGER corrupt_promotion_sync AFTER UPDATE ON provider_sync_state
            WHEN OLD.state = 'staging' AND NEW.state = 'idle'
            BEGIN
              UPDATE provider_sync_state SET generation_epoch = generation_epoch + 1
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint;
            END`
        : `CREATE TRIGGER ignore_generation_retirement BEFORE DELETE ON provider_task_cache
            WHEN OLD.cache_generation = 0
            BEGIN SELECT RAISE(IGNORE); END`);

      expectStoreError(() => store.promoteStage(stage, {
        completedAt: 500,
        providerVersion: null,
        taskCount: 1,
        turnCount: 0,
        eventCount: 0,
        snapshotCount: 0,
        receiptCount: 0,
      }), "CORRUPT_ROW");

      expect(cacheRows(db)).toEqual(beforeRows);
      expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
    },
  );

  it("retires only the promoted home scope", () => {
    const { db, store, key, stage } = fixture();
    const otherHome = tempDirectory();
    const other = store.registerHome({ provider: "openai", home: otherHome }, 2);
    db.prepare(`INSERT INTO provider_task_cache (
      provider, home_fingerprint, native_task_id, title, status, source,
      cache_generation, observed_at
    ) VALUES ('openai', ?, 'other-old', 'other', 'idle', 'degraded-fallback', 0, 1)`)
      .run(other.homeFingerprint);
    store.stageSummary(stage, key, summary(key));

    store.promoteStage(stage, {
      completedAt: 500,
      providerVersion: null,
      taskCount: 1,
      turnCount: 0,
      eventCount: 0,
      snapshotCount: 0,
      receiptCount: 0,
    });

    expect(db.prepare(`SELECT native_task_id, home_fingerprint FROM provider_task_cache
      ORDER BY native_task_id`).all()).toEqual([
      { native_task_id: "other-old", home_fingerprint: other.homeFingerprint },
      { native_task_id: key.nativeTaskId, home_fingerprint: stage.homeFingerprint },
    ]);
  });

  it("validates completion shape and configured bounds before sampling the clock", () => {
    const bounded = fixture({ maxTasksPerGeneration: 1 });
    expectStoreError(() => bounded.store.promoteStage(bounded.stage, {
      completedAt: 500,
      providerVersion: null,
      taskCount: 2,
      turnCount: 0,
      eventCount: 0,
      snapshotCount: 0,
      receiptCount: 0,
    }), "CAPACITY");
    expect(bounded.nowCalls()).toBe(1);

    const malformed = fixture();
    expectStoreError(() => malformed.store.promoteStage(malformed.stage, {
      completedAt: 500,
      providerVersion: null,
      taskCount: 1,
      turnCount: 0,
      eventCount: 0,
      snapshotCount: 1,
      receiptCount: 0,
    }), "STAGE_INCOMPLETE");
    expect(malformed.nowCalls()).toBe(1);
  });

  it("rejects a persisted task above the configured per-task event bound", () => {
    const { db, store, key, stage } = fixture({
      maxEventsPerTask: 1,
      maxEventsPerGeneration: 2,
    });
    store.stageSnapshot(stage, key, snapshot(key, { eventTexts: ["one"] }));
    db.prepare(`INSERT INTO provider_event_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, native_item_key, replay_key, ordinal,
      event_fingerprint, event_json
    ) SELECT
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, native_item_key || '-extra', replay_key || '-extra', 1,
      event_fingerprint, event_json
    FROM provider_event_cache`).run();
    db.exec(`UPDATE provider_replay_receipts SET event_count = 2`);
    const beforeRows = cacheRows(db);
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();

    expectStoreError(() => store.promoteStage(stage, {
      completedAt: 500,
      providerVersion: null,
      taskCount: 1,
      turnCount: 1,
      eventCount: 2,
      snapshotCount: 1,
      receiptCount: 1,
    }), "CAPACITY");

    expect(cacheRows(db)).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
  });

  it("rejects caller-owned transactions and closed databases", () => {
    const active = fixture();
    const before = active.db.prepare(`SELECT * FROM provider_sync_state`).get();
    active.db.exec("BEGIN");
    try {
      expectStoreError(() => active.store.promoteStage(active.stage, {
        completedAt: 500,
        providerVersion: null,
        taskCount: 0,
        turnCount: 0,
        eventCount: 0,
        snapshotCount: 0,
        receiptCount: 0,
      }), "DATABASE_UNAVAILABLE");
    } finally {
      active.db.exec("ROLLBACK");
    }
    expect(active.db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(before);

    const closed = fixture();
    closed.db.close();
    expectStoreError(() => closed.store.promoteStage(closed.stage, {
      completedAt: 500,
      providerVersion: null,
      taskCount: 0,
      turnCount: 0,
      eventCount: 0,
      snapshotCount: 0,
      receiptCount: 0,
    }), "DATABASE_UNAVAILABLE");
  });

  it("leaves the stage unchanged when another connection owns the write lock", () => {
    const root = tempDirectory();
    const filename = path.join(root, "busy.db");
    const home = tempDirectory();
    const ownerDb = openDatabase(filename);
    const ownerStore = new ProviderTaskIndexStore(ownerDb, {
      now: () => 100,
      tokenFactory: () => "busy-owner",
    });
    const registration = ownerStore.registerHome({ provider: "openai", home }, 1);
    const stage = ownerStore.beginStage({
      provider: registration.provider,
      homeFingerprint: registration.homeFingerprint,
    });
    const before = ownerDb.prepare(`SELECT * FROM provider_sync_state`).get();
    const contenderDb = reopenDatabase(filename);
    contenderDb.exec("PRAGMA busy_timeout = 1");
    const contender = new ProviderTaskIndexStore(contenderDb, { now: () => 200 });

    ownerDb.exec("BEGIN IMMEDIATE");
    try {
      expectStoreError(() => contender.promoteStage(stage, {
        completedAt: 500,
        providerVersion: null,
        taskCount: 0,
        turnCount: 0,
        eventCount: 0,
        snapshotCount: 0,
        receiptCount: 0,
      }), "DATABASE_UNAVAILABLE");
    } finally {
      ownerDb.exec("ROLLBACK");
    }
    expect(ownerDb.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(before);
  });

  it("rolls back promotion when COMMIT is denied", () => {
    const { db, store, key, stage } = fixture();
    store.stageSummary(stage, key, summary(key));
    const beforeRows = cacheRows(db);
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
    const authorizable = db as TestDatabase & {
      setAuthorizer(callback: ((actionCode: number, arg1: string | null) => number) | null): void;
    };
    authorizable.setAuthorizer((actionCode, arg1) => (
      actionCode === constants.SQLITE_TRANSACTION && arg1 === "COMMIT"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK
    ));
    try {
      expectStoreError(() => store.promoteStage(stage, {
        completedAt: 500,
        providerVersion: null,
        taskCount: 1,
        turnCount: 0,
        eventCount: 0,
        snapshotCount: 0,
        receiptCount: 0,
      }), "DATABASE_UNAVAILABLE");
    } finally {
      authorizable.setAuthorizer(null);
    }

    expect(cacheRows(db)).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
  });
});
