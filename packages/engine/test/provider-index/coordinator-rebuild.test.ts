import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "../../src/index.js";
import { runMigrations } from "../../src/migrations.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import {
  taskLocator,
  type ProviderTaskLocator,
} from "../../src/provider-index/identity.js";
import { normalizeProviderEvent } from "../../src/providers/events.js";
import { ProviderOperationError } from "../../src/providers/operation-error.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type {
  ListTasksInput,
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
  Page,
  ProviderAdapter,
  ProviderCapabilities,
} from "../../src/providers/types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

interface ConfiguredHome {
  readonly provider: "openai" | "anthropic";
  readonly home: string;
}

interface RebuildInput {
  readonly provider: "openai" | "anthropic";
  readonly home: string;
  readonly signal?: AbortSignal;
}

interface RebuildPromotion {
  readonly provider: "openai" | "anthropic";
  readonly homeFingerprint: string;
  readonly previousGeneration: number;
  readonly activeGeneration: number;
  readonly taskCount: number;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly snapshotCount: number;
}

interface RebuildCoordinator {
  initialize(): readonly unknown[];
  rebuild(input: RebuildInput): Promise<RebuildPromotion>;
  observeTask(task: NativeTaskSummary | NativeTask): Promise<unknown>;
  observationEpoch(locator: ProviderTaskLocator): number;
}

interface FactoryInput {
  readonly registry: ProviderRegistry;
  readonly store: ProviderTaskIndexStore;
  readonly registeredHomes: readonly ConfiguredHome[];
  readonly clock: Readonly<{ now: () => number }>;
  readonly timers?: Readonly<{
    setTimeout: (callback: () => void, delayMs: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  }>;
  readonly options?: Readonly<Record<string, number>>;
}

type CoordinatorFactory = (input: FactoryInput) => RebuildCoordinator;

const databases: TestDatabase[] = [];
const directories: string[] = [];

function factory(): CoordinatorFactory {
  const create = (engine as { createProviderTaskIndexCoordinator?: CoordinatorFactory })
    .createProviderTaskIndexCoordinator;
  expect(create).toBeTypeOf("function");
  return create as CoordinatorFactory;
}

function openStore(now: () => number = () => 100): ProviderTaskIndexStore {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA user_version = 13");
  runMigrations(db);
  let token = 0;
  return new ProviderTaskIndexStore(db, {
    stageLeaseMs: 1_000,
    now,
    tokenFactory: () => `stage-owner-${(token += 1)}`,
  });
}

function inertTimers(): Readonly<{
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}> {
  return Object.freeze({
    setTimeout: () => Object.freeze({}),
    clearTimeout: () => undefined,
  });
}

function temporaryHome(label: string): string {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), `devhub-${label}-`)));
  directories.push(home);
  return home;
}

function keyFor(home: string, nativeTaskId: string): NativeTaskKey {
  return Object.freeze({ provider: "openai", home, nativeTaskId } as const);
}

function summary(
  key: NativeTaskKey,
  overrides: { title?: string; updatedAt?: number | null } = {},
): NativeTaskSummary {
  const title = overrides.title ?? `Task ${key.nativeTaskId}`;
  const updatedAt = overrides.updatedAt === undefined ? 1 : overrides.updatedAt;
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
      updatedAt,
      status: "complete",
      lastTurnId: "turn-1",
      lastTurnStatus: "complete",
      lastItemId: "item-1",
      fingerprint: `openai:v1:${key.nativeTaskId}:${title}`,
    }),
  });
}

function snapshot(
  key: NativeTaskKey,
  eventTexts: readonly string[] = ["reply"],
  overrides: { title?: string; updatedAt?: number | null } = {},
): NativeTask {
  const base = summary(key, overrides);
  const turns = eventTexts.length === 0
    ? []
    : [Object.freeze({
        id: "turn-1",
        status: "complete",
        startedAt: "2026-07-14T00:00:00.000Z",
        completedAt: "2026-07-14T00:01:00.000Z",
        events: Object.freeze(eventTexts.map((text, index) =>
          normalizeProviderEvent({
            type: "message",
            role: "assistant",
            text,
            turnId: "turn-1",
            itemId: `item-${index}`,
          }, {
            provider: key.provider,
            key,
            occurredAt: "2026-07-14T00:00:30.000Z",
          }))),
      })];
  return Object.freeze({ ...base, turns: Object.freeze(turns) });
}

const FULL_CAPABILITIES: ProviderCapabilities = Object.freeze({
  list: true,
  read: true,
  start: false,
  resume: false,
  fork: false,
  send: false,
  steer: false,
  interrupt: false,
  subscribe: false,
  approveCommand: false,
  approveFileChange: false,
  approvePermissions: false,
  requestUserInput: false,
  mcpElicitation: false,
  archive: false,
  rename: false,
  skills: false,
  plugins: false,
  hooks: false,
  mcp: false,
  backgroundWork: false,
});

interface FakeHooks {
  listTasks(input: ListTasksInput): Promise<Page<NativeTaskSummary>>;
  readTask(key: NativeTaskKey, includeTurns: boolean): Promise<NativeTask>;
}

class FakeAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;
  mutations = 0;

  constructor(private readonly hooks: FakeHooks) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return FULL_CAPABILITIES;
  }

  listTasks(input: ListTasksInput): Promise<Page<NativeTaskSummary>> {
    return this.hooks.listTasks(input);
  }

  readTask(key: NativeTaskKey, includeTurns: boolean): Promise<NativeTask> {
    return this.hooks.readTask(key, includeTurns);
  }

  private mutation(): never {
    this.mutations += 1;
    throw new Error("rebuild must never call a provider mutation API");
  }

  startTask(): Promise<NativeTask> { return this.mutation(); }
  resumeTask(): Promise<NativeTask> { return this.mutation(); }
  forkTask(): Promise<NativeTask> { return this.mutation(); }
  send(): Promise<never> { return this.mutation(); }
  steer(): Promise<void> { return this.mutation(); }
  interrupt(): Promise<void> { return this.mutation(); }
  respond(): Promise<void> { return this.mutation(); }
  archive(): Promise<void> { return this.mutation(); }
  rename(): Promise<void> { return this.mutation(); }
  subscribe(): Promise<never> { return this.mutation(); }
}

/** Adapter driven by ordered pages and a snapshot table keyed by native task id. */
function pagedAdapter(
  pages: readonly Page<NativeTaskSummary>[],
  snapshots: ReadonlyMap<string, NativeTask>,
  extra: Partial<FakeHooks> = {},
): FakeAdapter {
  const byCursor = new Map<string | undefined, Page<NativeTaskSummary>>();
  pages.forEach((page, index) => {
    const cursor = index === 0 ? undefined : `cursor-${index}`;
    byCursor.set(cursor, page);
  });
  return new FakeAdapter({
    listTasks: extra.listTasks ?? (async (input) => {
      const page = byCursor.get(input.cursor);
      if (page === undefined) throw new Error(`unexpected cursor ${String(input.cursor)}`);
      return page;
    }),
    readTask: extra.readTask ?? (async (key) => {
      const task = snapshots.get(key.nativeTaskId);
      if (task === undefined) {
        throw new ProviderOperationError("NATIVE_TASK_MISSING", "missing");
      }
      return task;
    }),
  });
}

function page(
  items: readonly NativeTaskSummary[],
  nextCursor: string | null,
): Page<NativeTaskSummary> {
  return Object.freeze({ items: Object.freeze([...items]), nextCursor });
}

function coordinatorFor(
  registry: ProviderRegistry,
  store: ProviderTaskIndexStore,
  homes: readonly ConfiguredHome[],
  overrides: Partial<FactoryInput> = {},
): RebuildCoordinator {
  const coordinator = factory()({
    registry,
    store,
    registeredHomes: homes,
    clock: Object.freeze({ now: () => 1_000 }),
    timers: inertTimers(),
    ...overrides,
  });
  coordinator.initialize();
  return coordinator;
}

function activeIds(store: ProviderTaskIndexStore): readonly string[] {
  return store.list().items.map((item) => item.locator.nativeTaskId).sort();
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

describe("ProviderTaskIndexCoordinator rebuild lifecycle", () => {
  it("promotes an empty active generation for a zero-task provider", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-zero");
    registry.register(home, pagedAdapter([page([], null)], new Map()));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    const promotion = await coordinator.rebuild({ provider: "openai", home });

    expect(promotion).toMatchObject({
      previousGeneration: 0,
      taskCount: 0,
      turnCount: 0,
      eventCount: 0,
      snapshotCount: 0,
    });
    expect(activeIds(store)).toEqual([]);
  });

  it("stages one snapshot per unique locator with summed turn/event totals", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-snapshots");
    const keyA = keyFor(home, "task-a");
    const keyB = keyFor(home, "task-b");
    const snapshots = new Map([
      [keyA.nativeTaskId, snapshot(keyA, ["a1", "a2"])],
      [keyB.nativeTaskId, snapshot(keyB, ["b1"])],
    ]);
    registry.register(home, pagedAdapter([page([summary(keyA), summary(keyB)], null)], snapshots));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    const promotion = await coordinator.rebuild({ provider: "openai", home });

    expect(promotion).toMatchObject({
      taskCount: 2,
      snapshotCount: 2,
      turnCount: 2,
      eventCount: 3,
    });
    expect(activeIds(store)).toEqual(["task-a", "task-b"]);
    expect(store.read(taskLocator(keyA))).toMatchObject({
      cacheDetail: "snapshot",
      title: "Task task-a",
    });
  });

  it("deduplicates overlapping pages and duplicate items into one census", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-dedupe");
    const keyA = keyFor(home, "task-a");
    const keyB = keyFor(home, "task-b");
    const snapshots = new Map([
      [keyA.nativeTaskId, snapshot(keyA, ["a"])],
      [keyB.nativeTaskId, snapshot(keyB, ["b"])],
    ]);
    registry.register(home, pagedAdapter([
      // duplicate item within a page and overlap across pages
      page([summary(keyA), summary(keyA)], "cursor-1"),
      page([summary(keyA), summary(keyB)], null),
    ], snapshots));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    const promotion = await coordinator.rebuild({ provider: "openai", home });

    expect(promotion.taskCount).toBe(2);
    expect(activeIds(store)).toEqual(["task-a", "task-b"]);
  });

  it("selects the greatest non-null revision updatedAt, later item breaking a tie", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-winner");
    const key = keyFor(home, "task-a");
    let read: NativeTask | null = null;
    const adapter = pagedAdapter(
      [
        page([summary(key, { title: "older", updatedAt: 5 })], "cursor-1"),
        page([
          // higher updatedAt wins over the earlier page
          summary(key, { title: "newer", updatedAt: 9 }),
          // tie at 9 -> the later item wins
          summary(key, { title: "tie-winner", updatedAt: 9 }),
        ], null),
      ],
      new Map(),
      {
        readTask: async (k) => {
          const task = snapshot(k, ["reply"], { title: "tie-winner", updatedAt: 9 });
          read = task;
          return task;
        },
      },
    );
    registry.register(home, adapter);
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    await coordinator.rebuild({ provider: "openai", home });

    expect(read).not.toBeNull();
    expect(store.read(taskLocator(key))).toMatchObject({ title: "tie-winner" });
  });

  it("rejects an exact-repeat cursor and preserves the prior active generation", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-repeat-cursor");
    const key = keyFor(home, "seed");
    // Seed a prior generation with a task that must survive a failed rebuild.
    registry.register(home, pagedAdapter([
      page([summary(key)], "cursor-1"),
      page([], "cursor-1"), // repeat of an already-seen cursor
    ], new Map([[key.nativeTaskId, snapshot(key, ["seed"])]])));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);
    await seedGeneration(store, key);

    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "INVALID_INPUT");
    expect(activeIds(store)).toEqual(["seed"]);
  });

  it("rejects a non-canonical cursor with a lone surrogate", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-bad-cursor");
    const key = keyFor(home, "task-a");
    registry.register(home, pagedAdapter([
      page([summary(key)], "\ud800"),
    ], new Map([[key.nativeTaskId, snapshot(key)]])));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "INVALID_INPUT");
  });

  it("rejects a cursor longer than 4096 UTF-8 bytes", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-long-cursor");
    const key = keyFor(home, "task-a");
    registry.register(home, pagedAdapter([
      page([summary(key)], "c".repeat(4_097)),
    ], new Map([[key.nativeTaskId, snapshot(key)]])));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "INVALID_INPUT");
  });

  it("rejects an oversized page beyond the configured page size", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-oversized");
    const keyA = keyFor(home, "task-a");
    const keyB = keyFor(home, "task-b");
    const keyC = keyFor(home, "task-c");
    registry.register(home, pagedAdapter([
      page([summary(keyA), summary(keyB), summary(keyC)], null),
    ], new Map()));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }], {
      options: Object.freeze({ pageSize: 2 }),
    });

    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "CAPACITY");
  });

  it("fails with CAPACITY when the page bound is exceeded", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-maxpages");
    const key = keyFor(home, "task-a");
    registry.register(home, pagedAdapter([
      page([summary(key)], "cursor-1"),
      page([summary(key)], "cursor-2"),
      page([summary(key)], "cursor-3"),
    ], new Map([[key.nativeTaskId, snapshot(key)]])));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }], {
      options: Object.freeze({ maxPages: 2 }),
    });

    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "CAPACITY");
  });

  it("fails with CAPACITY when the unique-task bound is exceeded", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-maxtasks");
    const keyA = keyFor(home, "task-a");
    const keyB = keyFor(home, "task-b");
    registry.register(home, pagedAdapter([
      page([summary(keyA), summary(keyB)], null),
    ], new Map()));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }], {
      options: Object.freeze({ maxUniqueTasks: 1 }),
    });

    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "CAPACITY");
  });

  it("aborts a mid-rebuild provider read failure and retains the prior generation", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-midfail");
    const key = keyFor(home, "task-a");
    registry.register(home, pagedAdapter([
      page([summary(key)], null),
    ], new Map())); // readTask throws NATIVE_TASK_MISSING (no snapshot registered)
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);
    await seedGeneration(store, keyFor(home, "prior"));

    await expect(coordinator.rebuild({ provider: "openai", home })).rejects.toBeTruthy();
    expect(activeIds(store)).toEqual(["prior"]);
  });

  it("drops a natively deleted task after promotion switches the generation", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-deletion");
    const survivor = keyFor(home, "survivor");
    registry.register(home, pagedAdapter([
      page([summary(survivor)], null), // "deleted" task no longer listed
    ], new Map([[survivor.nativeTaskId, snapshot(survivor)]])));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);
    await seedGeneration(store, keyFor(home, "deleted"));

    await coordinator.rebuild({ provider: "openai", home });

    expect(activeIds(store)).toEqual(["survivor"]);
  });

  it("isolates a rebuild to its own scope and leaves another home untouched", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const homeA = temporaryHome("rebuild-scope-a");
    const homeB = temporaryHome("rebuild-scope-b");
    const keyA = keyFor(homeA, "task-a");
    registry.register(homeA, pagedAdapter([page([summary(keyA)], null)],
      new Map([[keyA.nativeTaskId, snapshot(keyA)]])));
    const coordinator = coordinatorFor(registry, store, [
      { provider: "openai", home: homeA },
      { provider: "openai", home: homeB },
    ]);
    const keyB = { provider: "openai" as const, home: homeB, nativeTaskId: "task-b" };
    await seedGeneration(store, keyB);
    const beforeB = store.read(taskLocator(keyB));

    await coordinator.rebuild({ provider: "openai", home: homeA });

    expect(store.read(taskLocator(keyB))).toEqual(beforeB);
    expect(store.read(taskLocator(keyA))).toMatchObject({ title: "Task task-a" });
  });

  it("refuses a concurrent rebuild for the same scope with REBUILD_BUSY", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-busy");
    const key = keyFor(home, "task-a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstList = true;
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]), {
        listTasks: async () => {
          if (firstList) {
            firstList = false;
            await gate;
          }
          return page([summary(key)], null);
        },
      }));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    const inflight = coordinator.rebuild({ provider: "openai", home });
    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "REBUILD_BUSY");
    release();
    await inflight;

    // The single-flight reservation is released, so a later rebuild is admitted.
    await coordinator.rebuild({ provider: "openai", home });
  });

  it("never calls a provider mutation API during rebuild", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-nomutation");
    const key = keyFor(home, "task-a");
    const adapter = pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]));
    registry.register(home, adapter);
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    await coordinator.rebuild({ provider: "openai", home });

    expect(adapter.mutations).toBe(0);
  });

  it("fails CANCELLED before beginning a stage when the signal is already aborted", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-preabort");
    const key = keyFor(home, "task-a");
    let listed = false;
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]), {
        listTasks: async () => { listed = true; return page([summary(key)], null); },
      }));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);
    const controller = new AbortController();
    controller.abort();

    await expectRejectedWithCode(
      coordinator.rebuild({ provider: "openai", home, signal: controller.signal }),
      "CANCELLED",
    );
    expect(listed).toBe(false);
    expect(store.list().items).toEqual([]);
  });

  it("cancels a mid-run rebuild and aborts the stage", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-cancel");
    const key = keyFor(home, "task-a");
    const controller = new AbortController();
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]), {
        readTask: async (k) => { controller.abort(); return snapshot(k); },
      }));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);
    await seedGeneration(store, keyFor(home, "prior"));

    await expectRejectedWithCode(
      coordinator.rebuild({ provider: "openai", home, signal: controller.signal }),
      "CANCELLED",
    );
    expect(activeIds(store)).toEqual(["prior"]);
  });

  it("times out a rebuild whose deadline elapses on the injected clock", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-timeout");
    const key = keyFor(home, "task-a");
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]])));
    // `initialize()` consumes the first sample; the deadline elapses on the third (first heartbeat).
    let calls = 0;
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }], {
      clock: Object.freeze({ now: () => { calls += 1; return calls <= 2 ? 1_000 : 999_999; } }),
      options: Object.freeze({ maxRebuildMs: 5 }),
    });
    await seedGeneration(store, keyFor(home, "prior"));

    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "REBUILD_TIMEOUT");
    expect(activeIds(store)).toEqual(["prior"]);
  });

  it("reports a stage-loss cleanup failure ahead of the cancel terminal", async () => {
    const registry = new ProviderRegistry();
    let storeNow = 100;
    const store = openStore(() => storeNow);
    const home = temporaryHome("rebuild-stageloss");
    const key = keyFor(home, "task-a");
    const controller = new AbortController();
    const takeover = new ProviderTaskIndexStore(
      (store as unknown as { db: TestDatabase }).db,
      { stageLeaseMs: 1_000, now: () => storeNow, tokenFactory: () => "takeover-owner" },
    );
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]), {
        readTask: async (k) => {
          // Expire our lease, let a rival take the stage over, then request cancel.
          storeNow = 5_000;
          takeover.beginStage({ provider: "openai", homeFingerprint: currentFingerprint(store) });
          controller.abort();
          return snapshot(k);
        },
      }));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    // The abort fails as STAGE_LOST (a store error), which outranks CANCELLED.
    await expect(coordinator.rebuild({ provider: "openai", home, signal: controller.signal }))
      .rejects.toMatchObject({ code: "STAGE_LOST" });
  });

  it("fails STALE_OBSERVATION when a concurrent observation lands during the reads", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-stale");
    const key = keyFor(home, "task-a");
    let coordinator!: RebuildCoordinator;
    let observed = false;
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]), {
        readTask: async (k) => {
          if (!observed) {
            observed = true;
            // A newer observation bumps the pinned lane epoch mid-rebuild.
            await coordinator.observeTask(snapshot(k, ["newer"], { title: "newer" }));
          }
          return snapshot(k);
        },
      }));
    coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);
    await seedGeneration(store, key);

    await expectRejectedWithCode(coordinator.rebuild({ provider: "openai", home }), "STALE_OBSERVATION");
    // Prior generation retained; the rebuild's staging generation never promoted.
    expect(activeIds(store)).toEqual(["task-a"]);
  });

  it("refuses promotion and aborts when the store's SQL counts disagree", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const db = databases[databases.length - 1]!;
    const home = temporaryHome("rebuild-sqlmismatch");
    const key = keyFor(home, "task-a");
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]), {
        readTask: async (k) => {
          // Inject a stray staged task row so the SQL taskCount exceeds the passed count.
          const stagingGeneration = (db.prepare(
            `SELECT staging_generation FROM provider_sync_state`,
          ).get() as { staging_generation: number }).staging_generation;
          db.prepare(`INSERT INTO provider_task_cache (
            provider, home_fingerprint, native_task_id, title, status, source,
            cache_generation, observed_at
          ) VALUES (?, ?, 'stray', 'stray', 'idle', 'degraded-fallback', ?, 1)`)
            .run(k.provider, currentFingerprint(store), stagingGeneration);
          return snapshot(k);
        },
      }));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);
    await seedGeneration(store, keyFor(home, "prior"));

    await expect(coordinator.rebuild({ provider: "openai", home }))
      .rejects.toMatchObject({ code: "STAGE_INCOMPLETE" });
    expect(activeIds(store)).toEqual(["prior"]);
  });

  it("rejects hostile rebuild input before touching the provider or store", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-hostile");
    const key = keyFor(home, "task-a");
    let listed = false;
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]), {
        listTasks: async () => { listed = true; return page([summary(key)], null); },
      }));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }]);

    await expectRejectedWithCode(
      coordinator.rebuild(new Proxy({ provider: "openai", home }, {}) as RebuildInput),
      "INVALID_INPUT",
    );
    await expectRejectedWithCode(
      coordinator.rebuild({ provider: "openai", home, extra: true } as unknown as RebuildInput),
      "INVALID_INPUT",
    );
    await expectRejectedWithCode(
      coordinator.rebuild({ provider: "openai", home: "/tmp/not-registered-\ud800" }),
      "INVALID_INPUT",
    );
    expect(listed).toBe(false);
  });

  it("wakes a heartbeat through host timers while a provider await is pending", async () => {
    const registry = new ProviderRegistry();
    const store = openStore();
    const home = temporaryHome("rebuild-timer");
    const key = keyFor(home, "task-a");
    const controller = new AbortController();
    let captured: (() => void) | null = null;
    const timers = Object.freeze({
      setTimeout: (callback: () => void) => { captured = callback; return Object.freeze({}); },
      clearTimeout: () => { captured = null; },
    });
    registry.register(home, pagedAdapter([page([summary(key)], null)],
      new Map([[key.nativeTaskId, snapshot(key)]]), {
        readTask: async (k) => {
          // Simulate the host timer firing mid-await after a cancel is requested.
          controller.abort();
          if (captured !== null) captured();
          return snapshot(k);
        },
      }));
    const coordinator = coordinatorFor(registry, store, [{ provider: "openai", home }], { timers });
    await seedGeneration(store, keyFor(home, "prior"));

    await expectRejectedWithCode(
      coordinator.rebuild({ provider: "openai", home, signal: controller.signal }),
      "CANCELLED",
    );
    expect(activeIds(store)).toEqual(["prior"]);
  });
});

/** Promote a one-task generation directly through the store so a rebuild has a prior active state. */
async function seedGeneration(store: ProviderTaskIndexStore, key: NativeTaskKey): Promise<void> {
  const registration = store.registerHome({ provider: key.provider, home: key.home }, 1);
  const stage = store.beginStage({
    provider: registration.provider,
    homeFingerprint: registration.homeFingerprint,
  });
  store.stageSnapshot(stage, key, snapshot(key, ["seed"]));
  store.promoteStage(stage, {
    completedAt: 500,
    providerVersion: null,
    taskCount: 1,
    turnCount: 1,
    eventCount: 1,
    snapshotCount: 1,
    receiptCount: 1,
  });
}

function currentFingerprint(store: ProviderTaskIndexStore): string {
  const db = (store as unknown as { db: TestDatabase }).db;
  const row = db.prepare(`SELECT home_fingerprint FROM provider_sync_state LIMIT 1`).get() as
    { home_fingerprint: string } | undefined;
  if (row === undefined) throw new Error("no sync state");
  return row.home_fingerprint;
}
