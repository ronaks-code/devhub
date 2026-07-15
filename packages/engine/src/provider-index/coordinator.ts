import { types as utilTypes } from "node:util";
import { MAX_PROVIDER_HOME_CHARS } from "../providers/native-id.js";
import { canonicalizeProviderHome } from "../providers/task-key.js";
import type { ProviderId } from "../providers/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { isProviderRegistryInstance } from "../providers/registry-instance.js";
import {
  ProviderTaskIndexStore,
  isProviderTaskIndexStoreInstance,
} from "./store.js";
import type { ProviderHomeRegistration } from "./store-types.js";
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

export class ProviderTaskIndexCoordinator {
  private initialized: readonly Readonly<ProviderHomeRegistration>[] | null = null;
  private initializing = false;
  private initializationTimestamp: number | null = null;
  private lastNow: number | null = null;

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
    void this.registry;
    void this.timers;
    void this.options;
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
