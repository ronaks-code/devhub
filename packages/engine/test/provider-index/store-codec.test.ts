import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  providerTaskSnapshotFingerprint,
  providerTaskSnapshotReceiptKey,
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
    const proxy = new Proxy({}, {
      ownKeys() {
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
});

describe("provider task snapshot preparation", () => {
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

  it("binds opaque replay digests through the snapshot hash with value-free helpers", () => {
    const prepared = prepareProviderTaskSnapshot(registrationFor(), key, nativeTask());
    expect(providerTaskSnapshotFingerprint(prepared, prepared.turns))
      .toBe(prepared.snapshotFingerprint);
    expect(providerTaskSnapshotReceiptKey(prepared, prepared.snapshotFingerprint))
      .toBe(prepared.receiptKey);

    const firstTurn = prepared.turns[0]!;
    const firstEvent = firstTurn.events[0]!;
    const replayKey = `replay:v1:0:${"f".repeat(64)}`;
    const eventFingerprintValue = eventFingerprint(replayKey, firstEvent.eventJson);
    const changedTurns = [
      {
        ...firstTurn,
        events: [{
          ...firstEvent,
          replayKey,
          eventFingerprint: eventFingerprintValue,
        }, ...firstTurn.events.slice(1)],
      },
      ...prepared.turns.slice(1),
    ];
    expect(providerTaskSnapshotFingerprint(prepared, changedTurns))
      .not.toBe(prepared.snapshotFingerprint);

    const secret = "must-never-leak-snapshot-helper";
    const hostile = new Proxy(prepared, {
      get() {
        throw new Error(secret);
      },
    });
    expectStoreError(
      () => providerTaskSnapshotFingerprint(hostile, prepared.turns),
      "INVALID_INPUT",
      secret,
    );
    expectStoreError(
      () => providerTaskSnapshotReceiptKey(prepared, "not-a-snapshot-fingerprint"),
      "INVALID_INPUT",
    );
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
    );
    expect(decoded.type).toBe("request");
    if (decoded.type !== "request") throw new Error("expected request event");
    expect(decoded.request.identity.requestId).toBe(Number.MIN_SAFE_INTEGER);
    expect(decoded.request.identity.approvalId).toBe(-1);
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
        () => decodeCachedProviderEvent(mutation, prepared.locator, turn.nativeTurnKey),
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
        }, prepared.locator, turn.nativeTurnKey),
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
        ),
        "CORRUPT_ROW",
        "must-never-leak",
      );
    }
  });
});
