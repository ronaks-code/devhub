import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../../src/migrations.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import {
  ProviderIndexStoreError,
  type ProviderHomeScope,
  type ProviderIndexStage,
} from "../../src/provider-index/store-types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const databases: TestDatabase[] = [];
const directories: string[] = [];

function tempDirectory(prefix = "devhub-provider-stage-"): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return realpathSync(directory);
}

function openDatabase(file = ":memory:"): TestDatabase {
  const db = new DatabaseSync(file);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA user_version = 13");
  runMigrations(db);
  return db;
}

function reopenDatabase(file: string): TestDatabase {
  const db = new DatabaseSync(file);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function closeDatabase(db: TestDatabase): void {
  try {
    db.close();
  } catch {
    // Closed-database behavior is exercised deliberately.
  }
}

function expectStoreError(
  operation: () => unknown,
  code: ProviderIndexStoreError["code"],
  forbidden = "must-not-leak",
): ProviderIndexStoreError {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ProviderIndexStoreError);
  expect(thrown).toMatchObject({ code });
  expect((thrown as Error).message).not.toContain(forbidden);
  return thrown as ProviderIndexStoreError;
}

function registerScope(
  store: ProviderTaskIndexStore,
  home = tempDirectory("devhub-provider-home-"),
): { readonly home: string; readonly scope: Readonly<ProviderHomeScope> } {
  const registration = store.registerHome({ provider: "openai", home }, 1_000);
  return {
    home,
    scope: Object.freeze({
      provider: registration.provider,
      homeFingerprint: registration.homeFingerprint,
    }),
  };
}

function rawSync(
  db: TestDatabase,
  scope: ProviderHomeScope,
): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM provider_sync_state
    WHERE provider = ? AND home_fingerprint = ?`)
    .get(scope.provider, scope.homeFingerprint) as Record<string, unknown> | undefined;
}

function seedIdle(
  db: TestDatabase,
  scope: ProviderHomeScope,
  activeGeneration: number,
  generationEpoch = activeGeneration,
): void {
  db.prepare(`INSERT INTO provider_sync_state (
    provider, home_fingerprint, active_generation, state,
    provider_version, last_completed_at, generation_epoch
  ) VALUES (?, ?, ?, 'idle', ?, ?, ?)`)
    .run(
      scope.provider,
      scope.homeFingerprint,
      activeGeneration,
      "provider-version-preserved",
      900,
      generationEpoch,
    );
}

function seedCache(
  db: TestDatabase,
  scope: ProviderHomeScope,
  generation: number,
  nativeTaskId: string,
): void {
  db.prepare(`INSERT INTO provider_task_cache (
    provider, home_fingerprint, native_task_id, title, status, source,
    cache_generation, observed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      scope.provider,
      scope.homeFingerprint,
      nativeTaskId,
      `title-${nativeTaskId}`,
      "ready",
      "degraded-fallback",
      generation,
      1_000,
    );
}

function cacheIds(db: TestDatabase, scope: ProviderHomeScope): readonly string[] {
  return (db.prepare(`SELECT native_task_id FROM provider_task_cache
    WHERE provider = ? AND home_fingerprint = ?
    ORDER BY native_task_id`).all(scope.provider, scope.homeFingerprint) as Array<{
      native_task_id: string;
    }>).map((row) => row.native_task_id);
}

function scopeRows(
  db: TestDatabase,
  scope: ProviderHomeScope,
): Readonly<Record<string, readonly Record<string, unknown>[] | Record<string, unknown> | undefined>> {
  const scopedRows = (table: string): readonly Record<string, unknown>[] =>
    db.prepare(`SELECT * FROM ${table}
      WHERE provider = ? AND home_fingerprint = ?
      ORDER BY native_task_id`)
      .all(scope.provider, scope.homeFingerprint) as Record<string, unknown>[];
  return Object.freeze({
    sync: rawSync(db, scope),
    cache: scopedRows("provider_task_cache"),
    meta: scopedRows("provider_task_meta"),
    reconciliation: scopedRows("provider_reconciliation_state"),
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProviderTaskIndexStore stage lifecycle", () => {
  it("begins generation one with one ordered pre-transaction clock and token sample", () => {
    const db = openDatabase();
    const calls: string[] = [];
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => {
        calls.push(`clock:${String(db.isTransaction)}`);
        return 100;
      },
      tokenFactory: () => {
        calls.push(`token:${String(db.isTransaction)}`);
        return "owner-one";
      },
    });
    const { scope } = registerScope(store);

    const stage = store.beginStage(scope);

    expect(stage).toEqual({ ...scope, generation: 1, ownerToken: "owner-one" });
    expect(Object.isFrozen(stage)).toBe(true);
    expect(calls).toEqual(["clock:false", "token:false"]);
    expect(rawSync(db, scope)).toEqual({
      provider: scope.provider,
      home_fingerprint: scope.homeFingerprint,
      active_generation: 0,
      staging_generation: 1,
      staging_owner_token: "owner-one",
      staging_heartbeat_at: 100,
      staging_expires_at: 1_100,
      state: "staging",
      provider_version: null,
      last_completed_at: null,
      generation_epoch: 1,
    });
  });

  it("refuses a live stage without changing it and samples callbacks only once", () => {
    const db = openDatabase();
    let now = 100;
    let clockCalls = 0;
    let tokenCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => {
        clockCalls += 1;
        return now;
      },
      tokenFactory: () => {
        tokenCalls += 1;
        return `owner-${String(tokenCalls)}`;
      },
    });
    const { scope } = registerScope(store);
    store.beginStage(scope);
    const before = rawSync(db, scope);
    now = 1_099;

    expectStoreError(() => store.beginStage(scope), "STAGE_BUSY");

    expect(clockCalls).toBe(2);
    expect(tokenCalls).toBe(2);
    expect(rawSync(db, scope)).toEqual(before);
  });

  it("takes over exactly at expiry, deletes only abandoned cache, and survives reopen", () => {
    const root = tempDirectory();
    const file = path.join(root, "stage-recovery.db");
    const db = openDatabase(file);
    let now = 100;
    let token = "owner-old";
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => now,
      tokenFactory: () => token,
    });
    const { scope } = registerScope(store);
    seedIdle(db, scope, 3);
    seedCache(db, scope, 3, "active-task");
    const abandoned = store.beginStage(scope);
    seedCache(db, scope, abandoned.generation, "abandoned-task");
    now = 1_100;
    token = "owner-new";

    const successor = store.beginStage(scope);

    expect(successor).toEqual({ ...scope, generation: 5, ownerToken: "owner-new" });
    expect(cacheIds(db, scope)).toEqual(["active-task"]);
    expect(rawSync(db, scope)).toMatchObject({
      active_generation: 3,
      staging_generation: 5,
      generation_epoch: 5,
      provider_version: "provider-version-preserved",
      last_completed_at: 900,
    });
    closeDatabase(db);
    const reopened = reopenDatabase(file);
    expect(rawSync(reopened, scope)).toMatchObject({
      active_generation: 3,
      staging_generation: 5,
      staging_owner_token: "owner-new",
      generation_epoch: 5,
    });
  });

  it("aborts an expired exact stage and never reuses its generation with a repeated token", () => {
    const db = openDatabase();
    let now = 100;
    let clockCalls = 0;
    let tokenCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => {
        clockCalls += 1;
        return now;
      },
      tokenFactory: () => {
        tokenCalls += 1;
        return "repeated-owner";
      },
    });
    const { scope } = registerScope(store);
    const first = store.beginStage(scope);
    seedCache(db, scope, first.generation, "discarded-task");
    now = 9_000;

    expect(store.abortStage(first)).toBeUndefined();
    expect(clockCalls).toBe(1);
    expect(tokenCalls).toBe(1);
    expect(cacheIds(db, scope)).toEqual([]);
    expect(rawSync(db, scope)).toMatchObject({
      state: "idle",
      staging_generation: null,
      generation_epoch: 1,
    });

    const second = store.beginStage(scope);
    expect(second).toEqual({ ...scope, generation: 2, ownerToken: "repeated-owner" });
  });

  it("preserves active cache and durable rows while aborting only staged cache", () => {
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => 100,
      tokenFactory: () => "owner-preserve",
    });
    const { scope } = registerScope(store);
    seedIdle(db, scope, 7, 9);
    seedCache(db, scope, 7, "active-task");
    const stage = store.beginStage(scope);
    seedCache(db, scope, stage.generation, "staged-task");
    db.prepare(`INSERT INTO provider_task_meta (
      provider, home_fingerprint, native_task_id, local_label, updated_at
    ) VALUES (?, ?, ?, ?, ?)`)
      .run(scope.provider, scope.homeFingerprint, "durable-task", "keep", 1);
    db.prepare(`INSERT INTO provider_reconciliation_state (
      provider, home_fingerprint, native_task_id, required, latch_revision,
      writer_epoch, reason, updated_at
    ) VALUES (?, ?, ?, 1, 1, 1, ?, ?)`)
      .run(scope.provider, scope.homeFingerprint, "durable-task", "WRITER_LEASE_LOST", 1);

    store.abortStage(stage);

    expect(cacheIds(db, scope)).toEqual(["active-task"]);
    expect(rawSync(db, scope)).toMatchObject({
      active_generation: 7,
      generation_epoch: 10,
      state: "idle",
      provider_version: "provider-version-preserved",
      last_completed_at: 900,
    });
    expect(db.prepare("SELECT local_label FROM provider_task_meta").get()).toEqual({
      local_label: "keep",
    });
    expect(db.prepare("SELECT reason FROM provider_reconciliation_state").get()).toEqual({
      reason: "WRITER_LEASE_LOST",
    });
  });

  it("isolates expired takeover and abort from an identical generation and task in another scope", () => {
    const db = openDatabase();
    let now = 100;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => now,
      tokenFactory: () => "same-owner-token",
    });
    const scopeA = registerScope(store, tempDirectory("devhub-stage-scope-a-")).scope;
    const scopeB = registerScope(store, tempDirectory("devhub-stage-scope-b-")).scope;
    const stageA = store.beginStage(scopeA);
    const stageB = store.beginStage(scopeB);
    expect(stageA.generation).toBe(1);
    expect(stageB.generation).toBe(1);
    seedCache(db, scopeA, stageA.generation, "same-native-task");
    seedCache(db, scopeB, stageB.generation, "same-native-task");
    db.prepare(`INSERT INTO provider_task_meta (
      provider, home_fingerprint, native_task_id, favorite, local_label, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?)`)
      .run(scopeB.provider, scopeB.homeFingerprint, "same-native-task", "scope-b", 101);
    db.prepare(`INSERT INTO provider_reconciliation_state (
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at
    ) VALUES (?, ?, ?, 1, 1, ?, ?, 4, ?, ?)`)
      .run(
        scopeB.provider,
        scopeB.homeFingerprint,
        "same-native-task",
        "scope-b-reviewed",
        "scope-b-native",
        "WRITER_LEASE_LOST",
        102,
      );
    const scopeBBefore = scopeRows(db, scopeB);
    now = 1_100;

    const successorA = store.beginStage(scopeA);

    expect(successorA).toEqual({
      ...scopeA,
      generation: 2,
      ownerToken: "same-owner-token",
    });
    expect(scopeRows(db, scopeB)).toEqual(scopeBBefore);
    expect(cacheIds(db, scopeA)).toEqual([]);
    seedCache(db, scopeA, successorA.generation, "same-native-task");

    store.abortStage(successorA);

    expect(scopeRows(db, scopeB)).toEqual(scopeBBefore);
    expect(cacheIds(db, scopeA)).toEqual([]);
  });

  it("fails epoch capacity without changing state or over-sampling callbacks", () => {
    const db = openDatabase();
    let clockCalls = 0;
    let tokenCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => {
        clockCalls += 1;
        return 100;
      },
      tokenFactory: () => {
        tokenCalls += 1;
        return "owner-capacity";
      },
    });
    const { scope } = registerScope(store);
    seedIdle(db, scope, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const before = rawSync(db, scope);

    expectStoreError(() => store.beginStage(scope), "CAPACITY");

    expect(clockCalls).toBe(1);
    expect(tokenCalls).toBe(1);
    expect(rawSync(db, scope)).toEqual(before);
  });

  it.each(["missing-sync", "idle-tombstone-cache", "epoch-behind-cache"] as const)(
    "fails closed when %s would permit an already-cached generation to be allocated",
    (shape) => {
      const db = openDatabase();
      const store = new ProviderTaskIndexStore(db, {
        stageLeaseMs: 1_000,
        now: () => 100,
        tokenFactory: () => "owner-cache-collision",
      });
      const { scope } = registerScope(store);
      if (shape === "missing-sync") {
        seedCache(db, scope, 1, "orphan-cache");
      } else if (shape === "idle-tombstone-cache") {
        seedIdle(db, scope, 0, 1);
        seedCache(db, scope, 1, "tombstone-cache");
      } else {
        seedIdle(db, scope, 0, 1);
        seedCache(db, scope, 3, "future-cache");
      }
      const before = rawSync(db, scope);

      expectStoreError(() => store.beginStage(scope), "CORRUPT_ROW");

      expect(rawSync(db, scope)).toEqual(before);
      expect(cacheIds(db, scope)).toEqual([
        shape === "missing-sync"
          ? "orphan-cache"
          : shape === "idle-tombstone-cache"
            ? "tombstone-cache"
            : "future-cache",
      ]);
    },
  );

  it("renews heartbeats, accepts an exact-time replay, and samples no token", () => {
    const db = openDatabase();
    let now = 100;
    let clockCalls = 0;
    let tokenCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => {
        clockCalls += 1;
        return now;
      },
      tokenFactory: () => {
        tokenCalls += 1;
        return "owner-heartbeat";
      },
    });
    const { scope } = registerScope(store);
    const stage = store.beginStage(scope);
    now = 500;

    expect(store.heartbeatStage(stage)).toBe(true);
    const renewed = rawSync(db, scope);
    expect(renewed).toMatchObject({
      staging_heartbeat_at: 500,
      staging_expires_at: 1_500,
      generation_epoch: 1,
    });
    expect(store.heartbeatStage(stage)).toBe(true);
    expect(rawSync(db, scope)).toEqual(renewed);
    expect(clockCalls).toBe(3);
    expect(tokenCalls).toBe(1);
  });

  it("never shortens an existing lease when a reopened store uses a shorter duration", () => {
    const db = openDatabase();
    let now = 100;
    const original = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 300_000,
      now: () => now,
      tokenFactory: () => "owner-long-lease",
    });
    const { scope } = registerScope(original);
    const stage = original.beginStage(scope);
    const originalExpiry = rawSync(db, scope)?.staging_expires_at;
    now = 200;
    const reopened = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => now,
      tokenFactory: () => "unused-token",
    });

    expect(reopened.heartbeatStage(stage)).toBe(true);
    expect(rawSync(db, scope)).toMatchObject({
      staging_heartbeat_at: 200,
      staging_expires_at: originalExpiry,
    });
  });

  it("returns false without mutation for lost, stale, and expired heartbeats", () => {
    const db = openDatabase();
    let now = 100;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => now,
      tokenFactory: () => "owner-live",
    });
    const { scope } = registerScope(store);
    const stage = store.beginStage(scope);
    const before = rawSync(db, scope);
    const wrongToken = Object.freeze({ ...stage, ownerToken: "owner-stale" });
    const wrongGeneration = Object.freeze({ ...stage, generation: 2 });

    expect(store.heartbeatStage(wrongToken)).toBe(false);
    expect(store.heartbeatStage(wrongGeneration)).toBe(false);
    now = 1_100;
    expect(store.heartbeatStage(stage)).toBe(false);
    expect(rawSync(db, scope)).toEqual(before);
  });

  it("rejects regressing and overflowing heartbeat clocks without mutation", () => {
    const db = openDatabase();
    let now = 100;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => now,
      tokenFactory: () => "owner-clock",
    });
    const { scope } = registerScope(store);
    const stage = store.beginStage(scope);
    const before = rawSync(db, scope);

    now = 99;
    expectStoreError(() => store.heartbeatStage(stage), "CLOCK_FAILURE");
    expect(rawSync(db, scope)).toEqual(before);
    now = Number.MAX_SAFE_INTEGER;
    expectStoreError(() => store.heartbeatStage(stage), "CLOCK_FAILURE");
    expect(rawSync(db, scope)).toEqual(before);
  });

  it("rejects begin lease overflow before sampling a token", () => {
    const db = openDatabase();
    let tokenCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => Number.MAX_SAFE_INTEGER,
      tokenFactory: () => {
        tokenCalls += 1;
        return "owner-overflow";
      },
    });
    const { scope } = registerScope(store);

    expectStoreError(() => store.beginStage(scope), "CLOCK_FAILURE");
    expect(tokenCalls).toBe(0);
    expect(rawSync(db, scope)).toBeUndefined();
  });

  it("rejects stale abort handles and leaves the live stage unchanged", () => {
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => 100,
      tokenFactory: () => "owner-abort",
    });
    const { scope } = registerScope(store);
    const stage = store.beginStage(scope);
    const before = rawSync(db, scope);

    expectStoreError(
      () => store.abortStage({ ...stage, ownerToken: "wrong-owner" }),
      "STAGE_LOST",
    );
    expectStoreError(() => store.abortStage({ ...stage, generation: 2 }), "STAGE_LOST");
    expect(rawSync(db, scope)).toEqual(before);
    store.abortStage(stage);
    expectStoreError(() => store.abortStage(stage), "STAGE_LOST");
  });

  it("rejects caller transactions before hostile input or callbacks for every lifecycle method", () => {
    const db = openDatabase();
    let callbackCalls = 0;
    let trapCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        callbackCalls += 1;
        return 100;
      },
      tokenFactory: () => {
        callbackCalls += 1;
        return "owner-outer";
      },
    });
    const hostile = new Proxy({}, {
      getPrototypeOf: () => {
        trapCalls += 1;
        return Object.prototype;
      },
    });
    db.exec("BEGIN");
    try {
      expectStoreError(() => store.beginStage(hostile as never), "DATABASE_UNAVAILABLE");
      expectStoreError(() => store.heartbeatStage(hostile as never), "DATABASE_UNAVAILABLE");
      expectStoreError(() => store.abortStage(hostile as never), "DATABASE_UNAVAILABLE");
    } finally {
      db.exec("ROLLBACK");
    }
    expect(callbackCalls).toBe(0);
    expect(trapCalls).toBe(0);
  });

  it("rejects proxy, accessor, and extra-key lifecycle inputs before callbacks", () => {
    const db = openDatabase();
    let callbackCalls = 0;
    let trapCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        callbackCalls += 1;
        return 100;
      },
      tokenFactory: () => {
        callbackCalls += 1;
        return "owner-hostile";
      },
    });
    const proxy = new Proxy({ provider: "openai", homeFingerprint: "f".repeat(64) }, {
      getPrototypeOf: () => {
        trapCalls += 1;
        return Object.prototype;
      },
    });
    const accessor = Object.defineProperty({ provider: "openai" }, "homeFingerprint", {
      enumerable: true,
      get: () => {
        trapCalls += 1;
        return "f".repeat(64);
      },
    });

    expectStoreError(() => store.beginStage(proxy as never), "INVALID_INPUT");
    expectStoreError(() => store.beginStage(accessor as never), "INVALID_INPUT");
    expectStoreError(
      () => store.beginStage({
        provider: "openai",
        homeFingerprint: "f".repeat(64),
        extra: true,
      } as never),
      "INVALID_INPUT",
    );
    expect(callbackCalls).toBe(0);
    expect(trapCalls).toBe(0);
  });

  it("maps reentrant clock and token lifecycle callbacks to their stable failures", () => {
    const db = openDatabase();
    const home = tempDirectory("devhub-provider-reentrant-");
    let clockStore!: ProviderTaskIndexStore;
    let tokenStore!: ProviderTaskIndexStore;
    let clockScope!: Readonly<ProviderHomeScope>;
    let tokenScope!: Readonly<ProviderHomeScope>;
    clockStore = new ProviderTaskIndexStore(db, {
      now: () => {
        clockStore.abortStage({ ...clockScope, generation: 1, ownerToken: "inner" });
        return 100;
      },
      tokenFactory: () => "outer-clock",
    });
    clockScope = registerScope(clockStore, home).scope;
    expectStoreError(() => clockStore.beginStage(clockScope), "CLOCK_FAILURE");

    tokenStore = new ProviderTaskIndexStore(db, {
      now: () => 100,
      tokenFactory: () => {
        tokenStore.abortStage({ ...tokenScope, generation: 1, ownerToken: "inner" });
        return "outer-token";
      },
    });
    tokenScope = clockScope;
    expectStoreError(() => tokenStore.beginStage(tokenScope), "TOKEN_FAILURE");
    expect(rawSync(db, clockScope)).toBeUndefined();
  });

  it("rechecks registered-home authority after callbacks and before allocating", () => {
    const root = tempDirectory();
    const file = path.join(root, "home-recheck.db");
    const db = openDatabase(file);
    const deleter = reopenDatabase(file);
    let scope!: Readonly<ProviderHomeScope>;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        deleter.prepare(`DELETE FROM provider_homes
          WHERE provider = ? AND home_fingerprint = ?`)
          .run(scope.provider, scope.homeFingerprint);
        return 100;
      },
      tokenFactory: () => "owner-home-race",
    });
    scope = registerScope(store).scope;

    expectStoreError(() => store.beginStage(scope), "UNKNOWN_HOME");
    expect(rawSync(db, scope)).toBeUndefined();
  });

  it("maps closed and busy databases to value-free failures", () => {
    const closedDb = openDatabase();
    let closedCallbacks = 0;
    const closedStore = new ProviderTaskIndexStore(closedDb, {
      now: () => {
        closedCallbacks += 1;
        return 100;
      },
      tokenFactory: () => {
        closedCallbacks += 1;
        return "must-not-leak-closed-token";
      },
    });
    const closedScope = registerScope(closedStore).scope;
    closeDatabase(closedDb);
    expectStoreError(
      () => closedStore.beginStage(closedScope),
      "DATABASE_UNAVAILABLE",
      "must-not-leak-closed-token",
    );
    expect(closedCallbacks).toBe(0);

    const root = tempDirectory();
    const file = path.join(root, "busy.db");
    const ownerDb = openDatabase(file);
    const ownerStore = new ProviderTaskIndexStore(ownerDb);
    const busyScope = registerScope(ownerStore).scope;
    const contenderDb = reopenDatabase(file);
    contenderDb.exec("PRAGMA busy_timeout = 1");
    const contender = new ProviderTaskIndexStore(contenderDb, {
      now: () => 100,
      tokenFactory: () => "must-not-leak-busy-token",
    });
    ownerDb.exec("BEGIN IMMEDIATE");
    try {
      expectStoreError(
        () => contender.beginStage(busyScope),
        "DATABASE_UNAVAILABLE",
        "must-not-leak-busy-token",
      );
    } finally {
      ownerDb.exec("ROLLBACK");
    }
    expect(rawSync(contenderDb, busyScope)).toBeUndefined();
  });

  it.each([
    {
      name: "suppressed",
      trigger: `CREATE TRIGGER stage_begin_failure BEFORE INSERT ON provider_sync_state
        BEGIN SELECT RAISE(IGNORE); END`,
    },
    {
      name: "deleted",
      trigger: `CREATE TRIGGER stage_begin_failure AFTER INSERT ON provider_sync_state
        BEGIN DELETE FROM provider_sync_state
          WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint; END`,
    },
    {
      name: "rewritten",
      trigger: `CREATE TRIGGER stage_begin_failure AFTER INSERT ON provider_sync_state
        BEGIN UPDATE provider_sync_state SET staging_owner_token = 'trigger-owner'
          WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint; END`,
    },
  ])("rolls back a $name begin write as corrupt", ({ trigger }) => {
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, {
      now: () => 100,
      tokenFactory: () => "owner-trigger",
    });
    const { scope } = registerScope(store);
    db.exec(trigger);

    expectStoreError(() => store.beginStage(scope), "CORRUPT_ROW");
    expect(rawSync(db, scope)).toBeUndefined();
  });

  it.each([
    { path: "idle", failure: "suppressed" },
    { path: "idle", failure: "deleted" },
    { path: "idle", failure: "rewritten" },
    { path: "expired", failure: "suppressed" },
    { path: "expired", failure: "deleted" },
    { path: "expired", failure: "rewritten" },
  ] as const)(
    "rolls back a $failure begin UPDATE on the $path path",
    ({ path: updatePath, failure }) => {
      const db = openDatabase();
      let now = 100;
      const store = new ProviderTaskIndexStore(db, {
        stageLeaseMs: 1_000,
        now: () => now,
        tokenFactory: () => "owner-update-path",
      });
      const { scope } = registerScope(store);
      if (updatePath === "idle") {
        seedIdle(db, scope, 3);
        seedCache(db, scope, 3, "active-update-task");
      } else {
        const abandoned = store.beginStage(scope);
        seedCache(db, scope, abandoned.generation, "abandoned-update-task");
        now = 1_100;
      }
      const beforeSync = rawSync(db, scope);
      const beforeCache = scopeRows(db, scope).cache;
      const condition = updatePath === "idle"
        ? "OLD.state = 'idle' AND NEW.state = 'staging'"
        : `OLD.state = 'staging' AND NEW.state = 'staging'
            AND NEW.generation_epoch = OLD.generation_epoch + 1`;
      const timing = failure === "suppressed" ? "BEFORE" : "AFTER";
      const body = failure === "suppressed"
        ? "SELECT RAISE(IGNORE);"
        : failure === "deleted"
          ? `DELETE FROM provider_sync_state
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint;`
          : `UPDATE provider_sync_state SET staging_owner_token = 'trigger-owner'
              WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint;`;
      db.exec(`CREATE TRIGGER stage_begin_update_failure
        ${timing} UPDATE ON provider_sync_state
        WHEN ${condition}
        BEGIN ${body} END`);

      expectStoreError(() => store.beginStage(scope), "CORRUPT_ROW");

      expect(rawSync(db, scope)).toEqual(beforeSync);
      expect(scopeRows(db, scope).cache).toEqual(beforeCache);
    },
  );

  it.each([
    {
      name: "suppressed",
      trigger: `CREATE TRIGGER stage_heartbeat_failure BEFORE UPDATE ON provider_sync_state
        WHEN NEW.staging_heartbeat_at <> OLD.staging_heartbeat_at
        BEGIN SELECT RAISE(IGNORE); END`,
    },
    {
      name: "deleted",
      trigger: `CREATE TRIGGER stage_heartbeat_failure AFTER UPDATE ON provider_sync_state
        WHEN NEW.staging_heartbeat_at <> OLD.staging_heartbeat_at
        BEGIN DELETE FROM provider_sync_state
          WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint; END`,
    },
    {
      name: "rewritten",
      trigger: `CREATE TRIGGER stage_heartbeat_failure AFTER UPDATE ON provider_sync_state
        WHEN NEW.staging_heartbeat_at <> OLD.staging_heartbeat_at
        BEGIN UPDATE provider_sync_state SET staging_owner_token = 'trigger-owner'
          WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint; END`,
    },
  ])("rolls back a $name heartbeat write as corrupt", ({ trigger }) => {
    const db = openDatabase();
    let now = 100;
    const store = new ProviderTaskIndexStore(db, {
      stageLeaseMs: 1_000,
      now: () => now,
      tokenFactory: () => "owner-heartbeat-trigger",
    });
    const { scope } = registerScope(store);
    const stage = store.beginStage(scope);
    const before = rawSync(db, scope);
    db.exec(trigger);
    now = 200;

    expectStoreError(() => store.heartbeatStage(stage), "CORRUPT_ROW");
    expect(rawSync(db, scope)).toEqual(before);
  });

  it.each([
    {
      name: "suppressed",
      trigger: `CREATE TRIGGER stage_abort_failure BEFORE UPDATE ON provider_sync_state
        WHEN OLD.state = 'staging' AND NEW.state = 'idle'
        BEGIN SELECT RAISE(IGNORE); END`,
    },
    {
      name: "deleted",
      trigger: `CREATE TRIGGER stage_abort_failure AFTER UPDATE ON provider_sync_state
        WHEN OLD.state = 'staging' AND NEW.state = 'idle'
        BEGIN DELETE FROM provider_sync_state
          WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint; END`,
    },
    {
      name: "rewritten",
      trigger: `CREATE TRIGGER stage_abort_failure AFTER UPDATE ON provider_sync_state
        WHEN OLD.state = 'staging' AND NEW.state = 'idle'
        BEGIN UPDATE provider_sync_state SET generation_epoch = generation_epoch + 1
          WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint; END`,
    },
  ])("rolls back a $name abort write and staged-cache deletion as corrupt", ({ trigger }) => {
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, {
      now: () => 100,
      tokenFactory: () => "owner-abort-trigger",
    });
    const { scope } = registerScope(store);
    const stage = store.beginStage(scope);
    seedCache(db, scope, stage.generation, "staged-trigger-task");
    const before = rawSync(db, scope);
    db.exec(trigger);

    expectStoreError(() => store.abortStage(stage), "CORRUPT_ROW");
    expect(rawSync(db, scope)).toEqual(before);
    expect(cacheIds(db, scope)).toEqual(["staged-trigger-task"]);
  });
});
