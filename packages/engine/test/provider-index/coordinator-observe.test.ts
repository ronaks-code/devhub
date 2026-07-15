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
  taskLocator,
  type ProviderTaskLocator,
} from "../../src/provider-index/identity.js";
import { normalizeProviderEvent } from "../../src/providers/events.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type { NativeTask, NativeTaskKey, NativeTaskSummary } from "../../src/providers/types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

interface ConfiguredHome {
  readonly provider: "openai" | "anthropic";
  readonly home: string;
}

interface ObserveCoordinator {
  initialize(): readonly unknown[];
  observeTask(
    task: NativeTaskSummary | NativeTask,
  ): Promise<Readonly<{ title: string }> | null>;
  observeListPage(
    page: Readonly<{ items: readonly NativeTaskSummary[]; nextCursor?: string | null }>,
  ): Promise<readonly (Readonly<{ title: string }> | null)[]>;
  observationEpoch(locator: ProviderTaskLocator): number;
}

interface FactoryInput {
  readonly registry: ProviderRegistry;
  readonly store: ProviderTaskIndexStore;
  readonly registeredHomes: readonly ConfiguredHome[];
  readonly clock: Readonly<{ now: () => number }>;
  readonly options?: Readonly<Record<string, number>>;
}

type CoordinatorFactory = (input: FactoryInput) => ObserveCoordinator;

const databases: TestDatabase[] = [];
const directories: string[] = [];

function create(): CoordinatorFactory {
  const factory = (engine as { createProviderTaskIndexCoordinator?: CoordinatorFactory })
    .createProviderTaskIndexCoordinator;
  expect(factory).toBeTypeOf("function");
  return factory as CoordinatorFactory;
}

function openStore(): ProviderTaskIndexStore {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA user_version = 13");
  runMigrations(db);
  return new ProviderTaskIndexStore(db);
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

function coordinatorFor(
  store: ProviderTaskIndexStore,
  homes: readonly ConfiguredHome[],
  overrides: Partial<FactoryInput> = {},
): ObserveCoordinator {
  const coordinator = create()({
    registry: new ProviderRegistry(),
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

describe("ProviderTaskIndexCoordinator observation lanes", () => {
  it("observeTask writes a complete snapshot through to the active cache", async () => {
    const store = openStore();
    const home = temporaryHome("observe-snapshot");
    const key = keyFor(home, "task-snapshot");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    const result = await coordinator.observeTask(snapshot(key, "Updated snapshot"));

    expect(result).toMatchObject({ title: "Updated snapshot" });
    expect(store.read(locatorFor(key))).toMatchObject({
      title: "Updated snapshot",
      observedAt: 600,
      cacheDetail: "snapshot",
    });
  });

  it("observeTask with a summary-only observation preserves cached children", async () => {
    const store = openStore();
    const home = temporaryHome("observe-summary");
    const key = keyFor(home, "task-summary");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    // A summary-only observation that matches the promoted snapshot updates task fields while the
    // store preserves the previously cached children (the read still reports full snapshot detail).
    const result = await coordinator.observeTask(summary(key));

    expect(result).toMatchObject({ title: "Observed task" });
    expect(store.read(locatorFor(key))).toMatchObject({
      title: "Observed task",
      cacheDetail: "snapshot",
    });
  });

  it("does not expose page fragments before initial promotion", async () => {
    const store = openStore();
    const home = temporaryHome("observe-pre-promotion");
    const key = keyFor(home, "task-pre");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }]);

    const taskResult = await coordinator.observeTask(snapshot(key));
    const pageResult = await coordinator.observeListPage({ items: [summary(key)] });

    expect(taskResult).toBeNull();
    expect(pageResult).toEqual([null]);
    expect(store.read(locatorFor(key))).toBeNull();
  });

  it("observeListPage folds each summary through the active cache", async () => {
    const store = openStore();
    const home = temporaryHome("observe-page");
    const keyA = keyFor(home, "task-a");
    const keyB = keyFor(home, "task-b");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }]);
    promoteSnapshot(store, keyA);
    promoteSnapshot(store, keyB);

    const results = await coordinator.observeListPage({
      items: [summary(keyA, "Page A"), summary(keyB, "Page B")],
      nextCursor: null,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: "Page A" });
    expect(results[1]).toMatchObject({ title: "Page B" });
    expect(Object.isFrozen(results)).toBe(true);
  });

  it("propagates store errors for an unregistered home as ProviderIndexStoreError", async () => {
    const store = openStore();
    const home = temporaryHome("observe-unknown");
    const key = keyFor(home, "task-unknown");
    const coordinator = coordinatorFor(store, []);

    await expect(coordinator.observeTask(snapshot(key)))
      .rejects.toBeInstanceOf(ProviderIndexStoreError);
    try {
      await coordinator.observeTask(snapshot(key));
    } catch (error) {
      expect((error as ProviderIndexStoreError).code).toBe("UNKNOWN_HOME");
    }
  });

  it("rejects hostile observe input without touching the store", async () => {
    const store = openStore();
    const home = temporaryHome("observe-hostile");
    const key = keyFor(home, "task-hostile");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    await expectRejectedWithCode(
      coordinator.observeTask(new Proxy(snapshot(key), {}) as NativeTask),
      "INVALID_INPUT",
    );
    await expectRejectedWithCode(
      coordinator.observeTask(null as unknown as NativeTask),
      "INVALID_INPUT",
    );
    await expectRejectedWithCode(
      coordinator.observeListPage({ items: {} as unknown as NativeTaskSummary[] }),
      "INVALID_INPUT",
    );
    await expectRejectedWithCode(
      coordinator.observeListPage({
        items: [summary(key)],
        extra: true,
      } as unknown as { items: readonly NativeTaskSummary[] }),
      "INVALID_INPUT",
    );
    // The store was never written to because admission failed first.
    expect(store.read(locatorFor(key))).toMatchObject({ title: "Observed task" });
  });

  it("serializes same-locator observations FIFO so the last submitted wins", async () => {
    const store = openStore();
    const home = temporaryHome("observe-fifo");
    const key = keyFor(home, "task-fifo");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);

    const order: string[] = [];
    const original = store.replaceActiveSnapshot.bind(store);
    Object.defineProperty(store, "replaceActiveSnapshot", {
      configurable: true,
      value: (k: NativeTaskKey, t: NativeTask, o: number) => {
        order.push(t.title);
        return original(k, t, o);
      },
    });

    await Promise.all([
      coordinator.observeTask(snapshot(key, "First")),
      coordinator.observeTask(snapshot(key, "Second")),
      coordinator.observeTask(snapshot(key, "Third")),
    ]);

    expect(order).toEqual(["First", "Second", "Third"]);
    expect(store.read(locatorFor(key))).toMatchObject({ title: "Third" });
  });

  it("increments a per-locator observation epoch under a live lane and clears it afterward", async () => {
    const store = openStore();
    const home = temporaryHome("observe-epoch");
    const key = keyFor(home, "task-epoch");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }]);
    promoteSnapshot(store, key);
    const locator = locatorFor(key);

    let epochDuringSecond = -1;
    let calls = 0;
    const original = store.replaceActiveSnapshot.bind(store);
    Object.defineProperty(store, "replaceActiveSnapshot", {
      configurable: true,
      value: (k: NativeTaskKey, t: NativeTask, o: number) => {
        calls += 1;
        if (calls === 2) epochDuringSecond = coordinator.observationEpoch(locator);
        return original(k, t, o);
      },
    });

    await Promise.all([
      coordinator.observeTask(snapshot(key, "One")),
      coordinator.observeTask(snapshot(key, "Two")),
    ]);

    expect(epochDuringSecond).toBe(1);
    expect(coordinator.observationEpoch(locator)).toBe(0);
  });

  it("fails the first over-cap admission with CAPACITY and releases on settle", async () => {
    const store = openStore();
    const home = temporaryHome("observe-capacity");
    const key = keyFor(home, "task-cap");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }], {
      options: Object.freeze({ maxObservationOperations: 1 }),
    });
    promoteSnapshot(store, key);

    const first = coordinator.observeTask(snapshot(key, "Held"));
    await expectRejectedWithCode(coordinator.observeTask(snapshot(key, "Rejected")), "CAPACITY");
    await first;

    // Reservation released on the first operation's settle, so a later call is admitted.
    const later = await coordinator.observeTask(snapshot(key, "Later"));
    expect(later).toMatchObject({ title: "Later" });
  });

  it("admits observeListPage atomically so an over-budget page writes nothing", async () => {
    const store = openStore();
    const home = temporaryHome("observe-page-cap");
    const key = keyFor(home, "task-page-cap");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }], {
      options: Object.freeze({ maxObservationOperations: 1 }),
    });
    promoteSnapshot(store, key);

    // Two items but a budget of one: the whole page fails admission before any store write.
    await expectRejectedWithCode(
      coordinator.observeListPage({ items: [summary(key, "A"), summary(key, "B")] }),
      "CAPACITY",
    );

    expect(store.read(locatorFor(key))).toMatchObject({
      title: "Observed task",
      cacheDetail: "snapshot",
    });
  });

  it("bounds concurrent distinct-locator lanes by maxUniqueTasks", async () => {
    const store = openStore();
    const home = temporaryHome("observe-lane-cap");
    const keyA = keyFor(home, "task-lane-a");
    const keyB = keyFor(home, "task-lane-b");
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }], {
      options: Object.freeze({ maxUniqueTasks: 1 }),
    });
    promoteSnapshot(store, keyA);
    promoteSnapshot(store, keyB);

    const held = coordinator.observeTask(snapshot(keyA, "Lane A"));
    await expectRejectedWithCode(coordinator.observeTask(snapshot(keyB, "Lane B")), "CAPACITY");
    await held;

    // Lane A cleaned up after settle, so a distinct locator is admitted next.
    const next = await coordinator.observeTask(snapshot(keyB, "Lane B later"));
    expect(next).toMatchObject({ title: "Lane B later" });
  });

  it("maps a throwing clock during observation to value-free CLOCK_FAILURE", async () => {
    const store = openStore();
    const home = temporaryHome("observe-clock");
    const key = keyFor(home, "task-clock");
    let clockCalls = 0;
    const coordinator = coordinatorFor(store, [{ provider: "openai", home }], {
      clock: Object.freeze({
        now: () => {
          clockCalls += 1;
          if (clockCalls === 1) return 600; // initialize
          throw new Error(home);
        },
      }),
    });
    promoteSnapshot(store, key);

    await expectRejectedWithCode(coordinator.observeTask(snapshot(key)), "CLOCK_FAILURE");
    // Reservation released: a subsequent well-clocked call would be admitted (clock still throws,
    // but admission/lane budget is not leaked).
    await expectRejectedWithCode(coordinator.observeTask(snapshot(key)), "CLOCK_FAILURE");
  });
});
