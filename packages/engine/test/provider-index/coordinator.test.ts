import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "../../src/index.js";
import { runMigrations } from "../../src/migrations.js";
import { ProviderTaskIndexStore } from "../../src/provider-index/store.js";
import { ProviderIndexStoreError } from "../../src/provider-index/store-types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

interface ConfiguredHome {
  readonly provider: "openai" | "anthropic";
  readonly home: string;
}

interface Coordinator {
  initialize(): readonly Readonly<{
    provider: "openai" | "anthropic";
    homeFingerprint: string;
    registeredAt: number;
  }>[];
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

type CoordinatorFactory = (input: FactoryInput) => Coordinator;

interface FoundationExports {
  readonly createProviderTaskIndexCoordinator?: CoordinatorFactory;
  readonly PROVIDER_INDEX_COORDINATOR_DEFAULTS?: Readonly<Record<string, number>>;
  readonly PROVIDER_INDEX_COORDINATOR_HARD_LIMITS?: Readonly<Record<string, number>>;
  readonly ProviderTaskIndexCoordinatorError?: new (code: string) => Error & { readonly code: string };
}

const databases: TestDatabase[] = [];
const directories: string[] = [];

function openStore(options?: { stageLeaseMs?: number }): ProviderTaskIndexStore {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA user_version = 13");
  runMigrations(db);
  return new ProviderTaskIndexStore(db, options);
}

function temporaryHome(label: string): string {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), `devhub-${label}-`)));
  directories.push(home);
  return home;
}

function foundation(): Required<FoundationExports> {
  const exports = engine as FoundationExports;
  expect(exports.createProviderTaskIndexCoordinator).toBeTypeOf("function");
  expect(exports.PROVIDER_INDEX_COORDINATOR_DEFAULTS).toBeTypeOf("object");
  expect(exports.PROVIDER_INDEX_COORDINATOR_HARD_LIMITS).toBeTypeOf("object");
  expect(exports.ProviderTaskIndexCoordinatorError).toBeTypeOf("function");
  return exports as Required<FoundationExports>;
}

function factoryInput(overrides: Partial<FactoryInput> = {}): FactoryInput {
  return {
    registry: new ProviderRegistry(),
    store: openStore(),
    registeredHomes: [],
    clock: Object.freeze({ now: () => 100 }),
    ...overrides,
  };
}

function expectCoordinatorError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected coordinator error");
  } catch (error) {
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain("/tmp/");
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

describe("ProviderTaskIndexCoordinator foundation", () => {
  it("exports exact frozen defaults and hard limits", () => {
    const api = foundation();
    expect(api.PROVIDER_INDEX_COORDINATOR_DEFAULTS).toEqual({
      pageSize: 200,
      maxPages: 5_000,
      maxUniqueTasks: 100_000,
      maxRebuildMs: 900_000,
      maxObservationOperations: 256,
    });
    expect(api.PROVIDER_INDEX_COORDINATOR_HARD_LIMITS).toEqual({
      pageSize: 200,
      maxPages: 5_000,
      maxUniqueTasks: 1_000_000,
      maxRebuildMs: 3_600_000,
      maxObservationOperations: 1_024,
    });
    expect(Object.isFrozen(api.PROVIDER_INDEX_COORDINATOR_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(api.PROVIDER_INDEX_COORDINATOR_HARD_LIMITS)).toBe(true);
  });

  it("normalizes exact bounded options and rejects extras or own undefined", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    expect(() => create(factoryInput({
      options: Object.freeze({
        pageSize: 1,
        maxPages: 2,
        maxUniqueTasks: 3,
        maxRebuildMs: 4,
        maxObservationOperations: 5,
      }),
    }))).not.toThrow();
    expectCoordinatorError(() => create(factoryInput({
      options: { pageSize: 201 },
    })), "INVALID_INPUT");
    expectCoordinatorError(() => create(factoryInput({
      options: { pageSize: undefined as unknown as number },
    })), "INVALID_INPUT");
    expectCoordinatorError(() => create({
      ...factoryInput(),
      extra: true,
    } as unknown as FactoryInput), "INVALID_INPUT");
    expectCoordinatorError(() => create({
      ...factoryInput(),
      options: undefined,
    } as unknown as FactoryInput), "INVALID_INPUT");
    expectCoordinatorError(() => create({
      ...factoryInput(),
      timers: undefined,
    } as unknown as FactoryInput), "INVALID_INPUT");
  });

  it.each([
    ["pageSize", 200],
    ["maxPages", 5_000],
    ["maxUniqueTasks", 1_000_000],
    ["maxRebuildMs", 3_600_000],
    ["maxObservationOperations", 1_024],
  ] as const)("enforces the exact %s hard cap", (key, maximum) => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    expect(() => create(factoryInput({ options: { [key]: maximum } }))).not.toThrow();
    expectCoordinatorError(
      () => create(factoryInput({ options: { [key]: 0 } })),
      "INVALID_INPUT",
    );
    expectCoordinatorError(
      () => create(factoryInput({ options: { [key]: maximum + 1 } })),
      "INVALID_INPUT",
    );
    expectCoordinatorError(
      () => create(factoryInput({ options: { [key]: "1" as unknown as number } })),
      "INVALID_INPUT",
    );
  });

  it("rejects proxies, exotic config, and accessors without invoking them", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    expectCoordinatorError(() => create(new Proxy(factoryInput(), {}) as FactoryInput), "INVALID_INPUT");
    expectCoordinatorError(() => create(factoryInput({
      options: new Proxy({ pageSize: 1 }, {}),
    })), "INVALID_INPUT");
    expectCoordinatorError(() => create(factoryInput({
      registeredHomes: new Proxy([], {}),
    })), "INVALID_INPUT");
    const revokedHomes = Proxy.revocable([], {});
    revokedHomes.revoke();
    expectCoordinatorError(() => create(factoryInput({
      registeredHomes: revokedHomes.proxy,
    })), "INVALID_INPUT");
    expectCoordinatorError(() => create(factoryInput({
      options: Object.create({ pageSize: 1 }) as Record<string, number>,
    })), "INVALID_INPUT");
    let calls = 0;
    const home = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(home, "provider", { enumerable: true, value: "openai" });
    Object.defineProperty(home, "home", { enumerable: true, get: () => { calls += 1; return "/tmp/x"; } });
    expectCoordinatorError(() => create(factoryInput({
      registeredHomes: [home as unknown as ConfiguredHome],
    })), "INVALID_INPUT");
    expect(calls).toBe(0);
  });

  it("rejects prototype-forged registry and store instances", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    const forgedRegistry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    const forgedStore = Object.create(ProviderTaskIndexStore.prototype) as ProviderTaskIndexStore;
    expectCoordinatorError(
      () => create(factoryInput({ registry: forgedRegistry })),
      "INVALID_INPUT",
    );
    expectCoordinatorError(
      () => create(factoryInput({ store: forgedStore })),
      "INVALID_INPUT",
    );

    Object.defineProperty(ProviderRegistry, "isInstance", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(ProviderTaskIndexStore, "isInstance", {
      configurable: true,
      value: () => true,
    });
    try {
      expectCoordinatorError(
        () => create(factoryInput({ registry: forgedRegistry })),
        "INVALID_INPUT",
      );
      expectCoordinatorError(
        () => create(factoryInput({ store: forgedStore })),
        "INVALID_INPUT",
      );
    } finally {
      delete (ProviderRegistry as unknown as Record<string, unknown>).isInstance;
      delete (ProviderTaskIndexStore as unknown as Record<string, unknown>).isInstance;
    }
  });

  it("rejects configured-home amplification before path canonicalization", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    const homes = Array.from({ length: 1_025 }, (_, index) => ({
      provider: "openai" as const,
      home: `/tmp/devhub-configured-home-${index}`,
    }));
    expectCoordinatorError(
      () => create(factoryInput({ registeredHomes: homes })),
      "INVALID_INPUT",
    );
  });

  it("rejects hostile clock and timer descriptors without invoking them", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    let calls = 0;
    const clock = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(clock, "now", {
      enumerable: true,
      get: () => { calls += 1; return () => 1; },
    });
    expectCoordinatorError(() => create(factoryInput({
      clock: clock as unknown as FactoryInput["clock"],
    })), "INVALID_INPUT");
    expectCoordinatorError(() => create(factoryInput({
      timers: {
        setTimeout: () => 1,
        clearTimeout: () => undefined,
        extra: true,
      } as unknown as FactoryInput["timers"],
    })), "INVALID_INPUT");
    expect(calls).toBe(0);
  });

  it("rejects duplicate canonical homes including aliases", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    const home = temporaryHome("duplicate-home");
    expectCoordinatorError(() => create(factoryInput({
      registeredHomes: [
        { provider: "openai", home },
        { provider: "openai", home: path.join(home, ".") },
      ],
    })), "INVALID_INPUT");
  });

  it("rejects malformed canonical-home text before clock or store work", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    let clockCalls = 0;
    expectCoordinatorError(() => create(factoryInput({
      registeredHomes: [{ provider: "openai", home: "/tmp/bad-\ud800-home" }],
      clock: Object.freeze({ now: () => { clockCalls += 1; return 1; } }),
    })), "INVALID_INPUT");
    expect(clockCalls).toBe(0);
  });

  it("sorts homes and initializes them with one timestamp", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    const openaiHome = temporaryHome("openai-home");
    const anthropicHome = temporaryHome("anthropic-home");
    let clockCalls = 0;
    const coordinator = create(factoryInput({
      registeredHomes: [
        { provider: "openai", home: openaiHome },
        { provider: "anthropic", home: anthropicHome },
      ],
      clock: Object.freeze({ now: () => { clockCalls += 1; return 77; } }),
    }));

    const result = coordinator.initialize();
    expect(result.map((entry) => entry.provider)).toEqual(["anthropic", "openai"]);
    expect(result.every((entry) => entry.registeredAt === 77)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(openaiHome);
    expect(JSON.stringify(result)).not.toContain(anthropicHome);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
    expect(coordinator.initialize()).toBe(result);
    expect(clockCalls).toBe(1);
  });

  it("reuses the first timestamp after a partial store failure", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    const store = openStore();
    const originalRegister = store.registerHome.bind(store);
    let registerCalls = 0;
    let failed = false;
    Object.defineProperty(store, "registerHome", {
      configurable: true,
      value: (home: ConfiguredHome, registeredAt: number) => {
        registerCalls += 1;
        if (!failed && registerCalls === 2) {
          failed = true;
          throw new ProviderIndexStoreError("DATABASE_UNAVAILABLE");
        }
        return originalRegister(home, registeredAt);
      },
    });
    let clockCalls = 0;
    const coordinator = create(factoryInput({
      store,
      registeredHomes: [
        { provider: "anthropic", home: temporaryHome("retry-anthropic") },
        { provider: "openai", home: temporaryHome("retry-openai") },
      ],
      clock: Object.freeze({ now: () => { clockCalls += 1; return clockCalls * 10; } }),
    }));

    expect(() => coordinator.initialize()).toThrow(ProviderIndexStoreError);
    const result = coordinator.initialize();
    expect(result.map((entry) => entry.registeredAt)).toEqual([10, 10]);
    expect(clockCalls).toBe(1);
  });

  it("maps throwing and invalid clocks to value-free CLOCK_FAILURE", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    const home = temporaryHome("clock-home");
    const configured = [{ provider: "openai", home }] as const;
    expectCoordinatorError(() => create(factoryInput({
      registeredHomes: configured,
      clock: Object.freeze({ now: () => { throw new Error(home); } }),
    })).initialize(), "CLOCK_FAILURE");
    expectCoordinatorError(() => create(factoryInput({
      registeredHomes: configured,
      clock: Object.freeze({ now: () => -1 }),
    })).initialize(), "CLOCK_FAILURE");
  });

  it("contains clock reentrancy and performs no provider calls during initialization", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    const registry = new ProviderRegistry();
    let providerCalls = 0;
    for (const name of ["descriptorCensus", "listTasks", "readTask"] as const) {
      Object.defineProperty(registry, name, {
        configurable: true,
        value: () => { providerCalls += 1; throw new Error("provider access forbidden"); },
      });
    }
    let coordinator: Coordinator;
    coordinator = create(factoryInput({
      registry,
      clock: Object.freeze({ now: () => {
        coordinator.initialize();
        return 1;
      } }),
    }));
    expectCoordinatorError(() => coordinator.initialize(), "CLOCK_FAILURE");
    expect(providerCalls).toBe(0);
  });

  it("validates timer and clock carriers without invoking them", () => {
    const { createProviderTaskIndexCoordinator: create } = foundation();
    let timerCalls = 0;
    expect(() => create(factoryInput({
      timers: Object.freeze({
        setTimeout: () => { timerCalls += 1; return 1; },
        clearTimeout: () => { timerCalls += 1; },
      }),
    }))).not.toThrow();
    expect(timerCalls).toBe(0);
    expectCoordinatorError(() => create(factoryInput({
      clock: { now: undefined as unknown as () => number },
    })), "INVALID_INPUT");
  });

  it("uses the exact stable value-free coordinator errors", () => {
    const ErrorConstructor = foundation().ProviderTaskIndexCoordinatorError;
    const messages = {
      INVALID_INPUT: "Provider task index coordinator input is invalid",
      CAPACITY: "Provider task index coordinator capacity was exceeded",
      CLOCK_FAILURE: "Provider task index coordinator clock failed",
      REBUILD_BUSY: "Provider task index coordinator rebuild is busy",
      REBUILD_TIMEOUT: "Provider task index coordinator rebuild timed out",
      CANCELLED: "Provider task index coordinator operation was cancelled",
      STALE_OBSERVATION: "Provider task index coordinator observation is stale",
    } as const;
    for (const [code, message] of Object.entries(messages)) {
      const error = new ErrorConstructor(code);
      expect(error).toMatchObject({
        name: "ProviderTaskIndexCoordinatorError",
        code,
        message,
      });
    }
  });

  it("refuses direct construction that bypasses the normalized factory", () => {
    const CoordinatorConstructor = (engine as unknown as {
      ProviderTaskIndexCoordinator: new (...args: readonly unknown[]) => Coordinator;
    }).ProviderTaskIndexCoordinator;
    expect(CoordinatorConstructor).toBeTypeOf("function");
    expectCoordinatorError(
      () => new CoordinatorConstructor(Symbol("foreign"), openStore(), [], { now: () => 1 }),
      "INVALID_INPUT",
    );
  });

  it("exposes the normalized stage lease only on the concrete backend store", () => {
    const store = openStore({ stageLeaseMs: 1_234 }) as ProviderTaskIndexStore & {
      getStageLeaseMs?: () => number;
    };
    expect(store.getStageLeaseMs).toBeTypeOf("function");
    expect(store.getStageLeaseMs!()).toBe(1_234);
  });
});
