import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { taskLocator } from "../../src/provider-index/identity.js";
import type { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const directories: string[] = [];

function tempDirectory(prefix = "devhub-provider-wiring-"): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return realpathSync(directory);
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
  expect(thrown).toMatchObject({
    name: "ProviderIndexStoreError",
    code,
  });
}

afterEach(() => {
  vi.doUnmock("../../src/provider-index/store.js");
  vi.resetModules();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TranscriptIndex provider-index wiring", () => {
  it("exposes a usable provider store only after the latest provider schema exists", async () => {
    const databaseFile = path.join(tempDirectory(), "index.db");
    const home = tempDirectory("devhub-provider-home-");
    const [{ TranscriptIndex }, { ProviderTaskIndexStore }] = await Promise.all([
      import("../../src/index-db.js"),
      import("../../src/provider-index/store.js"),
    ]);
    const index = new TranscriptIndex(databaseFile);

    try {
      expect(index.providerIndex).toBeInstanceOf(ProviderTaskIndexStore);
      const registration = index.providerIndex.registerHome(
        { provider: "openai", home },
        1_000,
      );
      expect(index.providerIndex.resolveHome("openai", registration.homeFingerprint)).toBe(home);
    } finally {
      index.close();
    }
  });

  it("constructs the provider store after migrations have installed the exact v15 schema", async () => {
    const observations: Array<{ version: number; providerHomesTable: string | null }> = [];
    const actualStore = await vi.importActual<typeof import("../../src/provider-index/store.js")>(
      "../../src/provider-index/store.js",
    );
    vi.doMock("../../src/provider-index/store.js", () => ({
      ...actualStore,
      ProviderTaskIndexStore: class extends actualStore.ProviderTaskIndexStore {
        constructor(...args: ConstructorParameters<typeof actualStore.ProviderTaskIndexStore>) {
          const db = args[0];
          const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
          const table = db.prepare(`SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'provider_homes'`).get() as
              { name: string } | undefined;
          observations.push({
            version: version.user_version,
            providerHomesTable: table?.name ?? null,
          });
          super(...args);
        }
      },
    }));

    const { TranscriptIndex } = await import("../../src/index-db.js");
    const index = new TranscriptIndex(path.join(tempDirectory(), "index.db"));
    try {
      expect(observations).toEqual([{
        version: 15,
        providerHomesTable: "provider_homes",
      }]);
    } finally {
      index.close();
    }
  });

  it("persists registered authority and reconciliation state across close and reopen", async () => {
    const databaseFile = path.join(tempDirectory(), "index.db");
    const home = tempDirectory("devhub-provider-home-");
    const { TranscriptIndex } = await import("../../src/index-db.js");
    const first = new TranscriptIndex(databaseFile);
    const registration = first.providerIndex.registerHome(
      { provider: "anthropic", home },
      2_000,
    );
    const locator = taskLocator(createNativeTaskKey("anthropic", home, "task-persisted"));
    first.providerIndex.requireReconciliation(locator, {
      reviewedFingerprint: null,
      nativeFingerprint: `anthropic:v1:${"a".repeat(64)}`,
      writerEpoch: 7,
      reason: "PROCESS_GENERATION_CHANGED",
    });
    const beforeClose = first.providerIndex.getReconciliation(locator);
    first.close();

    const reopened = new TranscriptIndex(databaseFile);
    try {
      expect(reopened.providerIndex.resolveHome("anthropic", registration.homeFingerprint)).toBe(home);
      expect(reopened.providerIndex.getReconciliation(locator)).toEqual(beforeClose);
    } finally {
      reopened.close();
    }
  });

  it("shares TranscriptIndex transaction ownership and becomes unavailable after its owner closes", async () => {
    const databaseFile = path.join(tempDirectory(), "index.db");
    const home = tempDirectory("devhub-provider-home-");
    const blockedHome = tempDirectory("devhub-provider-blocked-home-");
    const { TranscriptIndex } = await import("../../src/index-db.js");
    const index = new TranscriptIndex(databaseFile);
    const store = index.providerIndex;
    const registration = store.registerHome({ provider: "openai", home }, 1_000);
    const db = (index as unknown as { db: TestDatabase }).db;

    db.exec("BEGIN");
    try {
      expectStoreError(
        () => store.registerHome({ provider: "openai", home: blockedHome }, 2_000),
        "DATABASE_UNAVAILABLE",
      );
      expect(db.prepare("SELECT COUNT(*) AS count FROM provider_homes").get()).toEqual({ count: 1 });
    } finally {
      db.exec("ROLLBACK");
    }

    expect("close" in store).toBe(false);
    expect(index.settings.get("theme")).toBe("dark");
    expect(index.getSessionSummary("missing-session")).toBeUndefined();
    index.close();

    expectStoreError(
      () => store.resolveHome("openai", registration.homeFingerprint),
      "DATABASE_UNAVAILABLE",
    );
  });

  it("exports the concrete store only from the trusted root API", async () => {
    const [root, concrete, providers] = await Promise.all([
      import("../../src/index.js"),
      import("../../src/provider-index/store.js"),
      import("../../src/providers/index.js"),
    ]);

    expect(root.ProviderTaskIndexStore).toBe(concrete.ProviderTaskIndexStore);
    expect(providers).not.toHaveProperty("ProviderTaskIndexStore");
    expect(providers).not.toHaveProperty("resolveHome");
    expect(providers).not.toHaveProperty("ProviderIndexRegisteredHome");
  });
});
