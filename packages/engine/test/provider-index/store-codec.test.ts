import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachedTurnKey,
  canonicalProviderIndexJson,
  parseCachedEventItemKey,
  parseCachedTurnKey,
  parseProviderEventReplayKey,
  taskLocator,
} from "../../src/provider-index/identity.js";
import {
  createProviderIndexOwnerToken,
  decodeCachedProviderEvent,
  normalizeProviderIndexStoreOptions,
  prepareProviderTaskSnapshot,
  prepareProviderTaskSummary,
  readProviderIndexNow,
} from "../../src/provider-index/store-codec.js";
import {
  PROVIDER_INDEX_STORE_DEFAULTS,
  PROVIDER_INDEX_STORE_HARD_LIMITS,
  ProviderIndexStoreError,
  type ProviderIndexStoreErrorCode,
  type ProviderIndexStoreOptions,
  type ProviderIndexRegisteredHome,
} from "../../src/provider-index/store-types.js";
import { normalizeProviderEvent, type ProviderEvent } from "../../src/providers/events.js";
import * as providersIndex from "../../src/providers/index.js";
import { createProviderRequestIdentity } from "../../src/providers/request-identity.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";
import type {
  NativeRevision,
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
  NativeTaskSource,
} from "../../src/providers/types.js";

const HOME = "/__devhub_store_codec__/home";
const OUTSIDE_CWD = "/__devhub_store_codec__/project";
const OCCURRED_AT = "2026-07-13T21:00:00.000Z";
const dirs: string[] = [];
const key = createNativeTaskKey("openai", HOME, "task-1");

const registrationFor = (value: NativeTaskKey = key): ProviderIndexRegisteredHome => ({
  provider: value.provider,
  homeFingerprint: taskLocator(value).homeFingerprint,
  canonicalHome: value.home,
});

const eventFor = (
  input: unknown,
  value: NativeTaskKey = key,
): ProviderEvent => normalizeProviderEvent(input, {
  provider: value.provider,
  key: value,
  occurredAt: OCCURRED_AT,
});

const revision = (overrides: Partial<NativeRevision> = {}): NativeRevision => ({
  updatedAt: 1_000,
  status: "complete",
  lastTurnId: "turn-2",
  lastTurnStatus: "complete",
  lastItemId: "item-1",
  fingerprint: "openai:v1:revision-1",
  ...overrides,
});

const nativeTask = (overrides: Partial<NativeTask> = {}): NativeTask => ({
  key,
  title: "Codec task",
  cwd: OUTSIDE_CWD,
  model: "provider-model",
  status: "idle",
  createdAt: "2026-07-13T20:00:00.000Z",
  updatedAt: "2026-07-13T21:00:00.000Z",
  archived: false,
  source: "native",
  revision: revision(),
  turns: [
    {
      id: "turn-1",
      status: "complete",
      startedAt: "2026-07-13T20:00:00.000Z",
      completedAt: "2026-07-13T20:30:00.000Z",
      events: [
        eventFor({
          type: "message-delta",
          role: "assistant",
          delta: "hello ",
          turnId: "turn-1",
          itemId: "item-1",
        }),
        eventFor({
          type: "message-delta",
          role: "assistant",
          delta: "world",
          turnId: "turn-1",
          itemId: "item-1",
        }),
      ],
    },
    {
      id: "turn-2",
      status: "complete",
      startedAt: "2026-07-13T20:31:00.000Z",
      completedAt: "2026-07-13T20:32:00.000Z",
      events: [eventFor({ futureProviderShape: true })],
    },
  ],
  ...overrides,
});

const taskWithSource = (
  source: NativeTaskSource,
  includeRevision: boolean,
  overrides: Partial<NativeTask> = {},
): NativeTask => {
  const task = nativeTask({ source, ...overrides });
  if (includeRevision) return task;
  const { revision: _revision, ...withoutRevision } = task;
  return withoutRevision;
};

const nativeSummary = (overrides: Partial<NativeTask> = {}): NativeTaskSummary => {
  const { turns: _turns, ...summary } = nativeTask(overrides);
  return summary;
};

const rowFor = (
  event: ReturnType<typeof prepareProviderTaskSnapshot>["turns"][number]["events"][number],
): Record<keyof import("../../src/provider-index/store-types.js").ProviderEventCacheRow, unknown> => ({
  provider: event.event.provider,
  home_fingerprint: event.event.locator.homeFingerprint,
  native_task_id: event.event.locator.nativeTaskId,
  native_turn_key: event.nativeTurnKey,
  native_item_key: event.nativeItemKey,
  replay_key: event.replayKey,
  ordinal: event.ordinal,
  event_fingerprint: event.eventFingerprint,
  event_json: event.eventJson,
});

const eventFingerprint = (replayKey: string, eventJson: string): string => createHash("sha256")
  .update(`devhub-provider-event-cache:v1\u0000${replayKey}\u0000${eventJson}`, "utf8")
  .digest("hex");

const withEventJson = (
  row: ReturnType<typeof rowFor>,
  event: unknown,
): ReturnType<typeof rowFor> => {
  const eventJson = canonicalProviderIndexJson(event);
  return {
    ...row,
    event_json: eventJson,
    event_fingerprint: eventFingerprint(row.replay_key as string, eventJson),
  };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const captureError = (action: () => unknown): unknown => {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
};

const expectStoreError = (
  action: () => unknown,
  code: ProviderIndexStoreErrorCode,
  forbidden = "must-never-leak",
): void => {
  const error = captureError(action);
  expect(error).toBeInstanceOf(ProviderIndexStoreError);
  expect((error as ProviderIndexStoreError).code).toBe(code);
  expect(String(error)).not.toContain(forbidden);
};

describe("provider index store codec public surface", () => {
  it("keeps backend-only raw-home and preparation plumbing out of the provider barrel", () => {
    const api = providersIndex as unknown as Record<string, unknown>;
    for (const name of [
      "normalizeProviderIndexStoreOptions",
      "readProviderIndexNow",
      "createProviderIndexOwnerToken",
      "prepareProviderTaskSummary",
      "prepareProviderTaskSnapshot",
      "providerTaskSnapshotFingerprint",
      "providerTaskSnapshotReceiptKey",
      "decodeCachedProviderEvent",
      "projectProviderEventCacheBundleFromSnapshot",
    ]) {
      expect(api[name], name).toBeUndefined();
    }
    expect(api.ProviderIndexStoreError).toBe(ProviderIndexStoreError);
    for (const name of [
      "PROVIDER_INDEX_STORE_DEFAULTS",
      "PROVIDER_INDEX_STORE_HARD_LIMITS",
    ]) {
      expect(api[name], name).toBeTypeOf("object");
    }
  });
});

describe("provider index store configuration", () => {
  const errorCodes: readonly ProviderIndexStoreErrorCode[] = [
    "INVALID_INPUT",
    "CORRUPT_ROW",
    "DATABASE_UNAVAILABLE",
    "CLOCK_FAILURE",
    "TOKEN_FAILURE",
    "CAPACITY",
    "UNKNOWN_HOME",
    "HOME_CONFLICT",
    "STAGE_BUSY",
    "STAGE_LOST",
    "STAGE_EXPIRED",
    "STAGE_INCOMPLETE",
    "REPLAY_CONFLICT",
    "FORK_CONFLICT",
    "LEGACY_MAPPING_CONFLICT",
    "RECONCILIATION_CAS_MISMATCH",
  ];

  it("defines the exact stable value-free error code surface", () => {
    expect(errorCodes).toHaveLength(16);
    for (const code of errorCodes) {
      const error = new ProviderIndexStoreError(code);
      expect(error.name).toBe("ProviderIndexStoreError");
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("must-never-leak");
    }
  });

  it("normalizes frozen defaults and exports frozen hard limits", () => {
    const config = normalizeProviderIndexStoreOptions();
    expect(PROVIDER_INDEX_STORE_DEFAULTS).toEqual({
      stageLeaseMs: 30_000,
      maxTasksPerGeneration: 100_000,
      maxTurnsPerGeneration: 1_000_000,
      maxEventsPerTask: 100_000,
      maxEventsPerGeneration: 5_000_000,
      maxMetadataDepth: 16,
    });
    expect(PROVIDER_INDEX_STORE_HARD_LIMITS).toEqual({
      stageLeaseMs: { min: 1_000, max: 300_000 },
      maxTasksPerGeneration: 1_000_000,
      maxTurnsPerGeneration: 2_000_000,
      maxEventsPerTask: 1_000_000,
      maxEventsPerGeneration: 10_000_000,
      maxMetadataDepth: 32,
    });
    expect(config).toMatchObject(PROVIDER_INDEX_STORE_DEFAULTS);
    expect((config as unknown as { maxEventJsonBytesPerTask: number })
      .maxEventJsonBytesPerTask).toBe(67_108_864);
    expect(config.now).toBeTypeOf("function");
    expect(config.tokenFactory).toBeTypeOf("function");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(PROVIDER_INDEX_STORE_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(PROVIDER_INDEX_STORE_HARD_LIMITS)).toBe(true);
    expect(Object.isFrozen(PROVIDER_INDEX_STORE_HARD_LIMITS.stageLeaseMs)).toBe(true);
  });

  it("accepts inclusive hard bounds, explicit undefined, and null-prototype options", () => {
    const now = (): number => 123;
    const tokenFactory = (): string => "owner-token";
    const options = Object.assign(Object.create(null) as ProviderIndexStoreOptions, {
      stageLeaseMs: PROVIDER_INDEX_STORE_HARD_LIMITS.stageLeaseMs.max,
      maxTasksPerGeneration: PROVIDER_INDEX_STORE_HARD_LIMITS.maxTasksPerGeneration,
      maxTurnsPerGeneration: PROVIDER_INDEX_STORE_HARD_LIMITS.maxTurnsPerGeneration,
      maxEventsPerTask: PROVIDER_INDEX_STORE_HARD_LIMITS.maxEventsPerTask,
      maxEventsPerGeneration: PROVIDER_INDEX_STORE_HARD_LIMITS.maxEventsPerGeneration,
      maxMetadataDepth: PROVIDER_INDEX_STORE_HARD_LIMITS.maxMetadataDepth,
      now,
      tokenFactory,
    });
    const config = normalizeProviderIndexStoreOptions(options);
    expect(config).toMatchObject(options);
    expect(config.now).toBe(now);
    expect(config.tokenFactory).toBe(tokenFactory);

    const withUndefined = normalizeProviderIndexStoreOptions({
      stageLeaseMs: undefined,
      maxEventsPerTask: undefined,
      now: undefined,
      tokenFactory: undefined,
    });
    expect(withUndefined.stageLeaseMs).toBe(PROVIDER_INDEX_STORE_DEFAULTS.stageLeaseMs);
    expect(withUndefined.maxEventsPerTask)
      .toBe(PROVIDER_INDEX_STORE_DEFAULTS.maxEventsPerTask);
  });

  it("snapshots own data functions before the caller mutates its options", () => {
    const firstNow = (): number => 1;
    const firstToken = (): string => "first-token";
    const options: { now: () => number; tokenFactory: () => string } = {
      now: firstNow,
      tokenFactory: firstToken,
    };
    const config = normalizeProviderIndexStoreOptions(options);
    options.now = () => 2;
    options.tokenFactory = () => "second-token";

    expect(config.now).toBe(firstNow);
    expect(config.tokenFactory).toBe(firstToken);
    expect(readProviderIndexNow(config)).toBe(1);
    expect(createProviderIndexOwnerToken(config)).toBe("first-token");
  });

  it("does not invoke clock or token callbacks during normalization", () => {
    let calls = 0;
    const config = normalizeProviderIndexStoreOptions({
      now() {
        calls += 1;
        return 1;
      },
      tokenFactory() {
        calls += 1;
        return "owner-token";
      },
    });
    expect(calls).toBe(0);
    expect(readProviderIndexNow(config)).toBe(1);
    expect(createProviderIndexOwnerToken(config)).toBe("owner-token");
    expect(calls).toBe(2);
  });

  it.each([
    { stageLeaseMs: 999 },
    { stageLeaseMs: 300_001 },
    { stageLeaseMs: 1_000.5 },
    { stageLeaseMs: "1000" },
    { maxTasksPerGeneration: 0 },
    { maxTasksPerGeneration: 1_000_001 },
    { maxTurnsPerGeneration: 0 },
    { maxTurnsPerGeneration: 2_000_001 },
    { maxEventsPerTask: 0 },
    { maxEventsPerTask: 1_000_001 },
    { maxEventsPerGeneration: 0 },
    { maxEventsPerGeneration: 10_000_001 },
    { maxMetadataDepth: 0 },
    { maxMetadataDepth: 33 },
    { maxMetadataDepth: "16" },
    { maxEventsPerTask: 10, maxEventsPerGeneration: 9 },
    { now: 123 },
    { tokenFactory: "token" },
  ] as const)("rejects an invalid option without SQL coercion: %#", (options) => {
    expectStoreError(
      () => normalizeProviderIndexStoreOptions(options as unknown as ProviderIndexStoreOptions),
      "INVALID_INPUT",
    );
  });

  it("rejects extra, inherited, symbol, accessor, and throwing-proxy options", () => {
    const inherited = Object.create({ stageLeaseMs: 1_000 }) as ProviderIndexStoreOptions;
    const symbol = { [Symbol("hidden")]: 1 } as ProviderIndexStoreOptions;
    const accessor = Object.defineProperty({}, "stageLeaseMs", {
      enumerable: true,
      get() {
        throw new Error("must-never-leak-accessor");
      },
    }) as ProviderIndexStoreOptions;
    let proxyTrapCalls = 0;
    const proxy = new Proxy({}, {
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("must-never-leak-proxy");
      },
    }) as ProviderIndexStoreOptions;
    for (const value of [
      { unknown: 1 } as unknown as ProviderIndexStoreOptions,
      inherited,
      symbol,
      accessor,
      proxy,
      [] as unknown as ProviderIndexStoreOptions,
    ]) {
      expectStoreError(() => normalizeProviderIndexStoreOptions(value), "INVALID_INPUT");
    }
    expect(proxyTrapCalls).toBe(0);
  });

  it("maps hostile clock and token failures to fixed value-free codes", () => {
    const clockSecret = "must-never-leak-clock";
    const tokenSecret = "must-never-leak-token";
    const clock = normalizeProviderIndexStoreOptions({
      now() {
        throw new Error(clockSecret);
      },
    });
    const token = normalizeProviderIndexStoreOptions({
      tokenFactory() {
        throw new Error(tokenSecret);
      },
    });
    expectStoreError(() => readProviderIndexNow(clock), "CLOCK_FAILURE", clockSecret);
    expectStoreError(() => createProviderIndexOwnerToken(token), "TOKEN_FAILURE", tokenSecret);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, "1"])(
    "rejects an invalid clock result %#",
    (value) => {
      const config = normalizeProviderIndexStoreOptions({ now: () => value as number });
      expectStoreError(() => readProviderIndexNow(config), "CLOCK_FAILURE");
    },
  );

  it.each(["", " token ", "token\u0000value", "x".repeat(513), 1])(
    "rejects an invalid owner token %#",
    (value) => {
      const config = normalizeProviderIndexStoreOptions({
        tokenFactory: () => value as string,
      });
      expectStoreError(() => createProviderIndexOwnerToken(config), "TOKEN_FAILURE");
    },
  );

  it("applies SQLite character bounds to astral owner tokens", () => {
    const accepted = normalizeProviderIndexStoreOptions({
      tokenFactory: () => "🪐".repeat(512),
    });
    expect(createProviderIndexOwnerToken(accepted)).toBe("🪐".repeat(512));
    const rejected = normalizeProviderIndexStoreOptions({
      tokenFactory: () => "🪐".repeat(513),
    });
    expectStoreError(() => createProviderIndexOwnerToken(rejected), "TOKEN_FAILURE");
  });
});

describe("provider task snapshot preparation", () => {
  it("enforces an exact aggregate event JSON budget before rematerializing aliases", () => {
    const alias = eventFor({
      type: "message",
      role: "assistant",
      text: "small aliased event budget",
      turnId: "turn-aggregate-budget",
      itemId: null,
    });
    const eventJsonChars = Array.from(canonicalProviderIndexJson(
      providersIndex.projectIndexedProviderEvent(alias),
    )).length;
    const taskWithCopies = (count: number): NativeTask => nativeTask({
      turns: [{
        id: "turn-aggregate-budget",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: Array.from({ length: count }, () => alias),
      }],
    });
    const configWithBudget = (budget: number) => ({
      ...normalizeProviderIndexStoreOptions(),
      maxEventJsonBytesPerTask: budget,
    });

    expect(prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      taskWithCopies(2),
      configWithBudget(eventJsonChars * 2) as never,
    ).eventCount).toBe(2);
    expectStoreError(
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        taskWithCopies(1),
        configWithBudget(eventJsonChars - 1) as never,
      ),
      "CAPACITY",
    );

    const original = Object.getOwnPropertyDescriptor;
    let textDescriptorReads = 0;
    const descriptor = vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation(
      (target: object, property: PropertyKey) => {
        if (target === alias && property === "text") textDescriptorReads += 1;
        return original(target, property);
      },
    );
    try {
      expectStoreError(
        () => prepareProviderTaskSnapshot(
          registrationFor(),
          key,
          taskWithCopies(3),
          configWithBudget(eventJsonChars * 2) as never,
        ),
        "CAPACITY",
      );
      expect(textDescriptorReads).toBe(2);
    } finally {
      descriptor.mockRestore();
    }
  });

  it("accounts for aggregate canonical event JSON in UTF-8 bytes", () => {
    const event = eventFor({
      type: "message",
      role: "assistant",
      text: "🪐".repeat(64),
      turnId: "turn-aggregate-bytes",
      itemId: null,
    });
    const eventJson = canonicalProviderIndexJson(
      providersIndex.projectIndexedProviderEvent(event),
    );
    const eventJsonBytes = Buffer.byteLength(eventJson, "utf8");
    expect(eventJsonBytes).toBeGreaterThan(Array.from(eventJson).length);
    const taskWithCopies = (count: number): NativeTask => nativeTask({
      turns: [{
        id: "turn-aggregate-bytes",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: Array.from({ length: count }, () => event),
      }],
    });
    const configWithBudget = (budget: number) => ({
      ...normalizeProviderIndexStoreOptions(),
      maxEventJsonBytesPerTask: budget,
    });

    expect(prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      taskWithCopies(2),
      configWithBudget(eventJsonBytes * 2) as never,
    ).eventCount).toBe(2);
    expectStoreError(
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        taskWithCopies(2),
        configWithBudget(eventJsonBytes * 2 - 1) as never,
      ),
      "CAPACITY",
    );
    expect(prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      taskWithCopies(1),
      configWithBudget(eventJsonBytes) as never,
    ).eventCount).toBe(1);
    expectStoreError(
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        taskWithCopies(1),
        configWithBudget(eventJsonBytes - 1) as never,
      ),
      "CAPACITY",
    );
  });

  it("rejects provider-home projection expansion before clone or materialization", () => {
    const rootKey = createNativeTaskKey("openai", "/", "task-root-expansion");
    const event = normalizeProviderEvent({
      type: "message",
      role: "assistant",
      text: "/".repeat(8_388_608),
      turnId: "turn-expansion",
      itemId: null,
    }, {
      provider: "openai",
      key: rootKey,
      occurredAt: OCCURRED_AT,
    });
    const task = nativeTask({
      key: rootKey,
      revision: revision({ lastTurnId: "turn-expansion", lastItemId: null }),
      turns: [{
        id: "turn-expansion",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [event],
      }],
    });
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(rootKey), rootKey, task),
        "INVALID_INPUT",
      );
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }

    const injectiveTask = nativeTask({
      turns: [{
        id: "turn-injective-expansion",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventFor({
          type: "message",
          role: "assistant",
          text: "\ue000".repeat(Math.floor(8_388_608 / 2) + 1),
          turnId: "turn-injective-expansion",
          itemId: null,
        })],
      }],
    });
    const injectiveClone = vi.spyOn(globalThis, "structuredClone");
    try {
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, injectiveTask),
        "INVALID_INPUT",
      );
      expect(injectiveClone).not.toHaveBeenCalled();
    } finally {
      injectiveClone.mockRestore();
    }
  });

  it("projects each persistence event bundle once without cloning its trusted snapshot", () => {
    const task = nativeTask({
      turns: [{
        id: "turn-single-projection",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventFor({
          type: "message",
          role: "assistant",
          text: "single projection",
          turnId: "turn-single-projection",
          itemId: null,
        })],
      }],
    });
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      prepareProviderTaskSnapshot(registrationFor(), key, task);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it("validates method, payload, and registered home ownership before projection", () => {
    const otherTaskKey = createNativeTaskKey("openai", HOME, "task-2");
    const otherHomeKey = createNativeTaskKey("openai", `${HOME}-other`, "task-1");
    const otherProviderKey = createNativeTaskKey("anthropic", HOME, "task-1");
    for (const action of [
      () => prepareProviderTaskSummary(registrationFor(), otherTaskKey, nativeSummary()),
      () => prepareProviderTaskSummary(registrationFor(otherHomeKey), key, nativeSummary()),
      () => prepareProviderTaskSummary(registrationFor(otherProviderKey), key, nativeSummary()),
    ]) {
      expectStoreError(action, "INVALID_INPUT", HOME);
    }
  });

  it("rejects top-level and nested request ownership mismatches before normalization", () => {
    const foreignKey = createNativeTaskKey("openai", HOME, "foreign-task");
    const foreignKeyEvent = {
      ...eventFor({
        type: "message",
        role: "assistant",
        text: "cross-task",
        turnId: "turn-1",
        itemId: "item-1",
      }),
      key: foreignKey,
    } as ProviderEvent;
    const foreignProviderEvent = {
      ...eventFor({
        type: "message",
        role: "assistant",
        text: "cross-provider",
        turnId: "turn-1",
        itemId: "item-1",
      }),
      provider: "anthropic" as const,
    } as ProviderEvent;
    const foreignIdentity = createProviderRequestIdentity({
      key: foreignKey,
      generation: 1,
      turnId: "turn-1",
      requestId: "request-1",
      itemId: "item-1",
      approvalId: null,
    });
    const nested = {
      provider: "openai" as const,
      key,
      occurredAt: OCCURRED_AT,
      type: "request" as const,
      request: { kind: "permission" as const, identity: foreignIdentity },
    };
    const resolved = {
      provider: "openai" as const,
      key,
      occurredAt: OCCURRED_AT,
      type: "request-resolved" as const,
      identity: foreignIdentity,
    };
    for (const hostile of [foreignKeyEvent, foreignProviderEvent, nested, resolved]) {
      const task = nativeTask({
        turns: [{
          id: "turn-1",
          status: "complete",
          startedAt: null,
          completedAt: null,
          events: [hostile],
        }],
      });
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, task),
        "INVALID_INPUT",
        "foreign-task",
      );
    }
  });

  it("rejects accessor, proxy, sparse-array, and noncanonical-path snapshot graphs", () => {
    const accessor = Object.defineProperty(nativeSummary(), "cwd", {
      enumerable: true,
      get() {
        throw new Error("must-never-leak-summary-accessor");
      },
    }) as NativeTaskSummary;
    const proxy = new Proxy(nativeSummary(), {
      ownKeys() {
        throw new Error("must-never-leak-summary-proxy");
      },
    });
    const sparseTurns = Array(1) as unknown as NativeTask["turns"];
    const sparseEvents = Array(1) as unknown as readonly ProviderEvent[];
    const taskWithSparseEvents = nativeTask({
      turns: [{
        id: "turn-1",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: sparseEvents,
      }],
    });
    for (const action of [
      () => prepareProviderTaskSummary(registrationFor(), key, accessor),
      () => prepareProviderTaskSummary(registrationFor(), key, proxy),
      () => prepareProviderTaskSummary(
        registrationFor(),
        key,
        nativeSummary({ cwd: "relative/project" }),
      ),
      () => prepareProviderTaskSummary(
        registrationFor(),
        key,
        nativeSummary({ cwd: "/tmp/project/../other" }),
      ),
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        nativeTask({ turns: sparseTurns }),
      ),
      () => prepareProviderTaskSnapshot(registrationFor(), key, taskWithSparseEvents),
    ]) {
      expectStoreError(action, "INVALID_INPUT", "must-never-leak");
    }
  });

  it("rejects changing-length array proxies before invoking any proxy trap", () => {
    let trapCalls = 0;
    const turns = new Proxy([], {
      get() {
        trapCalls += 1;
        return trapCalls % 2;
      },
      getPrototypeOf() {
        trapCalls += 1;
        return Array.prototype;
      },
      ownKeys() {
        trapCalls += 1;
        return ["length"];
      },
      getOwnPropertyDescriptor(target, property) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }) as unknown as NativeTask["turns"];
    expectStoreError(
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        nativeTask({ turns }),
      ),
      "INVALID_INPUT",
    );
    expect(trapCalls).toBe(0);
  });

  it("checks turn and remaining-event capacity before any element descriptor", () => {
    const original = Object.getOwnPropertyDescriptor;
    const oversizedTurns = Array(1_000_001) as unknown as NativeTask["turns"];
    let oversizedTurnElementDescriptors = 0;
    const turnOwnKeys = vi.spyOn(Reflect, "ownKeys");
    const turnSpy = vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation(
      (target: object, property: PropertyKey) => {
        if (target === oversizedTurns && property !== "length") {
          oversizedTurnElementDescriptors += 1;
        }
        return original(target, property);
      },
    );
    try {
      expectStoreError(
        () => prepareProviderTaskSnapshot(
          registrationFor(),
          key,
          nativeTask({ turns: oversizedTurns }),
          normalizeProviderIndexStoreOptions({ maxTurnsPerGeneration: 1 }),
        ),
        "CAPACITY",
      );
      expect(oversizedTurnElementDescriptors).toBe(0);
      expect(turnOwnKeys.mock.calls.some(([target]) => target === oversizedTurns)).toBe(false);
    } finally {
      turnSpy.mockRestore();
      turnOwnKeys.mockRestore();
    }

    const oversizedEvents = Array(1) as unknown as readonly ProviderEvent[];
    const task = nativeTask({
      turns: [{
        id: "turn-capacity-first",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventFor({
          type: "message",
          role: "assistant",
          text: "first",
          turnId: "turn-capacity-first",
          itemId: null,
        })],
      }, {
        id: "turn-capacity-overflow",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: oversizedEvents,
      }],
    });
    let oversizedEventElementDescriptors = 0;
    const eventOwnKeys = vi.spyOn(Reflect, "ownKeys");
    const eventSpy = vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation(
      (target: object, property: PropertyKey) => {
        if (target === oversizedEvents && property !== "length") {
          oversizedEventElementDescriptors += 1;
        }
        return original(target, property);
      },
    );
    try {
      expectStoreError(
        () => prepareProviderTaskSnapshot(
          registrationFor(),
          key,
          task,
          normalizeProviderIndexStoreOptions({ maxEventsPerTask: 1 }),
        ),
        "CAPACITY",
      );
      expect(oversizedEventElementDescriptors).toBe(0);
      expect(eventOwnKeys.mock.calls.some(([target]) => target === oversizedEvents)).toBe(false);
    } finally {
      eventSpy.mockRestore();
      eventOwnKeys.mockRestore();
    }
  });

  it("maps every forged public store error from input getters to INVALID_INPUT", () => {
    const codes: readonly ProviderIndexStoreErrorCode[] = [
      "INVALID_INPUT",
      "CORRUPT_ROW",
      "DATABASE_UNAVAILABLE",
      "CLOCK_FAILURE",
      "TOKEN_FAILURE",
      "CAPACITY",
      "UNKNOWN_HOME",
      "HOME_CONFLICT",
      "STAGE_BUSY",
      "STAGE_LOST",
      "STAGE_EXPIRED",
      "STAGE_INCOMPLETE",
      "REPLAY_CONFLICT",
      "FORK_CONFLICT",
      "LEGACY_MAPPING_CONFLICT",
      "RECONCILIATION_CAS_MISMATCH",
    ];
    for (const code of codes) {
      const summary = Object.defineProperty(nativeSummary(), "title", {
        enumerable: true,
        get() {
          throw new ProviderIndexStoreError(code);
        },
      });
      const task = Object.defineProperty(nativeTask(), "title", {
        enumerable: true,
        get() {
          throw new ProviderIndexStoreError(code);
        },
      });
      const summaryProxy = new Proxy(nativeSummary(), {
        getPrototypeOf() {
          throw new ProviderIndexStoreError(code);
        },
      });
      const taskProxy = new Proxy(nativeTask(), {
        getPrototypeOf() {
          throw new ProviderIndexStoreError(code);
        },
      });
      expectStoreError(
        () => prepareProviderTaskSummary(registrationFor(), key, summary),
        "INVALID_INPUT",
      );
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, task),
        "INVALID_INPUT",
      );
      expectStoreError(
        () => prepareProviderTaskSummary(registrationFor(), key, summaryProxy),
        "INVALID_INPUT",
      );
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, taskProxy),
        "INVALID_INPUT",
      );
    }
  });

  it("distinguishes null, contained, and outside canonical cwd values", () => {
    const cases = [
      { cwd: null, expectedCwd: null, cwdRedacted: false },
      { cwd: key.home, expectedCwd: null, cwdRedacted: true },
      { cwd: path.join(key.home, "child"), expectedCwd: null, cwdRedacted: true },
      { cwd: `${key.home}-sibling`, expectedCwd: `${key.home}-sibling`, cwdRedacted: false },
      { cwd: OUTSIDE_CWD, expectedCwd: OUTSIDE_CWD, cwdRedacted: false },
    ] as const;
    for (const current of cases) {
      const prepared = prepareProviderTaskSummary(
        registrationFor(),
        key,
        nativeSummary({ cwd: current.cwd }),
      );
      expect(prepared.cwd).toBe(current.expectedCwd);
      expect(prepared.cwdRedacted).toBe(current.cwdRedacted);
    }

    const rootKey = createNativeTaskKey("openai", path.parse(key.home).root, "task-root");
    const rootPrepared = prepareProviderTaskSummary(
      registrationFor(rootKey),
      rootKey,
      nativeSummary({ key: rootKey, cwd: OUTSIDE_CWD }),
    );
    expect(rootPrepared.cwd).toBeNull();
    expect(rootPrepared.cwdRedacted).toBe(true);
  });

  it("resolves symlinks through the deepest existing ancestor including missing leaves", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-store-codec-"));
    dirs.push(root);
    const home = path.join(root, "home");
    const child = path.join(home, "child");
    const alias = path.join(root, "alias");
    mkdirSync(child, { recursive: true });
    symlinkSync(child, alias);
    const actualKey = createNativeTaskKey("openai", home, "task-symlink");
    const prepared = prepareProviderTaskSummary(
      registrationFor(actualKey),
      actualKey,
      nativeSummary({
        key: actualKey,
        cwd: path.join(alias, "missing", "leaf"),
      }),
    );
    expect(prepared.cwd).toBeNull();
    expect(prepared.cwdRedacted).toBe(true);
  });

  it("prepares global event ordinals, canonical JSON, identities, and fingerprints", () => {
    const prepared = prepareProviderTaskSnapshot(registrationFor(), key, nativeTask());
    expect(prepared.turns.map((turn) => turn.ordinal)).toEqual([0, 1]);
    expect(prepared.turns.flatMap((turn) => turn.events.map((event) => event.ordinal)))
      .toEqual([0, 1, 2]);
    expect(prepared.eventCount).toBe(3);
    expect(prepared.turns.map((turn) => parseCachedTurnKey(turn.nativeTurnKey)))
      .toEqual(["turn-1", "turn-2"]);

    const events = prepared.turns.flatMap((turn) => turn.events);
    expect(parseCachedEventItemKey(events[0]!.nativeItemKey, 0)).toEqual({
      kind: "native",
      nativeItemId: "item-1",
    });
    expect(events[0]!.nativeItemKey).toBe(events[1]!.nativeItemKey);
    expect(events[0]!.replayKey).not.toBe(events[1]!.replayKey);
    expect(parseCachedEventItemKey(events[2]!.nativeItemKey, 2))
      .toEqual({ kind: "synthetic", nativeItemId: null });
    for (const cached of events) {
      expect(parseProviderEventReplayKey(cached.replayKey, cached.ordinal))
        .toBe(cached.replayKey);
      expect(cached.eventJson).toBe(canonicalProviderIndexJson(cached.event));
      expect(cached.eventFingerprint).toBe(createHash("sha256")
        .update(
          `devhub-provider-event-cache:v1\u0000${cached.replayKey}\u0000${cached.eventJson}`,
          "utf8",
        )
        .digest("hex"));
    }
    expect(prepared.snapshotFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(prepared.receiptKey).toMatch(/^snapshot:v1:[0-9a-f]{64}$/u);

    const summaryPayload = [
      prepared.title,
      prepared.cwd,
      prepared.cwdRedacted,
      prepared.model,
      prepared.status,
      prepared.createdAt,
      prepared.updatedAt,
      prepared.archived,
      prepared.source,
      [
        prepared.revision!.updatedAt,
        prepared.revision!.status,
        prepared.revision!.lastTurnId,
        prepared.revision!.lastTurnStatus,
        prepared.revision!.lastItemId,
        prepared.revision!.fingerprint,
      ],
    ];
    const turnPayload = prepared.turns.map((turn) => [
      turn.nativeTurnKey,
      turn.status,
      turn.startedAt,
      turn.completedAt,
      turn.ordinal,
      turn.events.map((event) => [
        event.ordinal,
        event.nativeItemKey,
        event.replayKey,
        event.eventFingerprint,
        event.eventJson,
      ]),
    ]);
    const expectedSnapshot = createHash("sha256")
      .update(`devhub-provider-snapshot:v1\u0000${canonicalProviderIndexJson([
        1,
        providersIndex.serializeTaskLocator(prepared.locator),
        summaryPayload,
        turnPayload,
      ])}`, "utf8")
      .digest("hex");
    expect(prepared.snapshotFingerprint).toBe(expectedSnapshot);
  });

  it("uses source-driven receipt bases for native and fallback snapshots", () => {
    const nativeFirst = prepareProviderTaskSnapshot(registrationFor(), key, nativeTask());
    const nativeChanged = prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      nativeTask({ title: "Changed but same native revision" }),
    );
    expect(nativeChanged.snapshotFingerprint).not.toBe(nativeFirst.snapshotFingerprint);
    expect(nativeChanged.receiptKey).toBe(nativeFirst.receiptKey);

    for (const source of ["legacy-history", "degraded-fallback"] as const) {
      const first = prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        taskWithSource(source, true),
      );
      const changed = prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        taskWithSource(source, true, { title: "Changed fallback snapshot" }),
      );
      expect(changed.snapshotFingerprint).not.toBe(first.snapshotFingerprint);
      expect(changed.receiptKey).not.toBe(first.receiptKey);
    }
  });

  it("rejects native snapshots with absent or invalid revisions", () => {
    const missing = taskWithSource("native", false);
    const invalid = nativeTask({ revision: revision({ fingerprint: "" }) });
    expectStoreError(
      () => prepareProviderTaskSnapshot(registrationFor(), key, missing),
      "INVALID_INPUT",
    );
    expectStoreError(
      () => prepareProviderTaskSnapshot(registrationFor(), key, invalid),
      "INVALID_INPUT",
    );
  });

  it("rejects the registered home in every persisted summary, revision, and turn scalar", () => {
    const homeValue = (label: string): string => `${label}:${HOME}`;
    const summaryCases: readonly NativeTaskSummary[] = [
      nativeSummary({ title: homeValue("title") }),
      nativeSummary({ model: homeValue("model") }),
      nativeSummary({ status: homeValue("status") }),
      nativeSummary({ revision: revision({ status: homeValue("revision-status") }) }),
      nativeSummary({ revision: revision({ lastTurnId: homeValue("last-turn") }) }),
      nativeSummary({ revision: revision({ lastTurnStatus: homeValue("last-turn-status") }) }),
      nativeSummary({ revision: revision({ lastItemId: homeValue("last-item") }) }),
      nativeSummary({ revision: revision({ fingerprint: homeValue("fingerprint") }) }),
    ];
    for (const summary of summaryCases) {
      expectStoreError(
        () => prepareProviderTaskSummary(registrationFor(), key, summary),
        "INVALID_INPUT",
        HOME,
      );
    }

    for (const task of [
      nativeTask({
        turns: [{
          id: homeValue("turn-id"),
          status: "complete",
          startedAt: null,
          completedAt: null,
          events: [],
        }],
      }),
      nativeTask({
        turns: [{
          id: "turn-home-free",
          status: homeValue("turn-status"),
          startedAt: null,
          completedAt: null,
          events: [],
        }],
      }),
    ]) {
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, task),
        "INVALID_INPUT",
        HOME,
      );
    }
  });

  it("never serializes the registered home from accepted prepared scalar output", () => {
    const preparedSummary = prepareProviderTaskSummary(registrationFor(), key, nativeSummary());
    const preparedSnapshot = prepareProviderTaskSnapshot(registrationFor(), key, nativeTask());
    expect(JSON.stringify(preparedSummary)).not.toContain(HOME);
    expect(JSON.stringify(preparedSnapshot)).not.toContain(HOME);
  });

  it("enforces configured turn and per-task event capacity", () => {
    const oneTurn = normalizeProviderIndexStoreOptions({ maxTurnsPerGeneration: 1 });
    const twoEvents = normalizeProviderIndexStoreOptions({ maxEventsPerTask: 2 });
    expectStoreError(
      () => prepareProviderTaskSnapshot(registrationFor(), key, nativeTask(), oneTurn),
      "CAPACITY",
    );
    expectStoreError(
      () => prepareProviderTaskSnapshot(registrationFor(), key, nativeTask(), twoEvents),
      "CAPACITY",
    );
  });

  it("bounds the final canonical event JSON including its persisted envelope", () => {
    const maxEventJsonChars = 8_388_608;
    const eventWithText = (text: string): ProviderEvent => eventFor({
      type: "message",
      role: "assistant",
      text,
      turnId: "turn-sized",
      itemId: null,
    });
    const emptyEventJsonLength = canonicalProviderIndexJson(
      providersIndex.projectIndexedProviderEvent(eventWithText("")),
    ).length;
    const taskWithText = (text: string): NativeTask => nativeTask({
      turns: [{
        id: "turn-sized",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventWithText(text)],
      }],
    });

    const atLimit = prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      taskWithText("x".repeat(maxEventJsonChars - emptyEventJsonLength)),
    );
    expect(atLimit.turns[0]!.events[0]!.eventJson).toHaveLength(maxEventJsonChars);
    expectStoreError(
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        taskWithText("x".repeat(maxEventJsonChars - emptyEventJsonLength + 1)),
      ),
      "INVALID_INPUT",
    );

    const combiningAtLimit = "\u0301".repeat(maxEventJsonChars - emptyEventJsonLength);
    const combining = prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      taskWithText(combiningAtLimit),
    );
    expect(Array.from(combining.turns[0]!.events[0]!.eventJson))
      .toHaveLength(maxEventJsonChars);
    expectStoreError(
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        taskWithText(`${combiningAtLimit}\u0301`),
      ),
      "INVALID_INPUT",
    );
  });

  it("uses SQLite Unicode-code-point length for astral persisted event JSON", () => {
    const maxEventJsonChars = 8_388_608;
    const eventWithText = (text: string): ProviderEvent => eventFor({
      type: "message",
      role: "assistant",
      text,
      turnId: "turn-astral",
      itemId: null,
    });
    const emptyEventJson = canonicalProviderIndexJson(
      providersIndex.projectIndexedProviderEvent(eventWithText("")),
    );
    const envelopeSqliteChars = Array.from(emptyEventJson).length;
    const astralText = "🪐".repeat(maxEventJsonChars - envelopeSqliteChars);
    const task = nativeTask({
      turns: [{
        id: "turn-astral",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventWithText(astralText)],
      }],
    });

    const prepared = prepareProviderTaskSnapshot(registrationFor(), key, task);
    const turn = prepared.turns[0]!;
    const cached = turn.events[0]!;
    const eventJson = cached.eventJson;
    expect(eventJson.length).toBeGreaterThan(maxEventJsonChars);
    expect(Array.from(eventJson)).toHaveLength(maxEventJsonChars);
    const decoded = decodeCachedProviderEvent(
      rowFor(cached),
      prepared.locator,
      turn.nativeTurnKey,
      registrationFor(),
    );
    expect(decoded.type).toBe("message");
    if (decoded.type !== "message") throw new Error("expected message event");
    expect(decoded.text.length).toBeGreaterThan(Array.from(decoded.text).length);
  });

  it("rejects write-side event values that the strict decoder cannot accept", () => {
    const invalidEvents: readonly ProviderEvent[] = [
      eventFor({
        type: "message",
        role: "assistant",
        text: "contains\u0000nul",
        turnId: "turn-invalid",
        itemId: null,
      }),
      eventFor({
        type: "message",
        role: "assistant",
        text: "\ud800",
        turnId: "turn-invalid",
        itemId: null,
      }),
      eventFor({
        type: "plan",
        turnId: "turn-invalid",
        itemId: null,
        stepIndex: 0,
        text: "plan",
        status: "p".repeat(513),
      }),
      eventFor({
        type: "activity",
        turnId: "turn-invalid",
        itemId: null,
        activity: "a".repeat(513),
        status: "complete",
        message: null,
      }),
      eventFor({
        type: "activity",
        turnId: "turn-invalid",
        itemId: null,
        activity: "command",
        status: "s".repeat(513),
        message: null,
      }),
      eventFor({
        type: "status",
        scope: "turn",
        status: "s".repeat(513),
        nativeId: "turn-invalid",
      }),
      {
        provider: "openai",
        key,
        occurredAt: OCCURRED_AT,
        type: "diagnostic",
        level: "warning",
        code: "DIAGNOSTIC",
        message: "d".repeat(513),
        method: null,
        shapeKeys: [],
      },
    ];
    for (const invalidEvent of invalidEvents) {
      const task = nativeTask({
        turns: [{
          id: "turn-invalid",
          status: "complete",
          startedAt: null,
          completedAt: null,
          events: [invalidEvent],
        }],
      });
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, task),
        "INVALID_INPUT",
      );
    }
  });

  it("round-trips diagnostic limits with SQLite code-point semantics", () => {
    type Diagnostic = Extract<ProviderEvent, { type: "diagnostic" }>;
    const diagnosticTask = (overrides: Partial<Diagnostic>): NativeTask => nativeTask({
      turns: [{
        id: "turn-diagnostic-unicode",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [{
          provider: "openai",
          key,
          occurredAt: OCCURRED_AT,
          type: "diagnostic",
          level: "warning",
          code: "DIAGNOSTIC_UNICODE",
          message: "diagnostic unicode",
          method: null,
          shapeKeys: [],
          ...overrides,
        }],
      }],
    });
    const validCases: readonly Partial<Diagnostic>[] = [
      { message: "🪐".repeat(512) },
      { message: "\u0301".repeat(512) },
      { code: "🪐".repeat(128) },
      { method: "🪐".repeat(256) },
      { shapeKeys: ["🪐".repeat(64)] },
    ];
    for (const overrides of validCases) {
      const prepared = prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        diagnosticTask(overrides),
      );
      const turn = prepared.turns[0]!;
      const cached = turn.events[0]!;
      const decoded = decodeCachedProviderEvent(
        rowFor(cached),
        prepared.locator,
        turn.nativeTurnKey,
        registrationFor(),
      );
      expect(decoded.type).toBe("diagnostic");
      if (decoded.type !== "diagnostic") throw new Error("expected diagnostic");
      for (const [field, value] of Object.entries(overrides)) {
        expect(decoded[field as keyof typeof decoded]).toEqual(value);
      }
    }
    const invalidCases: readonly Partial<Diagnostic>[] = [
      { message: `${"🪐".repeat(512)}🪐` },
      { message: `${"\u0301".repeat(512)}\u0301` },
      { message: "\ud800" },
      { code: "🪐".repeat(129) },
      { method: "🪐".repeat(257) },
      { shapeKeys: ["🪐".repeat(65)] },
    ];
    for (const overrides of invalidCases) {
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, diagnosticTask(overrides)),
        "INVALID_INPUT",
      );
    }
  });

  it("snapshots nested event data descriptors without invoking getters or proxy gets", () => {
    const identity = createProviderRequestIdentity({
      key,
      generation: 1,
      turnId: "turn-safe-graph",
      requestId: "request-safe-graph",
      itemId: null,
      approvalId: null,
    });
    let getterCalls = 0;
    const accessorIdentity = Object.defineProperty({ ...identity }, "requestId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "request-accessor";
      },
    });
    const proxyIdentity = new Proxy({ ...identity }, {
      get() {
        getterCalls += 1;
        throw new Error("must-never-leak-nested-proxy-get");
      },
      getPrototypeOf() {
        throw new Error("must-never-leak-nested-proxy-prototype");
      },
    });
    const symbolIdentity = { ...identity, [Symbol("hidden")]: true };
    const sparseShapeKeys = Array(1);
    const accessorShapeKeys = Object.defineProperty([], "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "shape";
      },
    });
    Object.defineProperty(accessorShapeKeys, "length", { value: 1 });
    const hostileEvents: readonly ProviderEvent[] = [
      {
        provider: "openai",
        key,
        occurredAt: OCCURRED_AT,
        type: "request",
        request: { kind: "permission", identity: accessorIdentity as never },
      },
      {
        provider: "openai",
        key,
        occurredAt: OCCURRED_AT,
        type: "request",
        request: { kind: "permission", identity: proxyIdentity as never },
      },
      {
        provider: "openai",
        key,
        occurredAt: OCCURRED_AT,
        type: "request",
        request: { kind: "permission", identity: symbolIdentity as never },
      },
      {
        provider: "openai",
        key,
        occurredAt: OCCURRED_AT,
        type: "diagnostic",
        level: "warning",
        code: "SPARSE",
        message: "sparse",
        method: null,
        shapeKeys: sparseShapeKeys as never,
      },
      {
        provider: "openai",
        key,
        occurredAt: OCCURRED_AT,
        type: "diagnostic",
        level: "warning",
        code: "ACCESSOR",
        message: "accessor",
        method: null,
        shapeKeys: accessorShapeKeys as never,
      },
    ];
    for (const event of hostileEvents) {
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, nativeTask({
          turns: [{
            id: "turn-safe-graph",
            status: "complete",
            startedAt: null,
            completedAt: null,
            events: [event],
          }],
        })),
        "INVALID_INPUT",
        "must-never-leak",
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects over-depth and aggregate-oversized raw event graphs before cloning", () => {
    let getterCalls = 0;
    let nested: Record<string, unknown> = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-never-leak-deep-getter";
      },
    });
    for (let index = 0; index < 64; index += 1) nested = { nested };
    const tooDeep = {
      ...eventFor({
        type: "message",
        role: "assistant",
        text: "depth",
        turnId: "turn-depth",
        itemId: null,
      }),
      untrusted: nested,
    } as ProviderEvent;
    expectStoreError(
      () => prepareProviderTaskSnapshot(registrationFor(), key, nativeTask({
        turns: [{
          id: "turn-depth",
          status: "complete",
          startedAt: null,
          completedAt: null,
          events: [tooDeep],
        }],
      })),
      "INVALID_INPUT",
      "must-never-leak",
    );
    expect(getterCalls).toBe(0);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const untrusted of [cycle, new Date(0)]) {
      const event = {
        ...eventFor({
          type: "message",
          role: "assistant",
          text: "unbounded",
          turnId: "turn-unbounded",
          itemId: null,
        }),
        untrusted,
      } as ProviderEvent;
      expectStoreError(
        () => prepareProviderTaskSnapshot(registrationFor(), key, nativeTask({
          turns: [{
            id: "turn-unbounded",
            status: "complete",
            startedAt: null,
            completedAt: null,
            events: [event],
          }],
        })),
        "INVALID_INPUT",
      );
    }

    const oversized = eventFor({
      type: "message",
      role: "assistant",
      text: "x".repeat(8_388_609),
      turnId: "turn-oversized",
      itemId: null,
    });
    expectStoreError(
      () => prepareProviderTaskSnapshot(registrationFor(), key, nativeTask({
        turns: [{
          id: "turn-oversized",
          status: "complete",
          startedAt: null,
          completedAt: null,
          events: [oversized],
        }],
      })),
      "INVALID_INPUT",
    );
  });

  it("rejects oversized multibyte native cache keys before snapshot persistence", () => {
    const withinBound = "界".repeat(253);
    const beyondBound = "界".repeat(254);
    const snapshotWithIds = (turnId: string, itemId: string): NativeTask => nativeTask({
      turns: [{
        id: turnId,
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventFor({
          type: "message-delta",
          role: "assistant",
          delta: "cache key bounds",
          turnId,
          itemId,
        })],
      }],
    });

    const accepted = prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      snapshotWithIds(withinBound, withinBound),
    );
    expect(accepted.turns[0]!.nativeTurnKey.length).toBeLessThanOrEqual(1_024);
    expect(accepted.turns[0]!.events[0]!.nativeItemKey.length).toBeLessThanOrEqual(1_024);
    expectStoreError(
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        snapshotWithIds(beyondBound, withinBound),
      ),
      "INVALID_INPUT",
    );
    expectStoreError(
      () => prepareProviderTaskSnapshot(
        registrationFor(),
        key,
        snapshotWithIds(withinBound, beyondBound),
      ),
      "INVALID_INPUT",
    );
  });

  it("keeps raw-home and literal marker snapshots path-free but injectively distinct", () => {
    const withText = (text: string): NativeTask => nativeTask({
      turns: [{
        id: "turn-1",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventFor({
          type: "message",
          role: "assistant",
          text,
          turnId: "turn-1",
          itemId: null,
        })],
      }],
    });
    const raw = prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      withText(`prefix ${key.home} suffix`),
    );
    const marker = prepareProviderTaskSnapshot(
      registrationFor(),
      key,
      withText("prefix [PROVIDER_HOME] suffix"),
    );
    expect(raw.turns[0]!.events[0]!.eventJson)
      .toBe(marker.turns[0]!.events[0]!.eventJson);
    expect(raw.turns[0]!.events[0]!.replayKey)
      .not.toBe(marker.turns[0]!.events[0]!.replayKey);
    expect(raw.snapshotFingerprint).not.toBe(marker.snapshotFingerprint);
    expect([raw.snapshotFingerprint, marker.snapshotFingerprint]).toEqual([
      "219a5e6df7c6c614407ab3a7bbdde4cf940abf30e56c33720fd54d7841ba4af5",
      "1e59d0deb260100e680d7d7aec4be1b13df2423ffc18b5220254e9ca9fc36375",
    ]);
    expect(JSON.stringify(raw)).not.toContain(key.home);
    expect(JSON.stringify(marker)).not.toContain(key.home);
  });

  it("returns recursively immutable prepared snapshots", () => {
    const prepared = prepareProviderTaskSnapshot(registrationFor(), key, nativeTask());
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.locator)).toBe(true);
    expect(Object.isFrozen(prepared.revision)).toBe(true);
    expect(Object.isFrozen(prepared.turns)).toBe(true);
    expect(Object.isFrozen(prepared.turns[0])).toBe(true);
    expect(Object.isFrozen(prepared.turns[0]!.events)).toBe(true);
    expect(Object.isFrozen(prepared.turns[0]!.events[0])).toBe(true);
    expect(Object.isFrozen(prepared.turns[0]!.events[0]!.event)).toBe(true);
  });

  it("binds opaque replay digests through prepared snapshot hashing", () => {
    const prepared = prepareProviderTaskSnapshot(registrationFor(), key, nativeTask());
    const changed = prepareProviderTaskSnapshot(registrationFor(), key, nativeTask({
      turns: [{
        id: "turn-1",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventFor({
          type: "message",
          role: "assistant",
          text: "changed replay projection",
          turnId: "turn-1",
          itemId: null,
        })],
      }],
    }));
    expect(changed.turns[0]!.events[0]!.replayKey)
      .not.toBe(prepared.turns[0]!.events[0]!.replayKey);
    expect(changed.snapshotFingerprint).not.toBe(prepared.snapshotFingerprint);
    expect(changed.receiptKey).toBe(prepared.receiptKey);
  });
});

describe("cached indexed provider event decoding", () => {
  const fullIdentity = createProviderRequestIdentity({
    key,
    generation: 7,
    turnId: "turn-all",
    requestId: "request-1",
    itemId: "request-item-1",
    approvalId: 9,
  });
  const nullIdentity = createProviderRequestIdentity({
    key,
    generation: null,
    turnId: null,
    requestId: 1,
    itemId: null,
    approvalId: null,
  });

  const exhaustiveEvents = (): readonly ProviderEvent[] => [
    eventFor({
      type: "message",
      role: "assistant",
      text: "message",
      turnId: "turn-all",
      itemId: "message-item",
    }),
    eventFor({
      type: "message-delta",
      role: "assistant",
      delta: "delta",
      turnId: "turn-all",
      itemId: null,
    }),
    eventFor({
      type: "plan",
      turnId: "turn-all",
      itemId: "plan-item",
      stepIndex: 0,
      text: "plan",
      status: "in_progress",
    }),
    eventFor({
      type: "activity",
      turnId: "turn-all",
      itemId: "activity-item",
      activity: "command",
      status: "complete",
      message: null,
    }),
    eventFor({
      type: "diff-summary",
      turnId: "turn-all",
      changedFiles: 1,
      additions: 2,
      deletions: 3,
    }),
    eventFor({
      type: "usage",
      turnId: "turn-all",
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 3,
      totalTokens: 6,
    }),
    eventFor({
      type: "status",
      scope: "item",
      status: "running",
      nativeId: "status-item",
    }),
    eventFor({
      type: "request",
      request: { kind: "command-approval", identity: fullIdentity },
    }),
    eventFor({
      type: "request",
      request: { kind: "file-change-approval", identity: fullIdentity },
    }),
    eventFor({
      type: "request",
      request: { kind: "mcp-elicitation", identity: fullIdentity },
    }),
    eventFor({
      type: "request",
      request: { kind: "permission", identity: nullIdentity },
    }),
    eventFor({
      type: "request",
      request: { kind: "user-input", identity: fullIdentity, autoResolutionMs: 60_000 },
    }),
    eventFor({ type: "request-resolved", identity: fullIdentity }),
    eventFor({ futureProviderShape: "diagnostic" }),
  ];

  const exhaustiveSnapshot = () => prepareProviderTaskSnapshot(
    registrationFor(),
    key,
    nativeTask({
      turns: [{
        id: "turn-all",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: exhaustiveEvents(),
      }],
    }),
  );

  it("round-trips all ten event variants and all five request kinds", () => {
    const prepared = exhaustiveSnapshot();
    const turn = prepared.turns[0]!;
    expect(turn.events).toHaveLength(14);
    expect(new Set(turn.events.map((event) => event.event.type))).toEqual(new Set([
      "message",
      "message-delta",
      "plan",
      "activity",
      "diff-summary",
      "usage",
      "status",
      "request",
      "request-resolved",
      "diagnostic",
    ]));
    const requestKinds: string[] = [];
    for (const cached of turn.events) {
      const decoded = decodeCachedProviderEvent(
        rowFor(cached),
        prepared.locator,
        turn.nativeTurnKey,
        registrationFor(),
      );
      expect(decoded).toEqual(cached.event);
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.locator)).toBe(true);
      if (decoded.type === "request") {
        requestKinds.push(decoded.request.kind);
        expect(Object.isFrozen(decoded.request)).toBe(true);
        expect(Object.isFrozen(decoded.request.identity)).toBe(true);
      }
      if (decoded.type === "diagnostic") {
        expect(Object.isFrozen(decoded.shapeKeys)).toBe(true);
      }
    }
    expect(requestKinds).toEqual([
      "command-approval",
      "file-change-approval",
      "mcp-elicitation",
      "permission",
      "user-input",
    ]);
  });

  it("round-trips negative safe-integer JSON-RPC request and approval ids", () => {
    const identity = createProviderRequestIdentity({
      key,
      generation: 7,
      turnId: "turn-negative-id",
      requestId: Number.MIN_SAFE_INTEGER,
      itemId: "request-item-negative-id",
      approvalId: -1,
    });
    const task = nativeTask({
      turns: [{
        id: "turn-negative-id",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [eventFor({
          type: "request",
          request: { kind: "command-approval", identity },
        })],
      }],
    });
    const prepared = prepareProviderTaskSnapshot(registrationFor(), key, task);
    const cached = prepared.turns[0]!.events[0]!;

    const decoded = decodeCachedProviderEvent(
      rowFor(cached),
      prepared.locator,
      prepared.turns[0]!.nativeTurnKey,
      registrationFor(),
    );
    expect(decoded.type).toBe("request");
    if (decoded.type !== "request") throw new Error("expected request event");
    expect(decoded.request.identity.requestId).toBe(Number.MIN_SAFE_INTEGER);
    expect(decoded.request.identity.approvalId).toBe(-1);
  });

  it("requires registered-home context and enforces writer-equivalent decoded text", () => {
    const prepared = exhaustiveSnapshot();
    const turn = prepared.turns[0]!;
    const cachedByType = (type: string) => turn.events.find(
      (candidate) => candidate.event.type === type,
    )!;
    const decodeMutation = (
      cached: ReturnType<typeof cachedByType>,
      mutate: (event: Record<string, unknown>) => Record<string, unknown>,
      containingTurnKey = turn.nativeTurnKey,
    ) => decodeCachedProviderEvent(
      withEventJson(rowFor(cached), mutate(JSON.parse(cached.eventJson) as Record<string, unknown>)),
      prepared.locator,
      containingTurnKey,
      registrationFor(),
    );

    const freeTextMutations: readonly [string, (event: Record<string, unknown>) => Record<string, unknown>][] = [
      ["message", (event) => ({ ...event, text: HOME })],
      ["message-delta", (event) => ({ ...event, delta: HOME })],
      ["plan", (event) => ({ ...event, text: HOME })],
      ["plan", (event) => ({ ...event, status: HOME })],
      ["activity", (event) => ({ ...event, activity: HOME })],
      ["activity", (event) => ({ ...event, status: HOME })],
      ["activity", (event) => ({ ...event, message: HOME })],
      ["status", (event) => ({ ...event, status: HOME })],
      ["diagnostic", (event) => ({ ...event, code: HOME })],
      ["diagnostic", (event) => ({ ...event, message: HOME })],
      ["diagnostic", (event) => ({ ...event, method: HOME })],
      ["diagnostic", (event) => ({ ...event, shapeKeys: [HOME] })],
    ];
    for (const [type, mutate] of freeTextMutations) {
      expectStoreError(
        () => decodeMutation(cachedByType(type), mutate),
        "CORRUPT_ROW",
        HOME,
      );
    }
    expectStoreError(
      () => decodeMutation(cachedByType("message"), (event) => ({
        ...event,
        text: "Bearer abcdefghijklmnop",
      })),
      "CORRUPT_ROW",
      "abcdefghijklmnop",
    );

    for (const [type, mutate] of [
      ["plan", (event: Record<string, unknown>) => ({ ...event, status: "" })],
      ["plan", (event: Record<string, unknown>) => ({ ...event, status: "   " })],
      ["activity", (event: Record<string, unknown>) => ({ ...event, activity: "" })],
      ["activity", (event: Record<string, unknown>) => ({ ...event, status: "   " })],
      ["status", (event: Record<string, unknown>) => ({ ...event, status: "" })],
      ["diagnostic", (event: Record<string, unknown>) => ({ ...event, code: "" })],
      ["diagnostic", (event: Record<string, unknown>) => ({ ...event, message: "" })],
    ] as const) {
      expectStoreError(
        () => decodeMutation(cachedByType(type), mutate),
        "CORRUPT_ROW",
      );
    }

    const planWithWhitespace = decodeMutation(cachedByType("plan"), (event) => ({
      ...event,
      status: "  in_progress  ",
    }));
    expect(planWithWhitespace.type).toBe("plan");
    if (planWithWhitespace.type !== "plan") throw new Error("expected plan");
    expect(planWithWhitespace.status).toBe("  in_progress  ");
    const diagnosticWithEmptyOptional = decodeMutation(
      cachedByType("diagnostic"),
      (event) => ({ ...event, method: "", shapeKeys: [""] }),
    );
    expect(diagnosticWithEmptyOptional.type).toBe("diagnostic");
    if (diagnosticWithEmptyOptional.type !== "diagnostic") {
      throw new Error("expected diagnostic");
    }
    expect(diagnosticWithEmptyOptional.method).toBe("");
    expect(diagnosticWithEmptyOptional.shapeKeys).toEqual([""]);

    const message = cachedByType("message");
    const messageEvent = JSON.parse(message.eventJson) as Record<string, unknown>;
    const homeTurnKey = cachedTurnKey(HOME);
    expectStoreError(
      () => decodeCachedProviderEvent(
        withEventJson({ ...rowFor(message), native_turn_key: homeTurnKey }, {
          ...messageEvent,
          turnId: HOME,
        }),
        prepared.locator,
        homeTurnKey,
        registrationFor(),
      ),
      "CORRUPT_ROW",
      HOME,
    );
    const request = cachedByType("request");
    expectStoreError(
      () => decodeMutation(request, (event) => ({
        ...event,
        request: {
          ...(event.request as Record<string, unknown>),
          identity: {
            ...((event.request as Record<string, unknown>).identity as Record<string, unknown>),
            requestId: HOME,
          },
        },
      })),
      "CORRUPT_ROW",
      HOME,
    );
    expectStoreError(
      () => decodeMutation(request, (event) => ({
        ...event,
        request: {
          ...(event.request as Record<string, unknown>),
          identity: {
            ...((event.request as Record<string, unknown>).identity as Record<string, unknown>),
            requestId: null,
          },
        },
      })),
      "CORRUPT_ROW",
    );

    const otherHomeKey = createNativeTaskKey("openai", `${HOME}-other`, "task-1");
    expectStoreError(
      () => decodeCachedProviderEvent(
        rowFor(message),
        prepared.locator,
        turn.nativeTurnKey,
        registrationFor(otherHomeKey),
      ),
      "CORRUPT_ROW",
    );
  });

  it("rejects independent row identity and fingerprint mutations", () => {
    const prepared = exhaustiveSnapshot();
    const turn = prepared.turns[0]!;
    const cached = turn.events[0]!;
    const row = rowFor(cached);
    const mutations = [
      { ...row, provider: "anthropic" },
      { ...row, home_fingerprint: "b".repeat(64) },
      { ...row, native_task_id: "other-task" },
      { ...row, native_turn_key: "native:v1:b3RoZXItdHVybg" },
      { ...row, native_item_key: "native:v1:b3RoZXItaXRlbQ" },
      { ...row, replay_key: `replay:v1:0:${"f".repeat(64)}` },
      { ...row, ordinal: 1 },
      { ...row, event_fingerprint: "f".repeat(64) },
      { ...row, event_json: `${row.event_json} ` },
    ];
    for (const mutation of mutations) {
      expectStoreError(
        () => decodeCachedProviderEvent(
          mutation,
          prepared.locator,
          turn.nativeTurnKey,
          registrationFor(),
        ),
        "CORRUPT_ROW",
      );
    }
  });

  it("rejects exact-union, locator, turn, item, timestamp, and numeric JSON corruption", () => {
    const prepared = exhaustiveSnapshot();
    const turn = prepared.turns[0]!;
    const cached = turn.events[0]!;
    const row = rowFor(cached);
    const event = JSON.parse(cached.eventJson) as Record<string, unknown>;
    const corruptEvents = [
      { ...event, extra: true },
      Object.fromEntries(Object.entries(event).filter(([key]) => key !== "role")),
      { ...event, role: "tool" },
      { ...event, provider: "anthropic" },
      { ...event, locator: { ...(event.locator as object), nativeTaskId: "other-task" } },
      { ...event, occurredAt: "2026-07-13T21:00:00Z" },
      { ...event, turnId: "other-turn" },
      { ...event, itemId: "other-item" },
    ];
    for (const corrupt of corruptEvents) {
      expectStoreError(
        () => decodeCachedProviderEvent(
          withEventJson(row, corrupt),
          prepared.locator,
          turn.nativeTurnKey,
          registrationFor(),
        ),
        "CORRUPT_ROW",
      );
    }

    const usage = turn.events.find((candidate) => candidate.event.type === "usage")!;
    const usageEvent = JSON.parse(usage.eventJson) as Record<string, unknown>;
    expectStoreError(
      () => decodeCachedProviderEvent(
        withEventJson(rowFor(usage), { ...usageEvent, totalTokens: 1.5 }),
        prepared.locator,
        turn.nativeTurnKey,
        registrationFor(),
      ),
      "CORRUPT_ROW",
    );
  });

  it("rejects noncanonical JSON encodings even with a matching row fingerprint", () => {
    const prepared = exhaustiveSnapshot();
    const turn = prepared.turns[0]!;
    const cached = turn.events[0]!;
    const row = rowFor(cached);
    const alternate = cached.eventJson.replace("message", "\\u006dessage");
    const whitespace = ` ${cached.eventJson}`;
    const duplicate = cached.eventJson.replace(
      '"type":"message"',
      '"type":"message","type":"message"',
    );
    for (const eventJson of [alternate, whitespace, duplicate, '"\ud800"']) {
      expectStoreError(
        () => decodeCachedProviderEvent({
          ...row,
          event_json: eventJson,
          event_fingerprint: eventFingerprint(row.replay_key as string, eventJson),
        }, prepared.locator, turn.nativeTurnKey, registrationFor()),
        "CORRUPT_ROW",
      );
    }
  });

  it("rejects none turn rows, extra/accessor fields, and hostile proxies value-free", () => {
    const prepared = exhaustiveSnapshot();
    const turn = prepared.turns[0]!;
    const row = rowFor(turn.events[0]!);
    const accessor = Object.defineProperty({ ...row }, "event_json", {
      enumerable: true,
      get() {
        throw new Error("must-never-leak-row-accessor");
      },
    });
    const proxy = new Proxy(row, {
      ownKeys() {
        throw new Error("must-never-leak-row-proxy");
      },
    });
    for (const corrupt of [
      { ...row, native_turn_key: "none:v1" },
      { ...row, extra: true },
      accessor,
      proxy,
    ]) {
      expectStoreError(
        () => decodeCachedProviderEvent(
          corrupt as ReturnType<typeof rowFor>,
          prepared.locator,
          turn.nativeTurnKey,
          registrationFor(),
        ),
        "CORRUPT_ROW",
        "must-never-leak",
      );
    }
  });
});
