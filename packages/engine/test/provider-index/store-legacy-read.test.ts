import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrations.js";
import {
  homeFingerprint,
  type ProviderTaskLocator,
} from "../../src/provider-index/identity.js";
import * as localState from "../../src/provider-index/store-local-state.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const HOME_FINGERPRINT = "1".repeat(64);

interface Resolution {
  readonly sessionId: string;
  readonly locator: ProviderTaskLocator;
  readonly mappingSource: "live-provider-observation";
  readonly verifiedAt: number;
}

type ReadPrimitive = (db: TestDatabase, sessionId: string) => Readonly<Resolution> | null;
type ReadFacade = (sessionId: string) => Readonly<Resolution> | null;

function openDatabase(): TestDatabase {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA user_version = 13");
  runMigrations(db);
  return db;
}

function readPrimitive(db: TestDatabase, sessionId: string): Readonly<Resolution> | null {
  const read = (localState as unknown as {
    readVerifiedLegacySessionMapping?: ReadPrimitive;
  }).readVerifiedLegacySessionMapping;
  expect(read).toBeTypeOf("function");
  return read!(db, sessionId);
}

function readFacade(store: ProviderTaskIndexStore, sessionId: string): Readonly<Resolution> | null {
  const read = (store as unknown as {
    getVerifiedLegacySessionMapping?: ReadFacade;
  }).getVerifiedLegacySessionMapping;
  expect(read).toBeTypeOf("function");
  return read!.call(store, sessionId);
}

function insertMapping(
  db: TestDatabase,
  sessionId: string,
  nativeTaskId: string,
  verifiedAt = 7,
  homeFingerprintValue = HOME_FINGERPRINT,
): void {
  db.prepare(`INSERT INTO legacy_session_task_map (
    legacy_session_id, provider, home_fingerprint, native_task_id,
    mapping_source, verified_at
  ) VALUES (?, 'openai', ?, ?, 'live-provider-observation', ?)`)
    .run(sessionId, homeFingerprintValue, nativeTaskId, verifiedAt);
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

describe("verified legacy mapping lookup", () => {
  it("returns null for missing and provenance-only identities without inferring authority", () => {
    const db = openDatabase();
    db.prepare(`INSERT INTO legacy_session_provenance
      (legacy_session_id, provenance, observed_at) VALUES (?, 'archive-v1-import', 1)`)
      .run("legacy-provenance-only");

    expect(readPrimitive(db, "legacy-missing")).toBeNull();
    expect(readPrimitive(db, "legacy-provenance-only")).toBeNull();
    db.close();
  });

  it("returns one frozen path-free mapping even when provenance coexists and the home is orphaned", () => {
    const db = openDatabase();
    insertMapping(db, "legacy-mapped", "folder/任务-🪐", 9);
    db.prepare(`INSERT INTO legacy_session_provenance
      (legacy_session_id, provenance, observed_at) VALUES (?, 'foreign-machine', 2)`)
      .run("legacy-mapped");

    const resolution = readPrimitive(db, "legacy-mapped");
    expect(resolution).toEqual({
      sessionId: "legacy-mapped",
      locator: {
        version: 1,
        provider: "openai",
        homeFingerprint: HOME_FINGERPRINT,
        nativeTaskId: "folder/任务-🪐",
      },
      mappingSource: "live-provider-observation",
      verifiedAt: 9,
    });
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution!.locator)).toBe(true);
    expect(JSON.stringify(resolution)).not.toContain("/tmp/");
    db.close();
  });

  it("fails closed for malformed persisted mapping rows", () => {
    const corruptDb = openDatabase();
    insertMapping(corruptDb, "legacy-corrupt", "task-corrupt", 3);
    corruptDb.exec("PRAGMA ignore_check_constraints = ON");
    corruptDb.prepare(`UPDATE legacy_session_task_map SET verified_at = 'bad'
      WHERE legacy_session_id = ?`).run("legacy-corrupt");
    expect(() => readPrimitive(corruptDb, "legacy-corrupt")).toThrow();
    expect(localState.providerLocalStateFailureCode(
      (() => {
        try { readPrimitive(corruptDb, "legacy-corrupt"); } catch (error) { return error; }
        return null;
      })(),
    )).toBe("CORRUPT_ROW");
    corruptDb.close();
  });

  it("accepts valid registered authority but rejects its raw home inside a native task ID", () => {
    const db = openDatabase();
    const canonicalHome = "/tmp/secret-provider-home";
    const fingerprint = homeFingerprint("openai", canonicalHome);
    db.prepare(`INSERT INTO provider_homes
      (provider, home_fingerprint, canonical_home, registered_at)
      VALUES ('openai', ?, ?, 1)`).run(fingerprint, canonicalHome);
    insertMapping(db, "legacy-safe-home", "safe-native-task", 4, fingerprint);
    expect(readPrimitive(db, "legacy-safe-home")).toMatchObject({
      sessionId: "legacy-safe-home",
      locator: { homeFingerprint: fingerprint, nativeTaskId: "safe-native-task" },
    });

    insertMapping(db, "legacy-raw-home", `task-${canonicalHome}`, 5, fingerprint);
    const failure = (() => {
      try { readPrimitive(db, "legacy-raw-home"); } catch (error) { return error; }
      return null;
    })();
    expect(localState.providerLocalStateFailureCode(failure)).toBe("CORRUPT_ROW");
    expect((failure as Error).message).not.toContain(canonicalHome);
    db.close();
  });

  it("rejects a registered-home fingerprint decoy before returning a raw-home-bearing locator", () => {
    const db = openDatabase();
    const actualHome = "/tmp/actual-secret-provider-home";
    const fingerprint = homeFingerprint("openai", actualHome);
    db.prepare(`INSERT INTO provider_homes
      (provider, home_fingerprint, canonical_home, registered_at)
      VALUES ('openai', ?, ?, 1)`).run(fingerprint, actualHome);
    db.prepare(`INSERT INTO legacy_session_task_map (
      legacy_session_id, provider, home_fingerprint, native_task_id,
      mapping_source, verified_at
    ) VALUES (?, 'openai', ?, ?, 'live-provider-observation', 5)`)
      .run("legacy-home-decoy", fingerprint, `task-${actualHome}`);

    db.prepare(`UPDATE provider_homes SET canonical_home = ?
      WHERE provider = 'openai' AND home_fingerprint = ?`)
      .run("/tmp/decoy-provider-home", fingerprint);

    const failure = (() => {
      try { readPrimitive(db, "legacy-home-decoy"); } catch (error) { return error; }
      return null;
    })();
    expect(localState.providerLocalStateFailureCode(failure)).toBe("CORRUPT_ROW");
    expect((failure as Error).message).not.toContain(actualHome);
    db.close();
  });

  it("maps invalid and unavailable reads through the public facade without filesystem or clock work", () => {
    const db = openDatabase();
    let clockCalls = 0;
    const store = new ProviderTaskIndexStore(db, { now: () => { clockCalls += 1; return 1; } });
    insertMapping(db, "legacy-facade", "facade-task", 11);

    expect(readFacade(store, "legacy-facade")).toMatchObject({
      sessionId: "legacy-facade",
      mappingSource: "live-provider-observation",
      verifiedAt: 11,
    });
    expect(readFacade(store, "legacy-missing")).toBeNull();
    expectStoreError(() => readFacade(store, ""), "INVALID_INPUT");
    expect(clockCalls).toBe(0);
    db.close();
    expectStoreError(() => readFacade(store, "legacy-facade"), "DATABASE_UNAVAILABLE");
  });
});
