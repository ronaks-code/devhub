import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../src/migrations.js";
import type { ProviderTaskLocator } from "../../src/provider-index/identity.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const PRE_PROVIDER_INDEX_SCHEMA_VERSION = 13;

function openDatabase(): TestDatabase {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);
  runMigrations(db);
  return db;
}

function locator(nativeTaskId: string, homeFingerprint = "1".repeat(64)): ProviderTaskLocator {
  return Object.freeze({
    version: 1,
    provider: "openai",
    homeFingerprint,
    nativeTaskId,
  });
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

describe("ProviderTaskIndexStore local-state facade", () => {
  it("reads and patches orphan metadata through caller transactions with one late clock sample", () => {
    const db = openDatabase();
    const target = locator("orphan-meta");
    let clockCalls = 0;
    const execSpy = vi.spyOn(db, "exec");
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        clockCalls += 1;
        expect(execSpy.mock.calls.some(([sql]) => String(sql).startsWith("SAVEPOINT "))).toBe(false);
        return 101;
      },
    });

    expect(store.getMeta(target)).toMatchObject({ locator: target, favorite: false, updatedAt: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_task_meta").get())
      .toEqual({ count: 0 });

    db.exec("BEGIN");
    const patched = store.patchMeta(target, {
      favorite: true,
      tags: ["one", "two"],
      uiState: { panel: { width: 320 } },
    });
    expect(patched).toMatchObject({ locator: target, favorite: true, updatedAt: 101 });
    expect(Object.isFrozen(patched)).toBe(true);
    expect(Object.isFrozen(patched.tags)).toBe(true);
    expect(Object.isFrozen(patched.uiState)).toBe(true);
    db.exec("ROLLBACK");

    expect(clockCalls).toBe(1);
    expect(store.getMeta(target).favorite).toBe(false);
    execSpy.mockRestore();
    db.close();
  });

  it("rejects an invalid patch before sampling the clock or opening a savepoint", () => {
    const db = openDatabase();
    let clockCalls = 0;
    const store = new ProviderTaskIndexStore(db, {
      now: () => {
        clockCalls += 1;
        return 1;
      },
    });
    let getterCalls = 0;
    const patch = Object.defineProperty({}, "favorite", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return true;
      },
    });

    expectStoreError(() => store.patchMeta(locator("invalid-patch"), patch), "INVALID_INPUT");
    expect(getterCalls).toBe(0);
    expect(clockCalls).toBe(0);
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it("links, lists, and classifies orphan local state inside a caller transaction", () => {
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    const source = locator("fork-source");
    const target = locator("fork-target", "2".repeat(64));
    const digest = "a".repeat(64);

    db.exec("BEGIN");
    const link = store.linkFork(source, target, digest, 42);
    store.classifyLegacySession("legacy-orphan", "archive-v1-import", 43);
    expect(link).toEqual({ source, target, createdAt: 42, transferDigest: digest });
    expect(Object.isFrozen(link)).toBe(true);
    const listed = store.listForkLinks(source);
    expect(listed).toEqual([link]);
    expect(Object.isFrozen(listed)).toBe(true);
    db.exec("ROLLBACK");

    expect(store.listForkLinks(source)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_provenance").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("maps a verified legacy session only under exact registered authority", () => {
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    const registration = store.registerHome({ provider: "openai", home: realpathSync("/tmp") }, 5);
    const target = locator("mapped-task", registration.homeFingerprint);
    const evidence = {
      mappingSource: "live-provider-observation" as const,
      verifiedAt: 9,
    };

    db.exec("BEGIN");
    store.mapVerifiedLegacySession("legacy-rolled-back", target, evidence);
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_task_map").get())
      .toEqual({ count: 0 });

    store.mapVerifiedLegacySession("legacy-mapped", target, evidence);
    store.mapVerifiedLegacySession("legacy-mapped", target, {
      ...evidence,
      verifiedAt: 99,
    });
    expect(db.prepare("SELECT * FROM legacy_session_task_map").all()).toEqual([{
      legacy_session_id: "legacy-mapped",
      provider: "openai",
      home_fingerprint: registration.homeFingerprint,
      native_task_id: "mapped-task",
      mapping_source: "live-provider-observation",
      verified_at: 9,
    }]);

    expectStoreError(
      () => store.mapVerifiedLegacySession("legacy-missing", locator("missing-home"), evidence),
      "UNKNOWN_HOME",
    );
    db.close();
  });

  it("rolls back mapping if a trigger changes the registered authority", () => {
    const db = openDatabase();
    const store = new ProviderTaskIndexStore(db);
    const registration = store.registerHome({ provider: "openai", home: realpathSync("/tmp") }, 10);
    const target = locator("mapping-drift", registration.homeFingerprint);
    db.exec(`CREATE TRIGGER drift_mapping_authority
      AFTER INSERT ON legacy_session_task_map
      BEGIN
        UPDATE provider_homes SET registered_at = registered_at + 1
        WHERE provider = NEW.provider AND home_fingerprint = NEW.home_fingerprint;
      END`);

    const error = expectStoreError(() => store.mapVerifiedLegacySession(
      "legacy-drift",
      target,
      { mappingSource: "live-provider-observation", verifiedAt: 11 },
    ), "CORRUPT_ROW");
    expect(error.message).not.toContain(registration.homeFingerprint);
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_task_map").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT registered_at FROM provider_homes
      WHERE provider = 'openai' AND home_fingerprint = ?`).get(registration.homeFingerprint))
      .toEqual({ registered_at: 10 });
    db.close();
  });

  it.each(["rewrite", "delete"] as const)(
    "classifies a post-preflight authority %s as corruption",
    (interposition) => {
      const db = openDatabase();
      const store = new ProviderTaskIndexStore(db);
      const registration = store.registerHome({
        provider: "openai",
        home: realpathSync("/tmp"),
      }, 20);
      const target = locator(`mapping-${interposition}`, registration.homeFingerprint);
      const originalExec = db.exec.bind(db);
      let interposed = false;
      const execSpy = vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (!interposed && String(sql).startsWith("SAVEPOINT ")) {
          interposed = true;
          if (interposition === "rewrite") {
            db.prepare(`UPDATE provider_homes SET registered_at = registered_at + 1
              WHERE provider = ? AND home_fingerprint = ?`)
              .run(target.provider, target.homeFingerprint);
          } else {
            db.prepare(`DELETE FROM provider_homes
              WHERE provider = ? AND home_fingerprint = ?`)
              .run(target.provider, target.homeFingerprint);
          }
        }
        return originalExec(sql);
      });

      expectStoreError(() => store.mapVerifiedLegacySession(
        `legacy-${interposition}`,
        target,
        { mappingSource: "live-provider-observation", verifiedAt: 21 },
      ), "CORRUPT_ROW");
      expect(interposed).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_task_map").get())
        .toEqual({ count: 0 });
      expect(db.prepare(`SELECT registered_at FROM provider_homes
        WHERE provider = ? AND home_fingerprint = ?`)
        .get(target.provider, target.homeFingerprint))
        .toEqual(interposition === "rewrite" ? { registered_at: 21 } : undefined);

      execSpy.mockRestore();
      db.close();
    },
  );

  it("shares the mutation guard across store instances without leaking inner state", () => {
    const db = openDatabase();
    let innerCode: ProviderIndexStoreError["code"] | null = null;
    let second!: ProviderTaskIndexStore;
    const first = new ProviderTaskIndexStore(db, {
      now: () => {
        try {
          second.classifyLegacySession("reentrant", "missing", 1);
        } catch (error) {
          innerCode = (error as ProviderIndexStoreError).code;
        }
        return 77;
      },
    });
    second = new ProviderTaskIndexStore(db);

    expect(first.patchMeta(locator("guarded"), { pinned: true }).updatedAt).toBe(77);
    expect(innerCode).toBe("DATABASE_UNAVAILABLE");
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_provenance").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("maps only tagged foundation failures to stable value-free store errors", () => {
    const db = openDatabase();
    const target = locator("corrupt-meta");
    db.prepare(`INSERT INTO provider_task_meta (
      provider, home_fingerprint, native_task_id, favorite, pinned, local_label,
      tags_json, notes, local_archived, ui_state_json, unsupported_local_json, updated_at
    ) VALUES (?, ?, ?, 0, 0, NULL, '["duplicate","duplicate"]', NULL, 0, '{}', '{}', 1)`)
      .run(target.provider, target.homeFingerprint, target.nativeTaskId);
    const store = new ProviderTaskIndexStore(db);

    const corrupt = expectStoreError(() => store.getMeta(target), "CORRUPT_ROW");
    expect(corrupt.message).not.toContain(target.nativeTaskId);
    db.close();

    expectStoreError(() => store.getMeta(locator("closed-db")), "DATABASE_UNAVAILABLE");
  });
});
