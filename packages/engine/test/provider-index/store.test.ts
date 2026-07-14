import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../../src/migrations.js";
import {
  homeFingerprint,
  taskLocator,
  type ProviderTaskLocator,
} from "../../src/provider-index/identity.js";
import {
  ProviderTaskIndexStore,
} from "../../src/provider-index/store.js";
import {
  ProviderIndexStoreError,
  type ProviderReconciliationReason,
} from "../../src/provider-index/store-types.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";
import type { ProviderId } from "../../src/providers/types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const PRE_PROVIDER_INDEX_SCHEMA_VERSION = 13;
const REVIEWED_FINGERPRINT = `openai:v1:${"a".repeat(64)}`;
const NATIVE_FINGERPRINT = `openai:v1:${"b".repeat(64)}`;
const RECONCILIATION_REASON: ProviderReconciliationReason = "NATIVE_REVISION_MISMATCH";

const databases: TestDatabase[] = [];
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "devhub-provider-store-"));
  directories.push(directory);
  return realpathSync(directory);
}

function openDatabase(file = ":memory:"): TestDatabase {
  const db = new DatabaseSync(file);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);
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
    // Tests intentionally exercise closed connections.
  }
}

function expectStoreError(
  operation: () => unknown,
  code: ProviderIndexStoreError["code"],
): ProviderIndexStoreError {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ProviderIndexStoreError);
  expect(thrown).toMatchObject({ code });
  return thrown as ProviderIndexStoreError;
}

function register(
  store: ProviderTaskIndexStore,
  provider: ProviderId,
  home: string,
  registeredAt = 1_000,
) {
  return store.registerHome({ provider, home }, registeredAt);
}

function locator(
  provider: ProviderId,
  home: string,
  nativeTaskId: string,
): ProviderTaskLocator {
  return taskLocator(createNativeTaskKey(provider, home, nativeTaskId));
}

function queuedClock(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("unexpected clock call");
    index += 1;
    return value;
  };
}

function rawReconciliationRow(
  db: TestDatabase,
  target: ProviderTaskLocator,
): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM provider_reconciliation_state
    WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?`)
    .get(target.provider, target.homeFingerprint, target.nativeTaskId) as
      Record<string, unknown> | undefined;
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProviderTaskIndexStore home registry", () => {
  it("registers an exact canonical home and preserves the original timestamp idempotently", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);

    const first = register(store, "openai", home, 1_000);
    const repeated = register(store, "openai", home, 9_999);

    expect(first).toEqual({
      provider: "openai",
      homeFingerprint: homeFingerprint("openai", home),
      registeredAt: 1_000,
    });
    expect(repeated).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(["homeFingerprint", "provider", "registeredAt"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(home);
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_homes").get()).toEqual({ count: 1 });

    expectStoreError(
      () => store.registerHome({ provider: "openai", home: `${home}${path.sep}.` }, 2_000),
      "INVALID_INPUT",
    );
  });

  it("finishes registration canonicalization before the owned transaction begins", async () => {
    const home = tempDirectory();
    const conflictingHome = tempDirectory();
    const otherHome = tempDirectory();
    const db = openDatabase();
    const transactionStates: boolean[] = [];
    vi.resetModules();
    const actualTaskKey = await vi.importActual<typeof import("../../src/providers/task-key.js")>(
      "../../src/providers/task-key.js",
    );
    vi.doMock("../../src/providers/task-key.js", () => ({
      ...actualTaskKey,
      canonicalizeProviderHome: (value: string) => {
        transactionStates.push(db.isTransaction);
        return actualTaskKey.canonicalizeProviderHome(value);
      },
    }));

    try {
      const { ProviderTaskIndexStore: InstrumentedStore } = await import(
        "../../src/provider-index/store.js"
      );
      const store = new InstrumentedStore(db);
      store.registerHome({ provider: "openai", home }, 1);
      store.registerHome({ provider: "openai", home }, 2);
      db.prepare(`INSERT INTO provider_homes
        (provider, home_fingerprint, canonical_home, registered_at)
        VALUES (?, ?, ?, ?)`)
        .run("openai", homeFingerprint("openai", otherHome), conflictingHome, 1);
      let conflict: unknown;
      try {
        store.registerHome({ provider: "openai", home: conflictingHome }, 3);
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toMatchObject({ code: "HOME_CONFLICT" });
      expect(transactionStates).toEqual([false, false, false]);
    } finally {
      vi.doUnmock("../../src/providers/task-key.js");
      vi.resetModules();
    }
  });

  it("isolates the same canonical home by provider", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);

    const openai = register(store, "openai", home, 10);
    const anthropic = register(store, "anthropic", home, 20);

    expect(openai.homeFingerprint).not.toBe(anthropic.homeFingerprint);
    expect(store.resolveHome("openai", openai.homeFingerprint)).toBe(home);
    expect(store.resolveHome("anthropic", anthropic.homeFingerprint)).toBe(home);
  });

  it("rejects both fingerprint-to-home and home-to-fingerprint conflicts", () => {
    const homeA = tempDirectory();
    const homeB = tempDirectory();

    const fingerprintConflictDb = openDatabase();
    fingerprintConflictDb.prepare(`INSERT INTO provider_homes
      (provider, home_fingerprint, canonical_home, registered_at)
      VALUES (?, ?, ?, ?)`)
      .run("openai", homeFingerprint("openai", homeA), homeB, 1);
    const fingerprintConflictStore = new ProviderTaskIndexStore(fingerprintConflictDb);
    expectStoreError(
      () => register(fingerprintConflictStore, "openai", homeA),
      "HOME_CONFLICT",
    );

    const homeConflictDb = openDatabase();
    homeConflictDb.prepare(`INSERT INTO provider_homes
      (provider, home_fingerprint, canonical_home, registered_at)
      VALUES (?, ?, ?, ?)`)
      .run("openai", homeFingerprint("openai", homeB), homeA, 1);
    const homeConflictStore = new ProviderTaskIndexStore(homeConflictDb);
    expectStoreError(
      () => register(homeConflictStore, "openai", homeA),
      "HOME_CONFLICT",
    );
  });

  it("rejects accessors, proxies, revoked proxies, symbols, and extra keys without invoking code", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    let getterCalls = 0;
    const accessor = Object.defineProperty({ provider: "openai" }, "home", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return home;
      },
    });
    expectStoreError(() => store.registerHome(accessor as never, 1), "INVALID_INPUT");
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const proxy = new Proxy({ provider: "openai", home }, {
      getPrototypeOf: () => {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        trapCalls += 1;
        return ["provider", "home"];
      },
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        return undefined;
      },
    });
    expectStoreError(() => store.registerHome(proxy, 1), "INVALID_INPUT");
    expect(trapCalls).toBe(0);

    const revoked = Proxy.revocable({ provider: "openai", home }, {});
    revoked.revoke();
    expectStoreError(() => store.registerHome(revoked.proxy, 1), "INVALID_INPUT");

    expectStoreError(
      () => store.registerHome({ provider: "openai", home, extra: true } as never, 1),
      "INVALID_INPUT",
    );
    const withSymbol = { provider: "openai", home } as Record<PropertyKey, unknown>;
    withSymbol[Symbol("hidden")] = true;
    expectStoreError(() => store.registerHome(withSymbol as never, 1), "INVALID_INPUT");
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_homes").get()).toEqual({ count: 0 });
  });

  it("validates provider and timestamp bounds without SQLite coercion", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);

    for (const registeredAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expectStoreError(
        () => store.registerHome({ provider: "openai", home }, registeredAt as never),
        "INVALID_INPUT",
      );
    }
    expectStoreError(
      () => store.registerHome({ provider: "unknown", home } as never, 1),
      "INVALID_INPUT",
    );
    expect(register(store, "openai", home, Number.MAX_SAFE_INTEGER).registeredAt)
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it("resolves only validated registered homes and returns null for valid unknown fingerprints", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    const registration = register(store, "openai", home);

    expect(store.resolveHome("openai", registration.homeFingerprint)).toBe(home);
    expect(store.resolveHome("anthropic", registration.homeFingerprint)).toBeNull();
    expect(store.resolveHome("openai", "f".repeat(64))).toBeNull();
    for (const invalid of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "../home"] as const) {
      expectStoreError(() => store.resolveHome("openai", invalid), "INVALID_INPUT");
    }
    expectStoreError(() => store.resolveHome("other" as never, registration.homeFingerprint), "INVALID_INPUT");
  });

  it("returns stable value-free errors", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    register(store, "openai", home);

    const error = expectStoreError(
      () => store.registerHome({ provider: "openai", home, leaked: home } as never, 1),
      "INVALID_INPUT",
    );
    expect(error.message).toBe("provider index store input is invalid");
    expect(error.message).not.toContain(home);
  });
});

describe("ProviderTaskIndexStore durable reconciliation", () => {
  it("returns a frozen path-free missing state for a known home", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    const registration = register(store, "openai", home);
    const target = locator("openai", home, "task-1");

    const state = store.getReconciliation(target);

    expect(state).toEqual({
      locator: target,
      required: false,
      latchRevision: 0,
      reviewedFingerprint: null,
      nativeFingerprint: null,
      writerEpoch: 0,
      reason: null,
      updatedAt: null,
    });
    expect(target.homeFingerprint).toBe(registration.homeFingerprint);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.locator)).toBe(true);
    expect(JSON.stringify(state)).not.toContain(home);
  });

  it("rejects an unknown home across get, require, and acknowledge", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    register(store, "openai", home);
    const unknown = Object.freeze({
      ...locator("openai", home, "task-unknown-home"),
      homeFingerprint: "f".repeat(64),
    });

    expectStoreError(() => store.getReconciliation(unknown), "UNKNOWN_HOME");
    expectStoreError(
      () => store.requireReconciliation(unknown, {
        reviewedFingerprint: null,
        nativeFingerprint: null,
        writerEpoch: 0,
        reason: "NATIVE_TASK_MISSING",
      }),
      "UNKNOWN_HOME",
    );
    expectStoreError(
      () => store.acknowledgeReconciliation(
        unknown,
        0,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
      ),
      "UNKNOWN_HOME",
    );
  });

  it("creates the initial latch and increments every repeated relatch", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, { now: queuedClock(100, 101) });
    register(store, "openai", home);
    const target = locator("openai", home, "task-relatch");
    const input = {
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: NATIVE_FINGERPRINT,
      writerEpoch: 7,
      reason: RECONCILIATION_REASON,
    } as const;

    expect(store.requireReconciliation(target, input)).toBeUndefined();
    expect(store.getReconciliation(target)).toMatchObject({
      required: true,
      latchRevision: 1,
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: NATIVE_FINGERPRINT,
      writerEpoch: 7,
      reason: RECONCILIATION_REASON,
      updatedAt: 100,
    });

    store.requireReconciliation(target, input);
    const repeated = store.getReconciliation(target);
    expect(repeated).toMatchObject({
      required: true,
      latchRevision: 2,
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: NATIVE_FINGERPRINT,
      writerEpoch: 7,
      reason: RECONCILIATION_REASON,
      updatedAt: 101,
    });
    expect(Object.isFrozen(repeated)).toBe(true);
    expect(Object.isFrozen(repeated.locator)).toBe(true);
    expect(JSON.stringify(repeated)).not.toContain(home);
  });

  it("snapshots every reconciliation input before one pre-BEGIN clock sample", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const mutableLocator = { ...locator("openai", home, "task-snapshot") };
    const mutableInput: {
      reviewedFingerprint: string | null;
      nativeFingerprint: string | null;
      writerEpoch: number;
      reason: ProviderReconciliationReason;
    } = {
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: NATIVE_FINGERPRINT,
      writerEpoch: 3,
      reason: "NATIVE_REVISION_MISMATCH",
    };
    let clockCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        clockCalls += 1;
        expect(db.isTransaction).toBe(false);
        mutableLocator.nativeTaskId = "task-mutated-by-clock";
        mutableInput.reviewedFingerprint = null;
        mutableInput.nativeFingerprint = null;
        mutableInput.writerEpoch = 99;
        mutableInput.reason = "NATIVE_TASK_MISSING";
        return 500;
      },
    });
    register(store, "openai", home);

    store.requireReconciliation(mutableLocator, mutableInput);

    expect(clockCalls).toBe(1);
    expect(store.getReconciliation(locator("openai", home, "task-snapshot"))).toMatchObject({
      required: true,
      latchRevision: 1,
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: NATIVE_FINGERPRINT,
      writerEpoch: 3,
      reason: "NATIVE_REVISION_MISMATCH",
      updatedAt: 500,
    });
    expect(store.getReconciliation(locator("openai", home, "task-mutated-by-clock")).required)
      .toBe(false);
  });

  it("refuses a require when another connection deletes the home during the clock", () => {
    const root = tempDirectory();
    const databaseFile = path.join(root, "require-home-race.db");
    const home = tempDirectory();
    const db = openDatabase(databaseFile);
    const deleter = reopenDatabase(databaseFile);
    let registration: ReturnType<ProviderTaskIndexStore["registerHome"]>;
    let clockCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        clockCalls += 1;
        const deleted = deleter.prepare(`DELETE FROM provider_homes
          WHERE provider = ? AND home_fingerprint = ?`)
          .run(registration.provider, registration.homeFingerprint);
        expect(Number(deleted.changes)).toBe(1);
        return 600;
      },
    });
    registration = register(store, "openai", home);
    const target = locator("openai", home, "task-require-home-race");

    const error = expectStoreError(
      () => store.requireReconciliation(target, {
        reviewedFingerprint: null,
        nativeFingerprint: NATIVE_FINGERPRINT,
        writerEpoch: 1,
        reason: "NATIVE_TASK_MISSING",
      }),
      "UNKNOWN_HOME",
    );

    expect(clockCalls).toBe(1);
    expect(error.message).toBe("provider index home is unknown");
    expect(error.message).not.toContain(home);
    expect(rawReconciliationRow(db, target)).toBeUndefined();
  });

  it("refuses an acknowledgement when another connection deletes the home during the clock", () => {
    const root = tempDirectory();
    const databaseFile = path.join(root, "ack-home-race.db");
    const home = tempDirectory();
    const db = openDatabase(databaseFile);
    const deleter = reopenDatabase(databaseFile);
    let registration: ReturnType<ProviderTaskIndexStore["registerHome"]>;
    let deleteOnClock = false;
    let clockCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        clockCalls += 1;
        if (deleteOnClock) {
          const deleted = deleter.prepare(`DELETE FROM provider_homes
            WHERE provider = ? AND home_fingerprint = ?`)
            .run(registration.provider, registration.homeFingerprint);
          expect(Number(deleted.changes)).toBe(1);
        }
        return deleteOnClock ? 800 : 700;
      },
    });
    registration = register(store, "openai", home);
    const target = locator("openai", home, "task-ack-home-race");
    store.requireReconciliation(target, {
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: REVIEWED_FINGERPRINT,
      writerEpoch: 2,
      reason: "MUTATION_OUTCOME_UNCERTAIN",
    });
    const before = rawReconciliationRow(db, target);
    deleteOnClock = true;

    const error = expectStoreError(
      () => store.acknowledgeReconciliation(
        target,
        1,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
      ),
      "UNKNOWN_HOME",
    );

    expect(clockCalls).toBe(2);
    expect(error.message).toBe("provider index home is unknown");
    expect(error.message).not.toContain(home);
    expect(rawReconciliationRow(db, target)).toEqual(before);
  });

  it("persists latches across restart and isolates provider, home, and task scopes", () => {
    const root = tempDirectory();
    const databaseFile = path.join(root, "provider-index.db");
    const homeA = tempDirectory();
    const homeB = tempDirectory();
    const db = openDatabase(databaseFile);
    const store = new ProviderTaskIndexStore(db, { now: queuedClock(1_000) });
    register(store, "openai", homeA);
    register(store, "openai", homeB);
    register(store, "anthropic", homeA);
    const latched = locator("openai", homeA, "task-a");
    store.requireReconciliation(latched, {
      reviewedFingerprint: null,
      nativeFingerprint: NATIVE_FINGERPRINT,
      writerEpoch: 4,
      reason: "PROCESS_GENERATION_CHANGED",
    });

    expect(store.getReconciliation(locator("openai", homeA, "task-b")).required).toBe(false);
    expect(store.getReconciliation(locator("openai", homeB, "task-a")).required).toBe(false);
    expect(store.getReconciliation(locator("anthropic", homeA, "task-a")).required).toBe(false);
    closeDatabase(db);

    const reopened = reopenDatabase(databaseFile);
    const restored = new ProviderTaskIndexStore(reopened).getReconciliation(latched);
    expect(restored).toMatchObject({
      required: true,
      latchRevision: 1,
      reviewedFingerprint: null,
      nativeFingerprint: NATIVE_FINGERPRINT,
      writerEpoch: 4,
      reason: "PROCESS_GENERATION_CHANGED",
      updatedAt: 1_000,
    });
  });

  it("rolls back a latch revision overflow without changing any field", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, { now: queuedClock(2_000) });
    const registration = register(store, "openai", home);
    const target = locator("openai", home, "task-capacity");
    db.prepare(`INSERT INTO provider_reconciliation_state (
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(
        "openai",
        registration.homeFingerprint,
        target.nativeTaskId,
        Number.MAX_SAFE_INTEGER,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
        9,
        "REPLAY_CONFLICT",
        1_000,
      );
    const before = rawReconciliationRow(db, target);

    expectStoreError(
      () => store.requireReconciliation(target, {
        reviewedFingerprint: null,
        nativeFingerprint: NATIVE_FINGERPRINT,
        writerEpoch: 10,
        reason: "WRITER_LEASE_LOST",
      }),
      "CAPACITY",
    );
    expect(rawReconciliationRow(db, target)).toEqual(before);
  });

  it("acknowledges only the exact current latch and preserves monotonic fields", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, { now: queuedClock(100, 200, 300) });
    register(store, "openai", home);
    const target = locator("openai", home, "task-ack");
    store.requireReconciliation(target, {
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: REVIEWED_FINGERPRINT,
      writerEpoch: 12,
      reason: "MUTATION_OUTCOME_UNCERTAIN",
    });

    const acknowledged = store.acknowledgeReconciliation(
      target,
      1,
      REVIEWED_FINGERPRINT,
      REVIEWED_FINGERPRINT,
    );

    expect(acknowledged).toEqual({
      locator: target,
      required: false,
      latchRevision: 1,
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: REVIEWED_FINGERPRINT,
      writerEpoch: 12,
      reason: null,
      updatedAt: 200,
    });
    expect(Object.isFrozen(acknowledged)).toBe(true);
    expect(Object.isFrozen(acknowledged.locator)).toBe(true);
    expect(store.getReconciliation(target)).toEqual(acknowledged);
    const persisted = rawReconciliationRow(db, target);
    expectStoreError(
      () => store.acknowledgeReconciliation(
        target,
        1,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
      ),
      "RECONCILIATION_CAS_MISMATCH",
    );
    expect(rawReconciliationRow(db, target)).toEqual(persisted);
  });

  it("refuses missing, stale, mismatched, and supplied-unequal acknowledgements without writes", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, {
      now: queuedClock(10, 11, 12, 13, 14, 15),
    });
    register(store, "openai", home);
    const missing = locator("openai", home, "task-missing");
    expectStoreError(
      () => store.acknowledgeReconciliation(
        missing,
        1,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
      ),
      "RECONCILIATION_CAS_MISMATCH",
    );
    expect(rawReconciliationRow(db, missing)).toBeUndefined();

    const target = locator("openai", home, "task-cas");
    store.requireReconciliation(target, {
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: NATIVE_FINGERPRINT,
      writerEpoch: 1,
      reason: "NATIVE_REVISION_MISMATCH",
    });
    const initial = rawReconciliationRow(db, target);
    expectStoreError(
      () => store.acknowledgeReconciliation(
        target,
        0,
        REVIEWED_FINGERPRINT,
        NATIVE_FINGERPRINT,
      ),
      "RECONCILIATION_CAS_MISMATCH",
    );
    expect(rawReconciliationRow(db, target)).toEqual(initial);

    expectStoreError(
      () => store.acknowledgeReconciliation(
        target,
        1,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
      ),
      "RECONCILIATION_CAS_MISMATCH",
    );
    expect(rawReconciliationRow(db, target)).toEqual(initial);

    expectStoreError(
      () => store.acknowledgeReconciliation(
        target,
        1,
        REVIEWED_FINGERPRINT,
        NATIVE_FINGERPRINT,
      ),
      "RECONCILIATION_CAS_MISMATCH",
    );
    expect(rawReconciliationRow(db, target)).toEqual(initial);
  });

  it("does not clear a newer same-fingerprint relatch", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db, { now: queuedClock(10, 11, 12) });
    register(store, "openai", home);
    const target = locator("openai", home, "task-aba");
    const input = {
      reviewedFingerprint: REVIEWED_FINGERPRINT,
      nativeFingerprint: REVIEWED_FINGERPRINT,
      writerEpoch: 2,
      reason: "NATIVE_STATE_INVALID",
    } as const;
    store.requireReconciliation(target, input);
    const reviewed = store.getReconciliation(target);
    store.requireReconciliation(target, input);
    const relatched = rawReconciliationRow(db, target);

    expectStoreError(
      () => store.acknowledgeReconciliation(
        target,
        reviewed.latchRevision,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
      ),
      "RECONCILIATION_CAS_MISMATCH",
    );
    expect(rawReconciliationRow(db, target)).toEqual(relatched);
    expect(store.getReconciliation(target)).toMatchObject({ required: true, latchRevision: 2 });
  });

  it("strictly rejects corrupt reconciliation rows", () => {
    const home = tempDirectory();
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    const registration = register(store, "openai", home);
    const target = locator("openai", home, "task-corrupt");
    db.prepare(`INSERT INTO provider_reconciliation_state (
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at
    ) VALUES (?, ?, ?, 1, 1, ?, ?, 1, ?, 1)`)
      .run(
        "openai",
        registration.homeFingerprint,
        target.nativeTaskId,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
        "NOT_A_RECONCILIATION_REASON",
      );

    expectStoreError(() => store.getReconciliation(target), "CORRUPT_ROW");
  });

  it("rejects hostile reconciliation inputs before getters, traps, clocks, or writes", () => {
    const home = tempDirectory();
    const db = openDatabase();
    let clockCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        clockCalls += 1;
        return 1;
      },
    });
    const registration = register(store, "openai", home);
    const target = locator("openai", home, "task-hostile");
    let getterCalls = 0;
    const accessor = Object.defineProperty({
      reviewedFingerprint: null,
      nativeFingerprint: null,
      writerEpoch: 0,
    }, "reason", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "NATIVE_TASK_MISSING";
      },
    });
    expectStoreError(
      () => store.requireReconciliation(target, accessor as never),
      "INVALID_INPUT",
    );
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const proxy = new Proxy({
      reviewedFingerprint: null,
      nativeFingerprint: null,
      writerEpoch: 0,
      reason: "NATIVE_TASK_MISSING" as const,
    }, {
      getPrototypeOf: () => {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        trapCalls += 1;
        return [];
      },
    });
    expectStoreError(() => store.requireReconciliation(target, proxy), "INVALID_INPUT");
    expect(trapCalls).toBe(0);

    const revoked = Proxy.revocable(target, {});
    revoked.revoke();
    expectStoreError(() => store.getReconciliation(revoked.proxy), "INVALID_INPUT");
    expectStoreError(
      () => store.requireReconciliation(target, {
        reviewedFingerprint: `revision:${home}`,
        nativeFingerprint: null,
        writerEpoch: 0,
        reason: "NATIVE_TASK_MISSING",
      }),
      "INVALID_INPUT",
    );
    expectStoreError(
      () => store.requireReconciliation(target, {
        reviewedFingerprint: "sk-proj-12345678901234567890",
        nativeFingerprint: null,
        writerEpoch: 0,
        reason: "NATIVE_TASK_MISSING",
      }),
      "INVALID_INPUT",
    );
    expectStoreError(
      () => store.requireReconciliation(target, {
        reviewedFingerprint: null,
        nativeFingerprint: null,
        writerEpoch: 0,
        reason: "OTHER" as never,
      }),
      "INVALID_INPUT",
    );
    const rawHomeTask = Object.freeze({
      version: 1 as const,
      provider: "openai" as const,
      homeFingerprint: registration.homeFingerprint,
      nativeTaskId: `task:${home}`,
    });
    expectStoreError(() => store.getReconciliation(rawHomeTask), "INVALID_INPUT");
    expect(clockCalls).toBe(0);
    expect(rawReconciliationRow(db, target)).toBeUndefined();
  });

  it("rejects caller-owned transactions before callbacks or changes", () => {
    const home = tempDirectory();
    const otherHome = tempDirectory();
    const db = openDatabase();
    let clockCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        clockCalls += 1;
        return 100;
      },
    });
    register(store, "openai", home);
    const target = locator("openai", home, "task-outer-transaction");
    db.exec("BEGIN");

    expectStoreError(
      () => store.requireReconciliation(target, {
        reviewedFingerprint: null,
        nativeFingerprint: null,
        writerEpoch: 0,
        reason: "NATIVE_TASK_MISSING",
      }),
      "DATABASE_UNAVAILABLE",
    );
    expectStoreError(() => register(store, "openai", otherHome), "DATABASE_UNAVAILABLE");
    expectStoreError(
      () => store.acknowledgeReconciliation(
        target,
        1,
        REVIEWED_FINGERPRINT,
        REVIEWED_FINGERPRINT,
      ),
      "DATABASE_UNAVAILABLE",
    );
    expect(clockCalls).toBe(0);
    expect(rawReconciliationRow(db, target)).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM provider_homes
      WHERE provider = ? AND canonical_home = ?`).get("openai", otherHome))
      .toEqual({ count: 0 });
    db.exec("ROLLBACK");
  });

  it("fails a reentrant clock mutation closed with one clock sample and no write", () => {
    const home = tempDirectory();
    const db = openDatabase();
    let store!: ProviderTaskIndexStore;
    let clockCalls = 0;
    const target = locator("openai", home, "task-reentrant-clock");
    store = new ProviderTaskIndexStore(db, {
      now: () => {
        clockCalls += 1;
        store.requireReconciliation(target, {
          reviewedFingerprint: null,
          nativeFingerprint: null,
          writerEpoch: 0,
          reason: "NATIVE_TASK_MISSING",
        });
        return 1;
      },
    });
    register(store, "openai", home);

    expectStoreError(
      () => store.requireReconciliation(target, {
        reviewedFingerprint: null,
        nativeFingerprint: null,
        writerEpoch: 0,
        reason: "PROCESS_GENERATION_CHANGED",
      }),
      "CLOCK_FAILURE",
    );
    expect(clockCalls).toBe(1);
    expect(rawReconciliationRow(db, target)).toBeUndefined();
  });

  it("maps closed, busy, and SQLite failures to value-free database errors", () => {
    const closedHome = tempDirectory();
    const closedDb = openDatabase();
    const closedStore = new ProviderTaskIndexStore(closedDb);
    const closedRegistration = register(closedStore, "openai", closedHome);
    const closedTarget = locator("openai", closedHome, "task-closed");
    closeDatabase(closedDb);
    expectStoreError(
      () => closedStore.resolveHome("openai", closedRegistration.homeFingerprint),
      "DATABASE_UNAVAILABLE",
    );
    expectStoreError(() => closedStore.getReconciliation(closedTarget), "DATABASE_UNAVAILABLE");
    expectStoreError(
      () => closedStore.requireReconciliation(closedTarget, {
        reviewedFingerprint: null,
        nativeFingerprint: null,
        writerEpoch: 0,
        reason: "NATIVE_TASK_MISSING",
      }),
      "DATABASE_UNAVAILABLE",
    );

    const root = tempDirectory();
    const file = path.join(root, "busy.db");
    const busyHome = tempDirectory();
    const ownerDb = openDatabase(file);
    const ownerStore = new ProviderTaskIndexStore(ownerDb);
    register(ownerStore, "openai", busyHome);
    const contenderDb = reopenDatabase(file);
    contenderDb.exec("PRAGMA busy_timeout = 1");
    const contenderStore = new ProviderTaskIndexStore(contenderDb, { now: queuedClock(1) });
    const busyTarget = locator("openai", busyHome, "task-busy");
    ownerDb.exec("BEGIN IMMEDIATE");
    const busyError = expectStoreError(
      () => contenderStore.requireReconciliation(busyTarget, {
        reviewedFingerprint: null,
        nativeFingerprint: null,
        writerEpoch: 0,
        reason: "WRITER_LEASE_LOST",
      }),
      "DATABASE_UNAVAILABLE",
    );
    expect(busyError.message).toBe("provider index database is unavailable");
    expect(busyError.message).not.toContain(busyHome);
    ownerDb.exec("ROLLBACK");
    expect(rawReconciliationRow(contenderDb, busyTarget)).toBeUndefined();

    const sqliteHome = tempDirectory();
    const sqliteDb = openDatabase();
    const sqliteStore = new ProviderTaskIndexStore(sqliteDb);
    sqliteDb.exec(`CREATE TRIGGER provider_home_failure
      BEFORE INSERT ON provider_homes
      BEGIN SELECT RAISE(ABORT, '${sqliteHome.replaceAll("'", "''")}'); END;`);
    const sqliteError = expectStoreError(
      () => register(sqliteStore, "openai", sqliteHome),
      "DATABASE_UNAVAILABLE",
    );
    expect(sqliteError.message).toBe("provider index database is unavailable");
    expect(sqliteError.message).not.toContain(sqliteHome);
    expect(sqliteDb.prepare("SELECT COUNT(*) AS count FROM provider_homes").get())
      .toEqual({ count: 0 });

    const readHome = tempDirectory();
    const readDb = openDatabase();
    const readStore = new ProviderTaskIndexStore(readDb);
    register(readStore, "openai", readHome);
    const readTarget = locator("openai", readHome, "task-read-failure");
    readDb.exec("DROP TABLE provider_reconciliation_state");
    const readError = expectStoreError(
      () => readStore.getReconciliation(readTarget),
      "DATABASE_UNAVAILABLE",
    );
    expect(readError.message).toBe("provider index database is unavailable");
    expect(readError.message).not.toContain(readHome);
  });
});
