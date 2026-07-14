import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrations.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";
import type { ProviderIndexStoreOptions } from "../../src/provider-index/store-types.js";
import { normalizeProviderEvent } from "../../src/providers/events.js";
import type {
  ProviderIndexStage,
  ProviderTaskLocator,
} from "../../src/index.js";
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
  const directory = mkdtempSync(path.join(os.tmpdir(), "devhub-provider-active-cache-"));
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

function summary(key: NativeTaskKey, title = "Active summary"): NativeTaskSummary {
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
      lastTurnId: null,
      lastTurnStatus: null,
      lastItemId: null,
      fingerprint: "openai:v1:active-cache",
    }),
  });
}

function snapshot(key: NativeTaskKey, title = "Active summary"): NativeTask {
  return Object.freeze({ ...summary(key, title), turns: Object.freeze([]) });
}

function snapshotWithTurns(
  key: NativeTaskKey,
  turnEventTexts: readonly (readonly string[])[],
): NativeTask {
  let itemIndex = 0;
  return Object.freeze({
    ...summary(key),
    turns: Object.freeze(turnEventTexts.map((eventTexts, turnIndex) => {
      const turnId = `turn-${String(turnIndex + 1)}`;
      return Object.freeze({
        id: turnId,
        status: "complete",
        startedAt: "2026-07-14T00:00:00.000Z",
        completedAt: "2026-07-14T00:01:00.000Z",
        events: Object.freeze(eventTexts.map((text) => {
          const currentItem = itemIndex;
          itemIndex += 1;
          return normalizeProviderEvent({
            type: "message",
            role: "assistant",
            text,
            turnId,
            itemId: `item-${String(currentItem)}`,
          }, {
            provider: key.provider,
            key,
            occurredAt: "2026-07-14T00:00:00.000Z",
          });
        })),
      });
    })),
  });
}

function fixture(options: ProviderIndexStoreOptions = {}): Readonly<{
  db: TestDatabase;
  store: ProviderTaskIndexStore;
  key: NativeTaskKey;
  locator: ProviderTaskLocator;
  stage: ProviderIndexStage;
}> {
  const db = openDatabase();
  const home = tempDirectory();
  let now = 100;
  const store = new ProviderTaskIndexStore(db, {
    ...options,
    now: options.now ?? (() => {
      const value = now;
      now += 100;
      return value;
    }),
    tokenFactory: options.tokenFactory ?? (() => "active-cache-owner"),
  });
  const registration = store.registerHome({ provider: "openai", home }, 1);
  const key = Object.freeze({ provider: "openai", home, nativeTaskId: "task-1" } as const);
  const locator = Object.freeze({
    version: 1,
    provider: "openai",
    homeFingerprint: registration.homeFingerprint,
    nativeTaskId: key.nativeTaskId,
  } as const);
  const stage = store.beginStage({
    provider: registration.provider,
    homeFingerprint: registration.homeFingerprint,
  });
  return Object.freeze({ db, store, key, locator, stage });
}

function promoteSummary(
  store: ProviderTaskIndexStore,
  stage: ProviderIndexStage,
  key: NativeTaskKey,
): void {
  store.stageSummary(stage, key, summary(key));
  store.promoteStage(stage, {
    completedAt: 300,
    providerVersion: null,
    taskCount: 1,
    turnCount: 0,
    eventCount: 0,
    snapshotCount: 0,
    receiptCount: 0,
  });
}

function promoteSnapshot(
  store: ProviderTaskIndexStore,
  stage: ProviderIndexStage,
  key: NativeTaskKey,
): NativeTask {
  const task = snapshot(key);
  store.stageSnapshot(stage, key, task);
  store.promoteStage(stage, {
    completedAt: 300,
    providerVersion: null,
    taskCount: 1,
    turnCount: 0,
    eventCount: 0,
    snapshotCount: 1,
    receiptCount: 1,
  });
  return task;
}

function promoteTask(
  store: ProviderTaskIndexStore,
  stage: ProviderIndexStage,
  key: NativeTaskKey,
  task: NativeTask,
  turnCount: number,
  eventCount: number,
): void {
  store.stageSnapshot(stage, key, task);
  store.promoteStage(stage, {
    completedAt: 300,
    providerVersion: null,
    taskCount: 1,
    turnCount,
    eventCount,
    snapshotCount: 1,
    receiptCount: 1,
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
      // Closed-database cases are intentional.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProviderTaskIndexStore active cache surface", () => {
  it("returns null when replacing before the first complete promotion", () => {
    const { store, key } = fixture();

    expect(store.replaceActiveSummary(key, summary(key), 200)).toBeNull();
    expect(store.replaceActiveSnapshot(key, snapshot(key), 200)).toBeNull();
  });

  it("replaces an active summary with an authoritative snapshot", () => {
    const { store, key, stage } = fixture();
    promoteSummary(store, stage, key);

    expect(store.replaceActiveSnapshot(key, snapshot(key), 400)).toMatchObject({
      cacheDetail: "snapshot",
      observedAt: 400,
      turns: [],
    });
  });

  it("preserves an unchanged active snapshot subtree and demotes changed summary fields", () => {
    const { db, store, key, stage } = fixture();
    const task = promoteSnapshot(store, stage, key);

    expect(store.replaceActiveSummary(key, summary(key), 400)).toMatchObject({
      cacheDetail: "snapshot",
      observedAt: 400,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_replay_receipts`).get())
      .toEqual({ count: 1 });
    expect(store.replaceActiveSnapshot(key, task, 500)).toMatchObject({
      cacheDetail: "snapshot",
      observedAt: 500,
    });

    expect(store.replaceActiveSummary(key, summary(key, "Changed"), 600)).toMatchObject({
      title: "Changed",
      cacheDetail: "summary",
      observedAt: 600,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_replay_receipts`).get())
      .toEqual({ count: 0 });
  });

  it("commits active invalidation and reconciliation on replay conflict without touching staging", () => {
    const { db, store, key, locator, stage } = fixture();
    promoteSnapshot(store, stage, key);
    const liveStage = store.beginStage({
      provider: locator.provider,
      homeFingerprint: locator.homeFingerprint,
    });
    store.stageSummary(liveStage, key, summary(key, "Staging survives"));
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();

    expectStoreError(
      () => store.replaceActiveSnapshot(key, snapshot(key, "Conflicting active"), 500),
      "REPLAY_CONFLICT",
    );

    expect(db.prepare(`SELECT cache_generation, title FROM provider_task_cache`).all())
      .toEqual([{ cache_generation: liveStage.generation, title: "Staging survives" }]);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
    expect(db.prepare(`SELECT required, latch_revision, reason
      FROM provider_reconciliation_state`).get()).toEqual({
      required: 1,
      latch_revision: 1,
      reason: "REPLAY_CONFLICT",
    });
  });

  it("rejects exact active replay after stored row tampering", () => {
    const { db, store, key, stage } = fixture();
    const task = snapshotWithTurns(key, [["trusted"]]);
    promoteTask(store, stage, key, task, 1, 1);
    db.exec(`UPDATE provider_event_cache SET event_json = '{}'`);
    const beforeRows = db.prepare(`SELECT * FROM provider_event_cache`).all();
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();

    expectStoreError(
      () => store.replaceActiveSnapshot(key, task, 500),
      "CORRUPT_ROW",
    );

    expect(db.prepare(`SELECT * FROM provider_event_cache`).all()).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
  });

  it("rejects unchanged active summary replacement when its preserved snapshot is corrupt", () => {
    const { db, store, key, stage } = fixture();
    const task = snapshotWithTurns(key, [["trusted"]]);
    promoteTask(store, stage, key, task, 1, 1);
    db.exec(`UPDATE provider_event_cache SET event_json = '{}'`);
    const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();

    expectStoreError(
      () => store.replaceActiveSummary(key, summary(key), 500),
      "CORRUPT_ROW",
    );

    expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
    expect(db.prepare(`SELECT event_json FROM provider_event_cache`).get())
      .toEqual({ event_json: "{}" });
  });

  it("enforces final active-generation capacity on replacement", () => {
    const { db, store, key, stage } = fixture({ maxTasksPerGeneration: 1 });
    promoteSummary(store, stage, key);
    const secondKey = Object.freeze({ ...key, nativeTaskId: "task-2" });
    const before = db.prepare(`SELECT * FROM provider_task_cache`).all();

    expectStoreError(
      () => store.replaceActiveSummary(secondKey, summary(secondKey), 400),
      "CAPACITY",
    );

    expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(before);
  });

  it("rolls back active replay conflict when COMMIT is denied", () => {
    const { db, store, key, stage } = fixture();
    promoteSnapshot(store, stage, key);
    const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();
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
      expectStoreError(
        () => store.replaceActiveSnapshot(key, snapshot(key, "Conflict"), 500),
        "DATABASE_UNAVAILABLE",
      );
    } finally {
      authorizable.setAuthorizer(null);
    }

    expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_reconciliation_state`).get())
      .toEqual({ count: 0 });
  });

  it.each(["ignored", "deleted", "rewritten"] as const)(
    "rolls back an active summary row that is $failure by a trigger",
    (failure) => {
      const { db, store, key, stage } = fixture();
      promoteSummary(store, stage, key);
      const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();
      const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
      const timing = failure === "ignored" ? "BEFORE" : "AFTER";
      const body = failure === "ignored"
        ? "SELECT RAISE(IGNORE);"
        : failure === "deleted"
          ? `DELETE FROM provider_task_cache
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint
                AND native_task_id = NEW.native_task_id
                AND cache_generation = NEW.cache_generation;`
          : `UPDATE provider_task_cache SET observed_at = NEW.observed_at + 1
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint
                AND native_task_id = NEW.native_task_id
                AND cache_generation = NEW.cache_generation;`;
      db.exec(`CREATE TRIGGER fail_active_summary ${timing} UPDATE ON provider_task_cache
        BEGIN ${body} END`);

      expectStoreError(
        () => store.replaceActiveSummary(key, summary(key), 400),
        "CORRUPT_ROW",
      );

      expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
      expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
    },
  );

  it.each(["ignored", "deleted", "rewritten"] as const)(
    "rolls back an active snapshot receipt that is $failure by a trigger",
    (failure) => {
      const { db, store, key, stage } = fixture();
      promoteSummary(store, stage, key);
      const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();
      const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();
      const timing = failure === "ignored" ? "BEFORE" : "AFTER";
      const body = failure === "ignored"
        ? "SELECT RAISE(IGNORE);"
        : failure === "deleted"
          ? `DELETE FROM provider_replay_receipts
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint
                AND native_task_id = NEW.native_task_id
                AND cache_generation = NEW.cache_generation;`
          : `UPDATE provider_replay_receipts SET observed_at = NEW.observed_at + 1
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint
                AND native_task_id = NEW.native_task_id
                AND cache_generation = NEW.cache_generation;`;
      db.exec(`CREATE TRIGGER fail_active_snapshot ${timing} INSERT
        ON provider_replay_receipts BEGIN ${body} END`);

      expectStoreError(
        () => store.replaceActiveSnapshot(key, snapshot(key), 400),
        "CORRUPT_ROW",
      );

      expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_replay_receipts`).get())
        .toEqual({ count: 0 });
      expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
    },
  );

  it("lists active cache summaries", () => {
    const { store, key, stage } = fixture();
    promoteSummary(store, stage, key);

    expect(store.list({})).toMatchObject({
      items: [{ title: "Active summary", cacheDetail: "summary" }],
      nextCursor: null,
    });
  });

  it("paginates stable NULL-last order without duplicates and binds cursor scope", () => {
    const { store, key, stage } = fixture();
    promoteSummary(store, stage, key);
    const replace = (
      nativeTaskId: string,
      updatedAt: string | null,
      archived = false,
    ): void => {
      const taskKey = Object.freeze({ ...key, nativeTaskId });
      store.replaceActiveSummary(taskKey, {
        ...summary(taskKey, nativeTaskId),
        updatedAt,
        archived,
      }, 400);
    };
    replace("task-2", "2026-07-14T00:03:00.000Z");
    replace("task-3", "2026-07-14T00:03:00.000Z");
    replace("task-4", null);
    replace("task-5", "2026-07-14T00:04:00.000Z", true);
    replace("task-6", null);

    const observed: string[] = [];
    let cursor: string | null = null;
    do {
      const page = store.list({ limit: 1, cursor });
      observed.push(...page.items.map((item) => item.locator.nativeTaskId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(observed).toEqual(["task-2", "task-3", "task-1", "task-4", "task-6"]);

    const nullBoundary = store.list({ limit: 4 });
    expect(nullBoundary.items.map((item) => item.locator.nativeTaskId))
      .toEqual(["task-2", "task-3", "task-1", "task-4"]);
    expect(store.list({ limit: 4, cursor: nullBoundary.nextCursor }).items
      .map((item) => item.locator.nativeTaskId)).toEqual(["task-6"]);
    expect(store.list({ includeArchived: true }).items[0]!.locator.nativeTaskId).toBe("task-5");
    expect(Object.isFrozen(nullBoundary)).toBe(true);
    expect(Object.isFrozen(nullBoundary.items)).toBe(true);

    expectStoreError(
      () => store.list({ includeArchived: true, cursor: nullBoundary.nextCursor }),
      "INVALID_INPUT",
    );
    for (const limit of [0, 201]) {
      expectStoreError(() => store.list({ limit }), "INVALID_INPUT");
    }
  });

  it("scopes list in SQL, derives cache detail from receipts, and binds limit plus one", () => {
    const { db, store, key, locator, stage } = fixture();
    promoteSummary(store, stage, key);
    const snapshotKey = Object.freeze({ ...key, nativeTaskId: "snapshot-task" });
    store.replaceActiveSnapshot(snapshotKey, snapshot(snapshotKey), 400);
    const liveStage = store.beginStage({
      provider: locator.provider,
      homeFingerprint: locator.homeFingerprint,
    });
    const stagingKey = Object.freeze({ ...key, nativeTaskId: "staging-only" });
    store.stageSummary(liveStage, stagingKey, summary(stagingKey));

    const otherHome = tempDirectory();
    const other = store.registerHome({ provider: "openai", home: otherHome }, 2);
    const otherKey = Object.freeze({
      provider: "openai",
      home: otherHome,
      nativeTaskId: "other-home",
    } as const);
    const otherStage = store.beginStage({
      provider: "openai",
      homeFingerprint: other.homeFingerprint,
    });
    promoteSummary(store, otherStage, otherKey);

    const originalPrepare = db.prepare.bind(db);
    let listParameters: readonly unknown[] = [];
    Object.defineProperty(db, "prepare", {
      configurable: true,
      value: (sql: string) => {
        const statement = originalPrepare(sql);
        if (!sql.includes("FROM provider_task_cache AS task")) return statement;
        return {
          all: (...parameters: Array<string | number | null>) => {
            listParameters = parameters;
            return statement.all(...parameters);
          },
        };
      },
    });

    const page = store.list({
      provider: "openai",
      homeFingerprint: locator.homeFingerprint,
      limit: 1,
    });
    expect(listParameters.at(-1)).toBe(2);
    const allInHome = store.list({
      provider: "openai",
      homeFingerprint: locator.homeFingerprint,
      limit: 10,
    });
    expect(allInHome.items.map((item) => [item.locator.nativeTaskId, item.cacheDetail]))
      .toEqual([
        ["snapshot-task", "snapshot"],
        ["task-1", "summary"],
      ]);
    expect(store.list({ provider: "openai", limit: 10 }).items).toHaveLength(3);
    expectStoreError(
      () => store.list({ homeFingerprint: locator.homeFingerprint }),
      "INVALID_INPUT",
    );
    expect(page.items).toHaveLength(1);
  });

  it("reads an active summary-only task", () => {
    const { store, key, locator, stage } = fixture();
    expect(store.read(locator)).toBeNull();
    promoteSummary(store, stage, key);

    expect(store.read(locator)).toMatchObject({
      title: "Active summary",
      cacheDetail: "summary",
      turns: [],
    });
  });

  it("strictly reads a multi-turn active snapshot while staging remains invisible", () => {
    const { store, key, locator, stage } = fixture();
    const task = snapshotWithTurns(key, [["one", "two"], ["three"]]);
    promoteTask(store, stage, key, task, 2, 3);
    const liveStage = store.beginStage({
      provider: locator.provider,
      homeFingerprint: locator.homeFingerprint,
    });
    store.stageSummary(liveStage, key, summary(key, "Staging title"));

    const read = store.read(locator);

    expect(read).toMatchObject({
      title: "Active summary",
      cacheDetail: "snapshot",
      turns: [
        { id: "turn-1", ordinal: 0, events: [{ text: "one" }, { text: "two" }] },
        { id: "turn-2", ordinal: 1, events: [{ text: "three" }] },
      ],
    });
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read!.turns)).toBe(true);
    expect(Object.isFrozen(read!.turns[0]!.events)).toBe(true);
  });

  it("fails the whole read on summary children or snapshot row tampering", () => {
    const summaryFixture = fixture();
    promoteSummary(summaryFixture.store, summaryFixture.stage, summaryFixture.key);
    summaryFixture.db.prepare(`INSERT INTO provider_turn_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, status, ordinal
    ) VALUES (?, ?, ?, ?, 'native:v1:Y29ycnVwdA', 'complete', 0)`)
      .run(
        summaryFixture.locator.provider,
        summaryFixture.locator.homeFingerprint,
        summaryFixture.locator.nativeTaskId,
        summaryFixture.stage.generation,
      );
    expectStoreError(
      () => summaryFixture.store.read(summaryFixture.locator),
      "CORRUPT_ROW",
    );

    for (const corruption of ["event-json", "snapshot-fingerprint"] as const) {
      const active = fixture();
      const task = snapshotWithTurns(active.key, [["trusted"]]);
      promoteTask(active.store, active.stage, active.key, task, 1, 1);
      if (corruption === "event-json") {
        active.db.exec(`UPDATE provider_event_cache SET event_json = '{}'`);
      } else {
        active.db.prepare(`UPDATE provider_replay_receipts
          SET snapshot_fingerprint = ?`).run("0".repeat(64));
      }
      expectStoreError(() => active.store.read(active.locator), "CORRUPT_ROW");
    }
  });

  it("bounds snapshot child materialization with one corruption sentinel row", () => {
    const { db, store, key, locator, stage } = fixture();
    const task = snapshotWithTurns(key, [["one", "two"], ["three"]]);
    promoteTask(store, stage, key, task, 2, 3);
    const originalPrepare = db.prepare.bind(db);
    const limits = new Map<string, number>();
    Object.defineProperty(db, "prepare", {
      configurable: true,
      value: (sql: string) => {
        const statement = originalPrepare(sql);
        const match = /SELECT \* FROM (provider_(?:turn_cache|event_cache|replay_receipts))/u
          .exec(sql);
        if (match === null) return statement;
        return {
          all: (...parameters: Array<string | number | null>) => {
            limits.set(match[1]!, parameters.at(-1) as number);
            return statement.all(...parameters);
          },
        };
      },
    });

    expect(store.read(locator)).not.toBeNull();

    expect(limits).toEqual(new Map([
      ["provider_replay_receipts", 2],
      ["provider_turn_cache", 3],
      ["provider_event_cache", 4],
    ]));
  });

  it("invalidates the exact locator from every generation without changing sync or durable state", () => {
    const { db, store, key, locator, stage } = fixture();
    promoteSnapshot(store, stage, key);
    const otherKey = Object.freeze({ ...key, nativeTaskId: "other-task" });
    store.replaceActiveSummary(otherKey, summary(otherKey), 400);
    const liveStage = store.beginStage({
      provider: locator.provider,
      homeFingerprint: locator.homeFingerprint,
    });
    store.stageSnapshot(liveStage, key, snapshot(key));
    store.stageSummary(liveStage, otherKey, summary(otherKey));
    db.prepare(`INSERT INTO provider_task_cache (
      provider, home_fingerprint, native_task_id, title, status, source,
      cache_generation, observed_at
    ) VALUES (?, ?, ?, 'future', 'idle', 'degraded-fallback', ?, 1)`)
      .run(locator.provider, locator.homeFingerprint, locator.nativeTaskId, liveStage.generation + 1);
    store.requireReconciliation(locator, {
      reviewedFingerprint: null,
      nativeFingerprint: "openai:v1:durable",
      writerEpoch: 0,
      reason: "NATIVE_REVISION_MISMATCH",
    });
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).get();

    expect(store.invalidate(locator)).toBe(true);

    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_task_cache
      WHERE native_task_id = ?`).get(locator.nativeTaskId)).toEqual({ count: 0 });
    for (const table of [
      "provider_turn_cache",
      "provider_event_cache",
      "provider_replay_receipts",
    ] as const) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}
        WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?`).get(
        locator.provider,
        locator.homeFingerprint,
        locator.nativeTaskId,
      )).toEqual({ count: 0 });
    }
    expect(db.prepare(`SELECT native_task_id, cache_generation FROM provider_task_cache
      ORDER BY cache_generation`).all()).toEqual([
      { native_task_id: otherKey.nativeTaskId, cache_generation: stage.generation },
      { native_task_id: otherKey.nativeTaskId, cache_generation: liveStage.generation },
    ]);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).get()).toEqual(beforeSync);
    expect(db.prepare(`SELECT required FROM provider_reconciliation_state`).get())
      .toEqual({ required: 1 });
    expect(store.invalidate(locator)).toBe(false);
  });

  it.each(["ignored", "rewritten"] as const)(
    "rolls back invalidation when deletion is $failure",
    (failure) => {
      const { db, store, key, locator, stage } = fixture();
      promoteSummary(store, stage, key);
      const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();
      const timing = failure === "ignored" ? "BEFORE" : "AFTER";
      const body = failure === "ignored"
        ? "SELECT RAISE(IGNORE);"
        : `INSERT INTO provider_task_cache (
            provider, home_fingerprint, native_task_id, title, status, source,
            cache_generation, observed_at
          ) VALUES (
            OLD.provider, OLD.home_fingerprint, OLD.native_task_id, OLD.title,
            OLD.status, OLD.source, OLD.cache_generation, OLD.observed_at
          );`;
      db.exec(`CREATE TRIGGER fail_invalidation ${timing} DELETE ON provider_task_cache
        BEGIN ${body} END`);

      expectStoreError(() => store.invalidate(locator), "CORRUPT_ROW");
      expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
    },
  );

  it("clears rebuildable cache with exact counts", () => {
    const { store, key, stage } = fixture();
    promoteSummary(store, stage, key);

    expect(store.clearRebuildableCache()).toEqual({
      taskCount: 1,
      turnCount: 0,
      eventCount: 0,
      receiptCount: 0,
    });
  });

  it("clears all generations in exact scope while preserving epoch, durable rows, and another home", () => {
    const { db, store, key, locator, stage } = fixture();
    const task = snapshotWithTurns(key, [["one", "two"], ["three"]]);
    promoteTask(store, stage, key, task, 2, 3);
    const liveStage = store.beginStage({
      provider: locator.provider,
      homeFingerprint: locator.homeFingerprint,
    });
    const stagedKey = Object.freeze({ ...key, nativeTaskId: "staged-task" });
    store.stageSummary(liveStage, stagedKey, summary(stagedKey));
    db.prepare(`INSERT INTO provider_task_cache (
      provider, home_fingerprint, native_task_id, title, status, source,
      cache_generation, observed_at
    ) VALUES (?, ?, 'future-task', 'future', 'idle', 'degraded-fallback', ?, 1)`)
      .run(locator.provider, locator.homeFingerprint, liveStage.generation + 1);
    store.requireReconciliation(locator, {
      reviewedFingerprint: null,
      nativeFingerprint: "openai:v1:clear-durable",
      writerEpoch: 0,
      reason: "NATIVE_REVISION_MISMATCH",
    });
    db.prepare(`INSERT INTO provider_task_meta (
      provider, home_fingerprint, native_task_id, updated_at
    ) VALUES (?, ?, ?, 1)`).run(
      locator.provider,
      locator.homeFingerprint,
      locator.nativeTaskId,
    );
    db.prepare(`INSERT INTO legacy_session_task_map (
      legacy_session_id, provider, home_fingerprint, native_task_id,
      mapping_source, verified_at
    ) VALUES ('legacy-map', ?, ?, ?, 'verified', 1)`).run(
      locator.provider,
      locator.homeFingerprint,
      locator.nativeTaskId,
    );
    db.exec(`INSERT INTO legacy_session_provenance (
      legacy_session_id, provenance, observed_at
    ) VALUES ('legacy-provenance', 'unresolved', 1)`);

    const otherHome = tempDirectory();
    const otherRegistration = store.registerHome({ provider: "openai", home: otherHome }, 2);
    const otherKey = Object.freeze({
      provider: "openai",
      home: otherHome,
      nativeTaskId: "other-task",
    } as const);
    const otherStage = store.beginStage({
      provider: "openai",
      homeFingerprint: otherRegistration.homeFingerprint,
    });
    promoteSummary(store, otherStage, otherKey);
    db.prepare(`INSERT INTO provider_fork_links (
      source_provider, source_home_fingerprint, source_native_task_id,
      target_provider, target_home_fingerprint, target_native_task_id,
      created_at, transfer_digest
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(
      locator.provider,
      locator.homeFingerprint,
      locator.nativeTaskId,
      otherRegistration.provider,
      otherRegistration.homeFingerprint,
      otherKey.nativeTaskId,
      "a".repeat(64),
    );
    const durableTables = [
      "provider_homes",
      "provider_task_meta",
      "provider_fork_links",
      "legacy_session_task_map",
      "legacy_session_provenance",
      "provider_reconciliation_state",
    ] as const;
    const durableBefore = new Map(durableTables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table}`).all(),
    ]));
    const otherRows = db.prepare(`SELECT * FROM provider_task_cache
      WHERE home_fingerprint = ?`).all(otherRegistration.homeFingerprint);
    const otherSync = db.prepare(`SELECT * FROM provider_sync_state
      WHERE home_fingerprint = ?`).get(otherRegistration.homeFingerprint);

    expect(store.clearRebuildableCache({
      provider: locator.provider,
      homeFingerprint: locator.homeFingerprint,
    })).toEqual({
      taskCount: 3,
      turnCount: 2,
      eventCount: 3,
      receiptCount: 1,
    });

    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_task_cache
      WHERE home_fingerprint = ?`).get(locator.homeFingerprint)).toEqual({ count: 0 });
    expect(db.prepare(`SELECT active_generation, staging_generation, state, generation_epoch
      FROM provider_sync_state WHERE home_fingerprint = ?`).get(locator.homeFingerprint))
      .toEqual({
        active_generation: 0,
        staging_generation: null,
        state: "idle",
        generation_epoch: liveStage.generation,
      });
    expect(db.prepare(`SELECT * FROM provider_task_cache
      WHERE home_fingerprint = ?`).all(otherRegistration.homeFingerprint)).toEqual(otherRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state
      WHERE home_fingerprint = ?`).get(otherRegistration.homeFingerprint)).toEqual(otherSync);
    expect(store.clearRebuildableCache({ provider: "openai", homeFingerprint: null }))
      .toEqual({ taskCount: 1, turnCount: 0, eventCount: 0, receiptCount: 0 });
    expect(store.clearRebuildableCache()).toEqual({
      taskCount: 0,
      turnCount: 0,
      eventCount: 0,
      receiptCount: 0,
    });
    for (const table of durableTables) {
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(durableBefore.get(table));
    }
  });

  it.each(["ignored", "rewritten"] as const)(
    "rolls back clear when cache deletion is $failure",
    (failure) => {
      const { db, store, key, stage } = fixture();
      promoteSummary(store, stage, key);
      const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();
      const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).all();
      const timing = failure === "ignored" ? "BEFORE" : "AFTER";
      const body = failure === "ignored"
        ? "SELECT RAISE(IGNORE);"
        : `INSERT INTO provider_task_cache (
            provider, home_fingerprint, native_task_id, title, status, source,
            cache_generation, observed_at
          ) VALUES (
            OLD.provider, OLD.home_fingerprint, OLD.native_task_id, OLD.title,
            OLD.status, OLD.source, OLD.cache_generation, OLD.observed_at
          );`;
      db.exec(`CREATE TRIGGER fail_clear_cache ${timing} DELETE ON provider_task_cache
        BEGIN ${body} END`);

      expectStoreError(() => store.clearRebuildableCache(), "CORRUPT_ROW");
      expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
      expect(db.prepare(`SELECT * FROM provider_sync_state`).all()).toEqual(beforeSync);
    },
  );

  it.each(["ignored", "deleted", "rewritten"] as const)(
    "rolls back clear when sync reset is $failure",
    (failure) => {
      const { db, store, key, stage } = fixture();
      promoteSummary(store, stage, key);
      const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();
      const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).all();
      const timing = failure === "ignored" ? "BEFORE" : "AFTER";
      const body = failure === "ignored"
        ? "SELECT RAISE(IGNORE);"
        : failure === "deleted"
          ? `DELETE FROM provider_sync_state
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint;`
          : `UPDATE provider_sync_state SET generation_epoch = generation_epoch + 1
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint;`;
      db.exec(`CREATE TRIGGER fail_clear_sync ${timing} UPDATE ON provider_sync_state
        BEGIN ${body} END`);

      expectStoreError(() => store.clearRebuildableCache(), "CORRUPT_ROW");
      expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
      expect(db.prepare(`SELECT * FROM provider_sync_state`).all()).toEqual(beforeSync);
    },
  );

  it("rejects caller-owned transactions before hostile replacement input", () => {
    const { db, store, key, locator, stage } = fixture();
    promoteSummary(store, stage, key);
    const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();
    const beforeSync = db.prepare(`SELECT * FROM provider_sync_state`).all();
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "key", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("must not run");
      },
    }) as NativeTaskSummary;
    db.exec("BEGIN");
    try {
      expectStoreError(
        () => store.replaceActiveSummary(key, hostile, 400),
        "DATABASE_UNAVAILABLE",
      );
      expectStoreError(() => store.invalidate(locator), "DATABASE_UNAVAILABLE");
      expectStoreError(() => store.clearRebuildableCache(), "DATABASE_UNAVAILABLE");
    } finally {
      db.exec("ROLLBACK");
    }
    expect(getterCalls).toBe(0);
    expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
    expect(db.prepare(`SELECT * FROM provider_sync_state`).all()).toEqual(beforeSync);
  });

  it("maps every E operation on a closed database to DATABASE_UNAVAILABLE", () => {
    const { db, store, key, locator, stage } = fixture();
    promoteSummary(store, stage, key);
    db.close();

    const operations = [
      () => store.replaceActiveSummary(key, summary(key), 400),
      () => store.replaceActiveSnapshot(key, snapshot(key), 400),
      () => store.list({}),
      () => store.read(locator),
      () => store.invalidate(locator),
      () => store.clearRebuildableCache(),
    ];
    for (const operation of operations) {
      expectStoreError(operation, "DATABASE_UNAVAILABLE");
    }
  });

  it("rolls back E mutations when another connection owns the write lock", () => {
    const root = tempDirectory();
    const filename = path.join(root, "active-busy.db");
    const home = tempDirectory();
    const ownerDb = openDatabase(filename);
    const ownerStore = new ProviderTaskIndexStore(ownerDb, {
      now: () => 100,
      tokenFactory: () => "active-busy-owner",
    });
    const registration = ownerStore.registerHome({ provider: "openai", home }, 1);
    const key = Object.freeze({ provider: "openai", home, nativeTaskId: "busy-task" } as const);
    const locator = Object.freeze({
      version: 1,
      provider: "openai",
      homeFingerprint: registration.homeFingerprint,
      nativeTaskId: key.nativeTaskId,
    } as const);
    const stage = ownerStore.beginStage({
      provider: registration.provider,
      homeFingerprint: registration.homeFingerprint,
    });
    promoteSummary(ownerStore, stage, key);
    const beforeRows = ownerDb.prepare(`SELECT * FROM provider_task_cache`).all();
    const beforeSync = ownerDb.prepare(`SELECT * FROM provider_sync_state`).all();
    const contenderDb = reopenDatabase(filename);
    contenderDb.exec("PRAGMA busy_timeout = 1");
    const contender = new ProviderTaskIndexStore(contenderDb);

    ownerDb.exec("BEGIN IMMEDIATE");
    try {
      expectStoreError(
        () => contender.replaceActiveSummary(key, summary(key), 400),
        "DATABASE_UNAVAILABLE",
      );
      expectStoreError(() => contender.invalidate(locator), "DATABASE_UNAVAILABLE");
      expectStoreError(() => contender.clearRebuildableCache(), "DATABASE_UNAVAILABLE");
    } finally {
      ownerDb.exec("ROLLBACK");
    }
    expect(ownerDb.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
    expect(ownerDb.prepare(`SELECT * FROM provider_sync_state`).all()).toEqual(beforeSync);
  });

  it("shares the per-database guard across store instances during hostile list input", () => {
    const { db, store, key, stage } = fixture();
    promoteSummary(store, stage, key);
    const second = new ProviderTaskIndexStore(db);
    let trapCalls = 0;
    const hostile = new Proxy({}, {
      getPrototypeOf: () => {
        trapCalls += 1;
        second.list({});
        return Object.prototype;
      },
    });
    const beforeRows = db.prepare(`SELECT * FROM provider_task_cache`).all();

    expectStoreError(() => store.list(hostile), "INVALID_INPUT");

    expect(trapCalls).toBe(1);
    expect(db.prepare(`SELECT * FROM provider_task_cache`).all()).toEqual(beforeRows);
    expect(second.list({}).items).toHaveLength(1);
  });
});
