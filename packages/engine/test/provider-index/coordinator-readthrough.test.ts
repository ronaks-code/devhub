import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "../../src/index.js";
import { runMigrations } from "../../src/migrations.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";
import {
  homeFingerprint,
  taskLocator,
  type ProviderTaskLocator,
} from "../../src/provider-index/identity.js";
import { normalizeProviderEvent } from "../../src/providers/events.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { ProviderOperationError } from "../../src/providers/operation-error.js";
import { defineProviderCapabilities } from "../../src/providers/capabilities.js";
import type {
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
  ProviderAdapter,
} from "../../src/providers/types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

interface ConfiguredHome {
  readonly provider: "openai" | "anthropic";
  readonly home: string;
}

type ReadThroughResult =
  | Readonly<{ freshness: "native" | "cache"; projection: "summary"; task: Readonly<Record<string, unknown>> }>
  | Readonly<{ freshness: "native" | "cache"; projection: "snapshot"; task: Readonly<Record<string, unknown>> }>
  | Readonly<{ freshness: "missing"; locator: ProviderTaskLocator }>;

interface ReadThroughCoordinator {
  initialize(): readonly unknown[];
  readThrough(input: Readonly<{
    locator: ProviderTaskLocator;
    projection: "summary" | "snapshot";
    allowDegradedCache: boolean;
  }>): Promise<ReadThroughResult>;
  resolveVerifiedLegacySession(
    sessionId: string,
  ): Readonly<{ sessionId: string; locator: ProviderTaskLocator }> | null;
}

interface FactoryInput {
  readonly registry: ProviderRegistry;
  readonly store: ProviderTaskIndexStore;
  readonly registeredHomes: readonly ConfiguredHome[];
  readonly clock: Readonly<{ now: () => number }>;
  readonly options?: Readonly<Record<string, number>>;
}

type CoordinatorFactory = (input: FactoryInput) => ReadThroughCoordinator;

const databases: TestDatabase[] = [];
const directories: string[] = [];

function create(): CoordinatorFactory {
  const factory = (engine as { createProviderTaskIndexCoordinator?: CoordinatorFactory })
    .createProviderTaskIndexCoordinator;
  expect(factory).toBeTypeOf("function");
  return factory as CoordinatorFactory;
}

function openStore(): { store: ProviderTaskIndexStore; db: TestDatabase } {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA user_version = 13");
  runMigrations(db);
  return { store: new ProviderTaskIndexStore(db), db };
}

function temporaryHome(label: string): string {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), `devhub-${label}-`)));
  directories.push(home);
  return home;
}

function keyFor(home: string, nativeTaskId: string): NativeTaskKey {
  return Object.freeze({ provider: "openai", home, nativeTaskId } as const);
}

function locatorFor(key: NativeTaskKey): ProviderTaskLocator {
  return taskLocator(key);
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
      fingerprint: `openai:v1:${key.nativeTaskId}:${title}`,
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

function promoteSnapshot(store: ProviderTaskIndexStore, key: NativeTaskKey): void {
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

function promoteSummaryOnly(store: ProviderTaskIndexStore, key: NativeTaskKey): void {
  const handle = store.beginStage({
    provider: key.provider,
    homeFingerprint: store.registerHome({ provider: key.provider, home: key.home }, 1)
      .homeFingerprint,
  });
  store.stageSummary(handle, key, summary(key));
  store.promoteStage(handle, {
    completedAt: 500,
    providerVersion: null,
    taskCount: 1,
    turnCount: 0,
    eventCount: 0,
    snapshotCount: 0,
    receiptCount: 0,
  });
}

interface AdapterBehavior {
  readTask?: (key: NativeTaskKey, includeTurns: boolean) => Promise<NativeTask>;
}

function readAdapter(behavior: AdapterBehavior): ProviderAdapter {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected adapter invocation");
  };
  return {
    provider: "openai",
    capabilities: async () => defineProviderCapabilities({ read: true }),
    listTasks: unsupported,
    readTask: behavior.readTask ?? unsupported,
    startTask: unsupported,
    resumeTask: unsupported,
    forkTask: unsupported,
    send: unsupported,
    steer: unsupported,
    interrupt: unsupported,
    respond: unsupported,
    archive: unsupported,
    rename: unsupported,
    subscribe: unsupported,
  } as ProviderAdapter;
}

function coordinatorFor(
  store: ProviderTaskIndexStore,
  registry: ProviderRegistry,
  homes: readonly ConfiguredHome[],
  overrides: Partial<FactoryInput> = {},
): ReadThroughCoordinator {
  const coordinator = create()({
    registry,
    store,
    registeredHomes: homes,
    clock: Object.freeze({ now: () => 600 }),
    ...overrides,
  });
  coordinator.initialize();
  return coordinator;
}

async function expectRejectedWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected coordinator rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
    expect((error as Error).message ?? "").not.toContain("/tmp/");
  }
}

afterEach(() => {
  while (databases.length > 0) {
    try { databases.pop()!.close(); } catch { /* already closed */ }
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("ProviderTaskIndexCoordinator readThrough", () => {
  it("lets store UNKNOWN_HOME win before any provider access", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-unknown");
    const key = keyFor(home, "task-unknown");
    let providerCalls = 0;
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => { providerCalls += 1; return snapshot(key); },
    }));
    // Home is NOT registered in the store (coordinator initialized with no homes).
    const coordinator = coordinatorFor(store, registry, []);

    await expect(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
    })).rejects.toBeInstanceOf(ProviderIndexStoreError);
    try {
      await coordinator.readThrough({
        locator: locatorFor(key),
        projection: "snapshot",
        allowDegradedCache: true,
      });
    } catch (error) {
      expect((error as ProviderIndexStoreError).code).toBe("UNKNOWN_HOME");
    }
    expect(providerCalls).toBe(0);
  });

  it("returns a native snapshot projection and writes it through to the promoted cache", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-native-snap");
    const key = keyFor(home, "task-native-snap");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async (requested) => snapshot(requested, "Fresh native"),
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    const result = await coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: false,
    });

    expect(result).toMatchObject({ freshness: "native", projection: "snapshot" });
    expect(result.task).toMatchObject({ title: "Fresh native", cacheDetail: "snapshot" });
    expect(Array.isArray((result.task as { turns: unknown }).turns)).toBe(true);
    expect(store.read(locatorFor(key))).toMatchObject({ title: "Fresh native", observedAt: 600 });
  });

  it("returns a native projection before initial promotion without publishing a cache generation", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-native-pre");
    const key = keyFor(home, "task-native-pre");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async (requested) => snapshot(requested, "Pre-promotion"),
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);

    const result = await coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: false,
    });

    expect(result).toMatchObject({ freshness: "native", projection: "snapshot" });
    expect(result.task).toMatchObject({ title: "Pre-promotion" });
    expect(store.read(locatorFor(key))).toBeNull();
  });

  it("returns a native summary projection with no transcript", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-native-summary");
    const key = keyFor(home, "task-native-summary");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async (requested) => snapshot(requested, "Native summary"),
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    const result = await coordinator.readThrough({
      locator: locatorFor(key),
      projection: "summary",
      allowDegradedCache: false,
    });

    expect(result).toMatchObject({ freshness: "native", projection: "summary" });
    expect(result.task).toMatchObject({ title: "Native summary" });
    expect(Object.hasOwn(result.task as object, "turns")).toBe(false);
  });

  it("marks an authoritative-missing task missing and never consults cache", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-missing");
    const key = keyFor(home, "task-missing");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => {
        throw new ProviderOperationError("NATIVE_TASK_MISSING", "Provider native task is missing");
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    let missingCalls = 0;
    const original = store.markNativeTaskMissing.bind(store);
    Object.defineProperty(store, "markNativeTaskMissing", {
      configurable: true,
      value: (token: never) => { missingCalls += 1; return original(token); },
    });

    const result = await coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
    });

    expect(result).toMatchObject({ freshness: "missing" });
    expect((result as { locator: ProviderTaskLocator }).locator).toEqual(locatorFor(key));
    expect(missingCalls).toBe(1);
    // Cache was cleared by the missing transition, never returned as degraded cache.
    expect(store.read(locatorFor(key))).toBeNull();

    // A repeat authoritative-missing still marks missing (idempotent latch) and never returns cache.
    const repeat = await coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
    });
    expect(repeat).toMatchObject({ freshness: "missing" });
    expect(missingCalls).toBe(2);
  });

  it("returns degraded snapshot cache on a non-missing failure when permitted", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-cache-snap");
    const key = keyFor(home, "task-cache-snap");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => {
        throw new ProviderOperationError("DISABLED", "Provider capability is disabled");
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    let missingCalls = 0;
    const original = store.markNativeTaskMissing.bind(store);
    Object.defineProperty(store, "markNativeTaskMissing", {
      configurable: true,
      value: (token: never) => { missingCalls += 1; return original(token); },
    });

    const result = await coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
    });

    expect(result).toMatchObject({ freshness: "cache", projection: "snapshot" });
    expect(result.task).toMatchObject({ title: "Observed task", cacheDetail: "snapshot" });
    expect(missingCalls).toBe(0);
  });

  it("summary projection may consume a snapshot cache without fabricating a transcript", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-cache-summary");
    const key = keyFor(home, "task-cache-summary");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => {
        throw new ProviderOperationError("DISABLED", "Provider capability is disabled");
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    const result = await coordinator.readThrough({
      locator: locatorFor(key),
      projection: "summary",
      allowDegradedCache: true,
    });

    expect(result).toMatchObject({ freshness: "cache", projection: "summary" });
    expect(Object.hasOwn(result.task as object, "turns")).toBe(false);
  });

  it("rethrows the provider error when a snapshot request finds only a summary cache", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-summary-cache");
    const key = keyFor(home, "task-summary-cache");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => {
        throw new ProviderOperationError("DISABLED", "Provider capability is disabled");
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSummaryOnly(store, key);

    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
    }), "DISABLED");
  });

  it("rethrows the provider error when degraded cache is not allowed", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-no-degraded");
    const key = keyFor(home, "task-no-degraded");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => {
        throw new ProviderOperationError("DISABLED", "Provider capability is disabled");
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: false,
    }), "DISABLED");
  });

  it("rethrows the provider error when no cache is present", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-absent-cache");
    const key = keyFor(home, "task-absent-cache");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => {
        throw new ProviderOperationError("DISABLED", "Provider capability is disabled");
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);

    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
    }), "DISABLED");
  });

  it("lets cache corruption outrank the provider error on the degraded path", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-corrupt");
    const key = keyFor(home, "task-corrupt");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => {
        throw new ProviderOperationError("DISABLED", "Provider capability is disabled");
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    Object.defineProperty(store, "read", {
      configurable: true,
      value: () => { throw new ProviderIndexStoreError("CORRUPT_ROW"); },
    });

    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
    }), "CORRUPT_ROW");
  });

  it("never enters the missing transition for a RECONCILIATION_REQUIRED failure", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-recon");
    const key = keyFor(home, "task-recon");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => {
        throw new ProviderOperationError(
          "RECONCILIATION_REQUIRED",
          "Provider task requires authoritative reconciliation",
        );
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    let missingCalls = 0;
    const original = store.markNativeTaskMissing.bind(store);
    Object.defineProperty(store, "markNativeTaskMissing", {
      configurable: true,
      value: (token: never) => { missingCalls += 1; return original(token); },
    });

    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: false,
    }), "RECONCILIATION_REQUIRED");
    expect(missingCalls).toBe(0);
    // The previously observed persisted task remains readable; it was never deleted.
    expect(store.read(locatorFor(key))).toMatchObject({ title: "Observed task" });
  });

  it("fails a native success whose observation token drifted during provider access", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-drift");
    const key = keyFor(home, "task-drift");
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async (requested) => {
        // Concurrent authority mutation between token capture and write-through.
        store.replaceActiveSnapshot(key, snapshot(key, "Drifted concurrently"), 601);
        return snapshot(requested, "Late native");
      },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }], {
      clock: Object.freeze({ now: () => 602 }),
    });
    promoteSnapshot(store, key);

    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: false,
    }), "RECONCILIATION_CAS_MISMATCH");
    // The concurrent authority won; the late native result never overwrote it.
    expect(store.read(locatorFor(key))).toMatchObject({ title: "Drifted concurrently" });
  });

  it("rejects hostile readThrough input without touching the provider", async () => {
    const { store } = openStore();
    const home = temporaryHome("rt-hostile");
    const key = keyFor(home, "task-hostile");
    let providerCalls = 0;
    const registry = new ProviderRegistry();
    registry.register(home, readAdapter({
      readTask: async () => { providerCalls += 1; return snapshot(key); },
    }));
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    await expectRejectedWithCode(coordinator.readThrough(new Proxy({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
    }, {}) as never), "INVALID_INPUT");
    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "verbose" as unknown as "snapshot",
      allowDegradedCache: true,
    }), "INVALID_INPUT");
    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: "yes" as unknown as boolean,
    }), "INVALID_INPUT");
    await expectRejectedWithCode(coordinator.readThrough({
      locator: new Proxy(locatorFor(key), {}) as ProviderTaskLocator,
      projection: "snapshot",
      allowDegradedCache: true,
    }), "INVALID_INPUT");
    await expectRejectedWithCode(coordinator.readThrough({
      locator: locatorFor(key),
      projection: "snapshot",
      allowDegradedCache: true,
      extra: true,
    } as never), "INVALID_INPUT");
    expect(providerCalls).toBe(0);
  });
});

describe("ProviderTaskIndexCoordinator verified-legacy routing", () => {
  function insertMapping(db: TestDatabase, sessionId: string, home: string, nativeTaskId: string): void {
    db.prepare(`INSERT INTO legacy_session_task_map (
      legacy_session_id, provider, home_fingerprint, native_task_id,
      mapping_source, verified_at
    ) VALUES (?, 'openai', ?, ?, 'live-provider-observation', 7)`)
      .run(sessionId, homeFingerprint("openai", home), nativeTaskId);
  }

  it("resolves a natively verified legacy session to its unified locator", () => {
    const { store, db } = openStore();
    const home = temporaryHome("rt-legacy-mapped");
    const key = keyFor(home, "task-legacy");
    const registry = new ProviderRegistry();
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    insertMapping(db, "legacy-mapped", home, "task-legacy");

    const resolution = coordinator.resolveVerifiedLegacySession("legacy-mapped");
    expect(resolution).not.toBeNull();
    expect(resolution!.locator).toEqual(locatorFor(key));
    expect(resolution!.sessionId).toBe("legacy-mapped");
    expect(JSON.stringify(resolution)).not.toContain("/tmp/");
  });

  it("leaves an unresolved provenance-only legacy session on the legacy path", () => {
    const { store, db } = openStore();
    const home = temporaryHome("rt-legacy-unresolved");
    const registry = new ProviderRegistry();
    const coordinator = coordinatorFor(store, registry, [{ provider: "openai", home }]);
    db.prepare(`INSERT INTO legacy_session_provenance
      (legacy_session_id, provenance, observed_at) VALUES (?, 'archive-v1-import', 1)`)
      .run("legacy-provenance-only");

    expect(coordinator.resolveVerifiedLegacySession("legacy-provenance-only")).toBeNull();
    expect(coordinator.resolveVerifiedLegacySession("legacy-missing")).toBeNull();
  });
});
