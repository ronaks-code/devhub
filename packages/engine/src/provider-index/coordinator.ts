import { types as utilTypes } from "node:util";
import { MAX_PROVIDER_HOME_CHARS } from "../providers/native-id.js";
import { canonicalizeProviderHome } from "../providers/task-key.js";
import type {
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
  ProviderId,
} from "../providers/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { isProviderRegistryInstance } from "../providers/registry-instance.js";
import { ProviderOperationError } from "../providers/operation-error.js";
import {
  ProviderTaskIndexStore,
  isProviderTaskIndexStoreInstance,
} from "./store.js";
import {
  projectNativeTaskSnapshotForIndex,
  projectNativeTaskSummaryForIndex,
} from "./store-codec.js";
import {
  serializeTaskLocator,
  taskLocator,
  type ProviderTaskLocator,
} from "./identity.js";
import { ProviderIndexStoreError } from "./store-types.js";
import type {
  IndexedProviderTask,
  IndexedProviderTaskSummary,
  ProviderHomeRegistration,
  ProviderIndexRegisteredHome,
  VerifiedLegacySessionResolution,
} from "./store-types.js";
import { hasCanonicalUnicode, sqliteTextLengthAtMost } from "./text-boundary.js";

export const PROVIDER_INDEX_COORDINATOR_DEFAULTS = Object.freeze({
  pageSize: 200,
  maxPages: 5_000,
  maxUniqueTasks: 100_000,
  maxRebuildMs: 900_000,
  maxObservationOperations: 256,
});

export const PROVIDER_INDEX_COORDINATOR_HARD_LIMITS = Object.freeze({
  pageSize: 200,
  maxPages: 5_000,
  maxUniqueTasks: 1_000_000,
  maxRebuildMs: 3_600_000,
  maxObservationOperations: 1_024,
});

export interface ProviderTaskIndexCoordinatorOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxUniqueTasks?: number;
  readonly maxRebuildMs?: number;
  readonly maxObservationOperations?: number;
}

export interface ProviderTaskIndexCoordinatorClock {
  readonly now: () => number;
}

export interface ProviderTaskIndexCoordinatorTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface ConfiguredProviderHome {
  readonly provider: ProviderId;
  readonly home: string;
}

export type ProviderTaskIndexCoordinatorErrorCode =
  | "INVALID_INPUT"
  | "CAPACITY"
  | "CLOCK_FAILURE"
  | "REBUILD_BUSY"
  | "REBUILD_TIMEOUT"
  | "CANCELLED"
  | "STALE_OBSERVATION";

const COORDINATOR_ERROR_MESSAGES: Readonly<
  Record<ProviderTaskIndexCoordinatorErrorCode, string>
> = Object.freeze({
  INVALID_INPUT: "Provider task index coordinator input is invalid",
  CAPACITY: "Provider task index coordinator capacity was exceeded",
  CLOCK_FAILURE: "Provider task index coordinator clock failed",
  REBUILD_BUSY: "Provider task index coordinator rebuild is busy",
  REBUILD_TIMEOUT: "Provider task index coordinator rebuild timed out",
  CANCELLED: "Provider task index coordinator operation was cancelled",
  STALE_OBSERVATION: "Provider task index coordinator observation is stale",
});

export class ProviderTaskIndexCoordinatorError extends Error {
  readonly code: ProviderTaskIndexCoordinatorErrorCode;

  constructor(code: ProviderTaskIndexCoordinatorErrorCode) {
    super(COORDINATOR_ERROR_MESSAGES[code]);
    this.name = "ProviderTaskIndexCoordinatorError";
    this.code = code;
  }
}

interface NormalizedCoordinatorOptions {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly maxUniqueTasks: number;
  readonly maxRebuildMs: number;
  readonly maxObservationOperations: number;
}

interface NormalizedConfiguredProviderHome extends ConfiguredProviderHome {}

export interface ProviderTaskIndexCoordinatorFactoryInput {
  readonly registry: ProviderRegistry;
  readonly store: ProviderTaskIndexStore;
  readonly registeredHomes: readonly ConfiguredProviderHome[];
  readonly clock: ProviderTaskIndexCoordinatorClock;
  readonly timers?: ProviderTaskIndexCoordinatorTimers;
  readonly options?: ProviderTaskIndexCoordinatorOptions;
}

export type ProviderTaskReadThroughProjection = "summary" | "snapshot";

export interface ProviderTaskReadThroughInput {
  readonly locator: ProviderTaskLocator;
  readonly projection: ProviderTaskReadThroughProjection;
  readonly allowDegradedCache: boolean;
}

export type ProviderTaskReadThrough =
  | Readonly<{
      freshness: "native" | "cache";
      projection: "summary";
      task: Readonly<IndexedProviderTaskSummary>;
    }>
  | Readonly<{
      freshness: "native" | "cache";
      projection: "snapshot";
      task: Readonly<IndexedProviderTask>;
    }>
  | Readonly<{ freshness: "missing"; locator: ProviderTaskLocator }>;

const OPTION_KEYS = [
  "pageSize",
  "maxPages",
  "maxUniqueTasks",
  "maxRebuildMs",
  "maxObservationOperations",
] as const;

const COORDINATOR_CONSTRUCTION = Symbol("ProviderTaskIndexCoordinator construction");
const MAX_CONFIGURED_PROVIDER_HOMES = 1_024;

function fail(code: ProviderTaskIndexCoordinatorErrorCode): never {
  throw new ProviderTaskIndexCoordinatorError(code);
}

function exactOwnData(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) fail("INVALID_INPUT");
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail("INVALID_INPUT");
  }
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_INPUT");
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return fail("INVALID_INPUT");
  }
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    [...required].some((key) => !keys.includes(key))) fail("INVALID_INPUT");
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return fail("INVALID_INPUT");
    }
    if (descriptor === undefined || !("value" in descriptor)) fail("INVALID_INPUT");
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function safeBoundedInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > maximum) fail("INVALID_INPUT");
  return value;
}

function normalizeOptions(value: unknown): Readonly<NormalizedCoordinatorOptions> {
  if (value === undefined) return PROVIDER_INDEX_COORDINATOR_DEFAULTS;
  const input = exactOwnData(value, [], OPTION_KEYS);
  const normalized: Record<string, number> = { ...PROVIDER_INDEX_COORDINATOR_DEFAULTS };
  for (const key of OPTION_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    if (input[key] === undefined) fail("INVALID_INPUT");
    normalized[key] = safeBoundedInteger(
      input[key],
      PROVIDER_INDEX_COORDINATOR_HARD_LIMITS[key],
    );
  }
  return Object.freeze(normalized) as unknown as Readonly<NormalizedCoordinatorOptions>;
}

function providerId(value: unknown): ProviderId {
  if (value !== "openai" && value !== "anthropic") fail("INVALID_INPUT");
  return value;
}

function denseArrayValues(value: unknown): readonly unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_CONFIGURED_PROVIDER_HOMES) {
    fail("INVALID_INPUT");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) fail("INVALID_INPUT");
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) fail("INVALID_INPUT");
    output.push(descriptor.value);
  }
  return output;
}

function normalizeRegisteredHomes(value: unknown): readonly Readonly<NormalizedConfiguredProviderHome>[] {
  const values = denseArrayValues(value);
  const seen = new Set<string>();
  const homes = values.map((candidate) => {
    const input = exactOwnData(candidate, ["provider", "home"]);
    const provider = providerId(input.provider);
    if (typeof input.home !== "string") fail("INVALID_INPUT");
    let home: string;
    try {
      home = canonicalizeProviderHome(input.home);
    } catch {
      return fail("INVALID_INPUT");
    }
    if (!hasCanonicalUnicode(home) ||
      sqliteTextLengthAtMost(home, MAX_PROVIDER_HOME_CHARS) === null) {
      fail("INVALID_INPUT");
    }
    const identity = `${provider}\u0000${home}`;
    if (seen.has(identity)) fail("INVALID_INPUT");
    seen.add(identity);
    return Object.freeze({ provider, home });
  });
  homes.sort((left, right) => {
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
    return left.home === right.home ? 0 : left.home < right.home ? -1 : 1;
  });
  return Object.freeze(homes);
}

function exactFunction(value: unknown): (...args: never[]) => unknown {
  if (typeof value !== "function" || utilTypes.isProxy(value)) fail("INVALID_INPUT");
  return value as (...args: never[]) => unknown;
}

function normalizeClock(value: unknown): Readonly<ProviderTaskIndexCoordinatorClock> {
  const input = exactOwnData(value, ["now"]);
  return Object.freeze({ now: exactFunction(input.now) as () => number });
}

function normalizeTimers(value: unknown): Readonly<ProviderTaskIndexCoordinatorTimers> {
  if (value === undefined) {
    return Object.freeze({
      setTimeout: (callback: () => void, delayMs: number): unknown =>
        globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown): void =>
        globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    });
  }
  const input = exactOwnData(value, ["setTimeout", "clearTimeout"]);
  return Object.freeze({
    setTimeout: exactFunction(input.setTimeout) as ProviderTaskIndexCoordinatorTimers["setTimeout"],
    clearTimeout: exactFunction(input.clearTimeout) as ProviderTaskIndexCoordinatorTimers["clearTimeout"],
  });
}

type ObservedTaskResult =
  | Readonly<IndexedProviderTask>
  | Readonly<IndexedProviderTaskSummary>
  | null;

interface Observation {
  readonly laneKey: string;
  readonly apply: () => ObservedTaskResult;
}

interface ObservationLane {
  tail: Promise<void>;
  refCount: number;
  epoch: number;
}

function requireObservationRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) {
    fail("INVALID_INPUT");
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail("INVALID_INPUT");
  }
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_INPUT");
  return value as Readonly<Record<string, unknown>>;
}

function ownDataValue(record: Readonly<Record<string, unknown>>, property: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, property);
  } catch {
    return fail("INVALID_INPUT");
  }
  if (descriptor === undefined || !("value" in descriptor)) fail("INVALID_INPUT");
  return descriptor.value;
}

function ownDataDescriptorPresent(
  record: Readonly<Record<string, unknown>>,
  property: string,
): boolean {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, property);
  } catch {
    return fail("INVALID_INPUT");
  }
  if (descriptor === undefined) return false;
  if (!("value" in descriptor)) fail("INVALID_INPUT");
  return descriptor.value !== undefined;
}

function denseObservationArray(value: unknown, maximum: number): readonly unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail("INVALID_INPUT");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) fail("INVALID_INPUT");
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) fail("INVALID_INPUT");
    output.push(descriptor.value);
  }
  return output;
}

function nativeSummaryView(task: NativeTask): NativeTaskSummary {
  const summary: NativeTaskSummary = {
    key: task.key,
    title: task.title,
    cwd: task.cwd,
    model: task.model,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    archived: task.archived,
    source: task.source,
  };
  if (Object.hasOwn(task, "revision")) summary.revision = task.revision;
  return summary;
}

function summaryFromIndexedTask(
  cache: Readonly<IndexedProviderTask>,
): Readonly<IndexedProviderTaskSummary> {
  return Object.freeze({
    locator: cache.locator,
    title: cache.title,
    cwd: cache.cwd,
    cwdRedacted: cache.cwdRedacted,
    model: cache.model,
    status: cache.status,
    createdAt: cache.createdAt,
    updatedAt: cache.updatedAt,
    archived: cache.archived,
    source: cache.source,
    revision: cache.revision,
    cacheDetail: cache.cacheDetail,
    cacheGeneration: cache.cacheGeneration,
    observedAt: cache.observedAt,
  });
}

export class ProviderTaskIndexCoordinator {
  private initialized: readonly Readonly<ProviderHomeRegistration>[] | null = null;
  private initializing = false;
  private initializationTimestamp: number | null = null;
  private lastNow: number | null = null;
  private observationOperations = 0;
  private readonly observationLanes = new Map<string, ObservationLane>();

  constructor(
    authority: typeof COORDINATOR_CONSTRUCTION,
    private readonly registry: ProviderRegistry,
    private readonly store: ProviderTaskIndexStore,
    private readonly registeredHomes: readonly Readonly<NormalizedConfiguredProviderHome>[],
    private readonly clock: Readonly<ProviderTaskIndexCoordinatorClock>,
    private readonly timers: Readonly<ProviderTaskIndexCoordinatorTimers>,
    private readonly options: Readonly<NormalizedCoordinatorOptions>,
  ) {
    if (authority !== COORDINATOR_CONSTRUCTION) fail("INVALID_INPUT");
    void this.timers;
  }

  initialize(): readonly Readonly<ProviderHomeRegistration>[] {
    if (this.initialized !== null) return this.initialized;
    if (this.initializing) fail("CLOCK_FAILURE");
    this.initializing = true;
    try {
      const registeredAt = this.initializationTimestamp ?? this.readNow();
      this.initializationTimestamp = registeredAt;
      const registrations = this.registeredHomes.map((home) =>
        this.store.registerHome(home, registeredAt));
      this.initialized = Object.freeze(registrations);
      return this.initialized;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * Fold an already-observed native list page into the additive active cache. Each summary is a
   * separate per-locator observation that reserves one unit of the bounded observation budget and
   * runs through its FIFO locator lane. Admission is atomic: an over-budget page fails `CAPACITY`
   * before any store write. Before initial promotion the store replacement returns `null`, so no
   * page fragment is exposed.
   */
  async observeListPage(
    pageValue: Readonly<{
      items: readonly NativeTaskSummary[];
      nextCursor?: string | null;
    }>,
  ): Promise<readonly (Readonly<IndexedProviderTaskSummary> | null)[]> {
    const input = exactOwnData(pageValue, ["items"], ["nextCursor"]);
    const rawItems = denseObservationArray(
      input.items,
      PROVIDER_INDEX_COORDINATOR_HARD_LIMITS.maxObservationOperations,
    );
    const observations = rawItems.map((item) => this.prepareSummaryObservation(item));
    this.reserveObservationOperations(observations.length);
    try {
      const results: (Readonly<IndexedProviderTaskSummary> | null)[] = [];
      for (const observation of observations) {
        results.push(
          (await this.runInLocatorLane(observation.laneKey, observation.apply)) as
            Readonly<IndexedProviderTaskSummary> | null,
        );
      }
      return Object.freeze(results);
    } finally {
      this.releaseObservationOperations(observations.length);
    }
  }

  /**
   * Fold an already-observed native task into the additive active cache. A payload carrying `turns`
   * replaces the complete snapshot; a summary-only payload updates task fields while the store
   * preserves previously cached children. The observation reserves one unit of the bounded budget
   * and runs through its FIFO locator lane. Before initial promotion the store returns `null`.
   */
  async observeTask(
    taskValue: NativeTaskSummary | NativeTask,
  ): Promise<ObservedTaskResult> {
    const observation = this.prepareTaskObservation(taskValue);
    this.reserveObservationOperations(1);
    try {
      return await this.runInLocatorLane(observation.laneKey, observation.apply);
    } finally {
      this.releaseObservationOperations(1);
    }
  }

  /**
   * Current observation epoch for a locator's live lane, or `0` when no lane is active. The epoch
   * increments on each observation that mutates the active cache and is cleared with the lane after
   * its last waiter settles.
   */
  observationEpoch(locatorValue: ProviderTaskLocator): number {
    return this.observationLanes.get(this.laneKeyForLocator(locatorValue))?.epoch ?? 0;
  }

  /**
   * Resolve a task to an authoritative native observation, falling back to the additive cache only
   * when the caller permits degraded reads. Home resolution happens before any provider access, so an
   * unregistered home surfaces the store's `UNKNOWN_HOME` and no provider is touched. An observation
   * token is captured before provider access and validated atomically inside the store's owned
   * transaction: a native success writes through under that token (drift fails
   * `RECONCILIATION_CAS_MISMATCH`); an authoritative-missing result calls `markNativeTaskMissing`, which
   * alone decides whether the exact latch/cache authority is idempotent or needs deletion/relatch, and
   * never consults cache or gzip. Any other provider failure drops the token without mutation and, when
   * degraded cache is allowed and eligible (a snapshot request requires `cacheDetail:"snapshot"`; a
   * summary request may consume either), returns cache; otherwise the registry-sanitized provider error
   * is rethrown, and cache corruption outranks it. A `RECONCILIATION_REQUIRED` failure (e.g. a Claude
   * task that was previously observed persisted) is never routed into the missing transition.
   */
  async readThrough(value: ProviderTaskReadThroughInput): Promise<ProviderTaskReadThrough> {
    const { locator, projection, allowDegradedCache } = this.normalizeReadThroughInput(value);
    const canonicalHome = this.store.resolveHome(locator.provider, locator.homeFingerprint);
    if (canonicalHome === null) throw new ProviderIndexStoreError("UNKNOWN_HOME");
    const registration: Readonly<ProviderIndexRegisteredHome> = Object.freeze({
      provider: locator.provider,
      homeFingerprint: locator.homeFingerprint,
      canonicalHome,
    });
    const key: Readonly<NativeTaskKey> = Object.freeze({
      provider: locator.provider,
      home: canonicalHome,
      nativeTaskId: locator.nativeTaskId,
    });
    const token = this.store.issueTaskObservationToken(locator);
    let tokenConsumed = false;
    try {
      let nativeTask: NativeTask;
      try {
        nativeTask = await this.registry.readTask(key, projection === "snapshot");
      } catch (providerError) {
        if (providerError instanceof ProviderOperationError &&
          providerError.code === "NATIVE_TASK_MISSING") {
          this.store.markNativeTaskMissing(token);
          tokenConsumed = true;
          return Object.freeze({ freshness: "missing", locator });
        }
        this.store.dropTaskObservationToken(token);
        tokenConsumed = true;
        return this.degradedCacheOrRethrow(locator, projection, allowDegradedCache, providerError);
      }
      const observedAt = this.readNow();
      if (projection === "snapshot") {
        const written = this.store.replaceObservedActiveSnapshot(token, nativeTask, observedAt);
        tokenConsumed = true;
        const task = written ??
          projectNativeTaskSnapshotForIndex(registration, key, nativeTask, observedAt);
        return Object.freeze({ freshness: "native", projection: "snapshot", task });
      }
      const summaryView = nativeSummaryView(nativeTask);
      const written = this.store.replaceObservedActiveSummary(token, summaryView, observedAt);
      tokenConsumed = true;
      const task = written ??
        projectNativeTaskSummaryForIndex(registration, key, summaryView, observedAt);
      return Object.freeze({ freshness: "native", projection: "summary", task });
    } finally {
      if (!tokenConsumed) {
        try {
          this.store.dropTaskObservationToken(token);
        } catch {
          /* token already consumed on a commit path; nothing to release */
        }
      }
    }
  }

  /**
   * Resolve a legacy `sessionId` to its unified locator, falling back through the store's verified
   * mapping only after native verification recorded it. An unresolved provenance-only session stays on
   * the legacy path (returns `null`) and can never be promoted by matching ID alone.
   */
  resolveVerifiedLegacySession(
    sessionIdValue: string,
  ): Readonly<VerifiedLegacySessionResolution> | null {
    if (typeof sessionIdValue !== "string") fail("INVALID_INPUT");
    return this.store.getVerifiedLegacySessionMapping(sessionIdValue);
  }

  private degradedCacheOrRethrow(
    locator: ProviderTaskLocator,
    projection: ProviderTaskReadThroughProjection,
    allowDegradedCache: boolean,
    providerError: unknown,
  ): ProviderTaskReadThrough {
    if (!allowDegradedCache) throw providerError;
    // Cache corruption outranks the provider error: a throwing read propagates as-is.
    const cache = this.store.read(locator);
    if (cache === null) throw providerError;
    if (projection === "snapshot") {
      // A summary-only cache is ineligible for a snapshot request; never fabricate an empty transcript.
      if (cache.cacheDetail !== "snapshot") throw providerError;
      return Object.freeze({ freshness: "cache", projection: "snapshot", task: cache });
    }
    return Object.freeze({
      freshness: "cache",
      projection: "summary",
      task: summaryFromIndexedTask(cache),
    });
  }

  private normalizeReadThroughInput(value: unknown): {
    readonly locator: ProviderTaskLocator;
    readonly projection: ProviderTaskReadThroughProjection;
    readonly allowDegradedCache: boolean;
  } {
    const input = exactOwnData(value, ["locator", "projection", "allowDegradedCache"]);
    if (input.projection !== "summary" && input.projection !== "snapshot") fail("INVALID_INPUT");
    if (typeof input.allowDegradedCache !== "boolean") fail("INVALID_INPUT");
    return {
      locator: this.normalizeReadThroughLocator(input.locator),
      projection: input.projection,
      allowDegradedCache: input.allowDegradedCache,
    };
  }

  private normalizeReadThroughLocator(value: unknown): ProviderTaskLocator {
    const record = exactOwnData(value, ["version", "provider", "homeFingerprint", "nativeTaskId"]);
    if (record.version !== 1) fail("INVALID_INPUT");
    const provider = providerId(record.provider);
    if (typeof record.homeFingerprint !== "string" || typeof record.nativeTaskId !== "string") {
      fail("INVALID_INPUT");
    }
    const locator = Object.freeze({
      version: 1 as const,
      provider,
      homeFingerprint: record.homeFingerprint,
      nativeTaskId: record.nativeTaskId,
    });
    try {
      serializeTaskLocator(locator);
    } catch {
      return fail("INVALID_INPUT");
    }
    return locator;
  }

  private laneKeyForLocator(locatorValue: ProviderTaskLocator): string {
    try {
      return serializeTaskLocator(locatorValue);
    } catch {
      return fail("INVALID_INPUT");
    }
  }

  private laneKeyForKey(key: unknown): string {
    try {
      return serializeTaskLocator(taskLocator(key as NativeTaskKey));
    } catch {
      return fail("INVALID_INPUT");
    }
  }

  private prepareSummaryObservation(itemValue: unknown): Observation {
    const record = requireObservationRecord(itemValue);
    const key = ownDataValue(record, "key");
    const laneKey = this.laneKeyForKey(key);
    return {
      laneKey,
      apply: () => {
        const observedAt = this.readNow();
        const result = this.store.replaceActiveSummary(
          key as NativeTaskKey,
          record as unknown as NativeTaskSummary,
          observedAt,
        );
        if (result !== null) this.bumpObservationEpoch(laneKey);
        return result;
      },
    };
  }

  private prepareTaskObservation(taskValue: unknown): Observation {
    const record = requireObservationRecord(taskValue);
    const key = ownDataValue(record, "key");
    const laneKey = this.laneKeyForKey(key);
    const isSnapshot = ownDataDescriptorPresent(record, "turns");
    return {
      laneKey,
      apply: () => {
        const observedAt = this.readNow();
        const result = isSnapshot
          ? this.store.replaceActiveSnapshot(
              key as NativeTaskKey,
              record as unknown as NativeTask,
              observedAt,
            )
          : this.store.replaceActiveSummary(
              key as NativeTaskKey,
              record as unknown as NativeTaskSummary,
              observedAt,
            );
        if (result !== null) this.bumpObservationEpoch(laneKey);
        return result;
      },
    };
  }

  private reserveObservationOperations(count: number): void {
    if (this.observationOperations + count > this.options.maxObservationOperations) {
      fail("CAPACITY");
    }
    this.observationOperations += count;
  }

  private releaseObservationOperations(count: number): void {
    this.observationOperations -= count;
  }

  private bumpObservationEpoch(laneKey: string): void {
    const lane = this.observationLanes.get(laneKey);
    if (lane !== undefined) lane.epoch += 1;
  }

  private runInLocatorLane(laneKey: string, task: () => ObservedTaskResult): Promise<ObservedTaskResult> {
    let lane = this.observationLanes.get(laneKey);
    if (lane === undefined) {
      if (this.observationLanes.size >= this.options.maxUniqueTasks) fail("CAPACITY");
      lane = { tail: Promise.resolve(), refCount: 0, epoch: 0 };
      this.observationLanes.set(laneKey, lane);
    }
    const activeLane = lane;
    activeLane.refCount += 1;
    const result = activeLane.tail.then(() => task());
    activeLane.tail = result.then(() => undefined, () => undefined);
    const settle = (): void => {
      activeLane.refCount -= 1;
      if (activeLane.refCount === 0 && this.observationLanes.get(laneKey) === activeLane) {
        this.observationLanes.delete(laneKey);
      }
    };
    result.then(settle, settle);
    return result;
  }

  private readNow(): number {
    let value: unknown;
    try {
      value = this.clock.now();
    } catch {
      return fail("CLOCK_FAILURE");
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
      (this.lastNow !== null && value < this.lastNow)) fail("CLOCK_FAILURE");
    this.lastNow = value;
    return value;
  }
}

export function createProviderTaskIndexCoordinator(
  value: ProviderTaskIndexCoordinatorFactoryInput,
): ProviderTaskIndexCoordinator {
  const input = exactOwnData(value, [
    "registry",
    "store",
    "registeredHomes",
    "clock",
  ], ["timers", "options"]);
  if (utilTypes.isProxy(input.registry) || !isProviderRegistryInstance(input.registry) ||
    utilTypes.isProxy(input.store) || !isProviderTaskIndexStoreInstance(input.store)) {
    return fail("INVALID_INPUT");
  }
  const homes = normalizeRegisteredHomes(input.registeredHomes);
  const clock = normalizeClock(input.clock);
  if (Object.hasOwn(input, "timers") && input.timers === undefined) fail("INVALID_INPUT");
  if (Object.hasOwn(input, "options") && input.options === undefined) fail("INVALID_INPUT");
  const timers = normalizeTimers(input.timers);
  const options = normalizeOptions(input.options);
  void input.registry;
  void timers;
  void options;
  return new ProviderTaskIndexCoordinator(
    COORDINATOR_CONSTRUCTION,
    input.registry,
    input.store,
    homes,
    clock,
    timers,
    options,
  );
}
