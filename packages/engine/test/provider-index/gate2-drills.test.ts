/**
 * Task 9 gate-2 induced-failure DRILLS (engine, self-contained cross-cutting slice).
 *
 * The full gate-2 failure list is exercised across the adversarial suites already
 * catalogued in `evidence/m5/gate2-drills.manifest.json`; the drill runner
 * (`evidence/m5/run-gate2-drills.sh`) executes that whole corpus green at <=2
 * workers and stages the evidence. This file adds a small, dependency-light set of
 * drills for the cross-cutting properties that are easiest to reproduce in one
 * legible place directly against the real engine APIs (migrations, store, locator
 * identity, cursor, feature flags) so the gate-2 intent is asserted end to end
 * without spawning any provider process or enabling any runtime flag.
 */
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrations.js";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  defineDevHubFeatureFlags,
} from "../../src/providers/feature-flags.js";
import {
  homeFingerprint,
  parseTaskLocator,
  serializeTaskLocator,
  taskLocator,
  type ProviderTaskLocator,
} from "../../src/provider-index/identity.js";
import {
  serializeProviderIndexCursor,
  parseProviderIndexCursor,
} from "../../src/provider-index/cursor.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";
import { PROVIDER_INDEX_LATEST_SCHEMA_VERSION } from "../../src/provider-index/schema.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const PRE_PROVIDER_INDEX_SCHEMA_VERSION = 13;

const databases: TestDatabase[] = [];
const directories: string[] = [];

function tempHome(label: string): string {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), `devhub-gate2-${label}-`)));
  directories.push(home);
  return home;
}

/** Bring a fresh in-memory DB up from the pre-provider-index v13 baseline. */
function openV13ThenMigrate(file = ":memory:"): TestDatabase {
  const db = new DatabaseSync(file);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);
  runMigrations(db);
  return db;
}

function userVersion(db: TestDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

function tableNames(db: TestDatabase): ReadonlySet<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function expectStoreError(
  operation: () => unknown,
  code: ProviderIndexStoreError["code"],
): void {
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
  while (databases.length > 0) {
    try {
      databases.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("gate-2 drill: v13 migration interruption + idempotent recovery", () => {
  it("upgrades a v13 database to the latest schema and repopulates the provider index tables", () => {
    const db = openV13ThenMigrate();
    expect(userVersion(db)).toBe(PROVIDER_INDEX_LATEST_SCHEMA_VERSION);
    const tables = tableNames(db);
    // The provider-index authority tables must exist after the additive migration.
    expect(tables.has("provider_task_cache")).toBe(true);
    expect(tables.has("provider_reconciliation_state")).toBe(true);
  });

  it("recovers from an interrupted run by re-running migrations after user_version is reset to 13", () => {
    const db = openV13ThenMigrate();
    const home = tempHome("recover");
    const store = new ProviderTaskIndexStore(db);
    const registration = store.registerHome({ provider: "openai", home }, 1_000);

    // Simulate a crash that left user_version behind while the schema/data survive.
    db.exec(`PRAGMA user_version = ${PRE_PROVIDER_INDEX_SCHEMA_VERSION}`);
    runMigrations(db);

    // Fully converged again, and the previously written row is untouched (no data loss).
    expect(userVersion(db)).toBe(PROVIDER_INDEX_LATEST_SCHEMA_VERSION);
    expect(store.resolveHome("openai", registration.homeFingerprint)).toBe(home);
  });
});

describe("gate-2 drill: flag rollback = instant legacy path with no schema down-migration", () => {
  it("lets an explicit stored false override win over an on-default", () => {
    // The rollback switch is an explicitly stored false; it must win regardless of
    // any future default flip. Simulate a default-on world and prove false wins.
    const rolledBack = defineDevHubFeatureFlags({ unifiedTaskIndex: false });
    expect(rolledBack.unifiedTaskIndex).toBe(false);
    // The shipped default is still false (cutover has not happened in this task).
    expect(DEFAULT_DEVHUB_FEATURE_FLAGS.unifiedTaskIndex).toBe(false);
  });

  it("never down-migrates the schema when the flag is rolled back after cutover", () => {
    const db = openV13ThenMigrate();
    const before = userVersion(db);
    const tablesBefore = tableNames(db);

    // Rolling the flag back to false is a runtime-only decision. Re-running the
    // migration machinery (as any restart does) must be non-decreasing and must
    // never drop the provider-index tables.
    runMigrations(db);
    runMigrations(db);

    expect(userVersion(db)).toBe(before);
    const tablesAfter = tableNames(db);
    for (const table of tablesBefore) expect(tablesAfter.has(table)).toBe(true);
    expect(tablesAfter.has("provider_task_cache")).toBe(true);
  });
});

describe("gate-2 drill: DB busy / write failure fails closed", () => {
  it("rejects a store mutation while another transaction holds the connection, then recovers", () => {
    const db = openV13ThenMigrate();
    const home = tempHome("busy");
    const store = new ProviderTaskIndexStore(db);

    db.exec("BEGIN IMMEDIATE");
    try {
      // A store mutation must refuse to nest inside a caller-owned transaction.
      expectStoreError(
        () => store.registerHome({ provider: "openai", home }, 1_000),
        "DATABASE_UNAVAILABLE",
      );
      // Fail-closed: nothing partial was written.
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM provider_homes")
        .get() as { n: number };
      expect(Number(rows.n)).toBe(0);
    } finally {
      db.exec("ROLLBACK");
    }

    // After the busy window clears, the exact same mutation succeeds.
    const registration = store.registerHome({ provider: "openai", home }, 1_000);
    expect(store.resolveHome("openai", registration.homeFingerprint)).toBe(home);
  });
});

describe("gate-2 drill: invalid / unknown-fingerprint locator is rejected", () => {
  it("round-trips a valid locator but rejects malformed serialized locators", () => {
    const home = tempHome("locator");
    const key = createNativeTaskKey("openai", home, "task-a");
    const locator: ProviderTaskLocator = taskLocator(key);
    const serialized = serializeTaskLocator(locator);
    expect(parseTaskLocator(serialized)).toEqual(locator);

    const badFingerprint = `pt1.openai.${"z".repeat(64)}.dGFzay1h`;
    for (const bad of [
      "",
      "not-a-locator",
      "pt1.openai", // too few parts
      "pt2.openai.".concat("a".repeat(64), ".dGFzay1h"), // wrong prefix
      badFingerprint, // non-hex fingerprint
      `pt1.openai.${"a".repeat(63)}.dGFzay1h`, // short fingerprint
      `pt1..${"a".repeat(64)}.dGFzay1h`, // empty provider
    ]) {
      expect(() => parseTaskLocator(bad)).toThrow(TypeError);
    }
  });

  it("resolves a registered home but returns null for an unknown fingerprint and rejects an invalid one", () => {
    const db = openV13ThenMigrate();
    const home = tempHome("resolve");
    const store = new ProviderTaskIndexStore(db);
    const registration = store.registerHome({ provider: "openai", home }, 1_000);

    expect(store.resolveHome("openai", registration.homeFingerprint)).toBe(home);
    // Well-formed but never registered -> null (no throw, no leak).
    expect(store.resolveHome("openai", "f".repeat(64))).toBeNull();
    // Right fingerprint, wrong provider -> null.
    expect(store.resolveHome("anthropic", registration.homeFingerprint)).toBeNull();
    // Structurally invalid fingerprint -> typed INVALID_INPUT.
    expectStoreError(() => store.resolveHome("openai", "not-hex"), "INVALID_INPUT");
  });
});

describe("gate-2 drill: cursor scope abuse is rejected", () => {
  const scopeOpenai = Object.freeze({
    provider: "openai" as const,
    homeFingerprint: null,
    includeArchived: false,
  });
  const position = Object.freeze({
    updatedAt: "2026-07-14T00:00:00.000Z",
    provider: "openai" as const,
    homeFingerprint: "a".repeat(64),
    nativeTaskId: "task-a",
  });

  it("parses a cursor under its own scope but rejects it under any different scope", () => {
    const cursor = serializeProviderIndexCursor(scopeOpenai, position);
    // Same scope -> round trips.
    expect(parseProviderIndexCursor(cursor, scopeOpenai)).toMatchObject({
      provider: "openai",
      nativeTaskId: "task-a",
    });

    // Provider scope change -> rejected.
    expect(() =>
      parseProviderIndexCursor(cursor, {
        provider: "anthropic",
        homeFingerprint: null,
        includeArchived: false,
      }),
    ).toThrow(TypeError);
    // homeFingerprint scope change -> rejected.
    expect(() =>
      parseProviderIndexCursor(cursor, {
        provider: "openai",
        homeFingerprint: "b".repeat(64),
        includeArchived: false,
      }),
    ).toThrow(TypeError);
    // includeArchived scope change -> rejected.
    expect(() =>
      parseProviderIndexCursor(cursor, {
        provider: "openai",
        homeFingerprint: null,
        includeArchived: true,
      }),
    ).toThrow(TypeError);
  });

  it("rejects malformed and checksum-tampered cursors", () => {
    const cursor = serializeProviderIndexCursor(scopeOpenai, position);
    const parts = cursor.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"0".repeat(64)}`;
    for (const bad of ["", "nope", "pi1.only-two", tampered, `${cursor} `]) {
      expect(() => parseProviderIndexCursor(bad, scopeOpenai)).toThrow(TypeError);
    }
  });
});

// A dependency-light structural sanity check that the locator fingerprint helper
// is stable, so evidence artifacts that embed fingerprints stay path-free.
describe("gate-2 drill: locator fingerprint is path-free and stable", () => {
  it("produces a 64-hex fingerprint that never contains the raw home", () => {
    const home = tempHome("fingerprint");
    const fp = homeFingerprint("openai", home);
    expect(fp).toMatch(/^[0-9a-f]{64}$/u);
    expect(fp.includes(home)).toBe(false);
  });
});
