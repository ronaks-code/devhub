import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderCapabilityError,
  defineProviderCapabilities,
  type ProviderCapability,
} from "../../src/providers/capabilities.js";
import {
  MAX_PENDING_PROVIDER_REQUESTS,
  MAX_TERMINAL_PROVIDER_REQUESTS,
  ProviderAdapterError,
  ProviderRegistry,
  ProviderRegistryNotFoundError,
} from "../../src/providers/registry.js";
import { createProviderRequestIdentity } from "../../src/providers/request-identity.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";
import { ProviderOperationError } from "../../src/providers/operation-error.js";
import type {
  NativeTask,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEventSink,
  ProviderId,
  ProviderRequestIdentity,
  ProviderRequestResponse,
} from "../../src/providers/types.js";

const task = (provider: ProviderId, home: string, id = "task-1"): NativeTask => ({
  key: createNativeTaskKey(provider, home, id),
  title: id,
  cwd: "/work",
  model: null,
  status: "complete",
  createdAt: null,
  updatedAt: null,
  archived: false,
  source: "native",
  turns: [],
});

const taskAtRevision = (
  provider: ProviderId,
  home: string,
  id: string,
  fingerprint: string,
): NativeTask => ({
  ...task(provider, home, id),
  revision: {
    updatedAt: 1,
    status: "idle",
    lastTurnId: null,
    lastTurnStatus: null,
    lastItemId: null,
    fingerprint,
  },
});

const fakeAdapter = (
  provider: ProviderId,
  capabilities: Partial<ProviderCapabilities>,
  methods: Partial<ProviderAdapter> = {},
): ProviderAdapter => {
  const unsupported = async () => {
    throw new Error("unexpected adapter invocation");
  };
  return {
    provider,
    capabilities: async () => defineProviderCapabilities(capabilities),
    listTasks: unsupported,
    readTask: unsupported,
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
    ...methods,
  } as ProviderAdapter;
};

interface ExtendedRegistryOperation {
  name: string;
  capability: ProviderCapability;
  method: keyof ProviderAdapter;
  invoke: (registry: ProviderRegistry, key: NativeTask["key"]) => Promise<unknown>;
}

const extendedRegistryOperations: readonly ExtendedRegistryOperation[] = [
  {
    name: "list",
    capability: "list",
    method: "listTasks",
    invoke: (registry, key) => registry.listTasks(key.provider, { home: key.home }),
  },
  {
    name: "read",
    capability: "read",
    method: "readTask",
    invoke: (registry, key) => registry.readTask(key, true),
  },
  {
    name: "start",
    capability: "start",
    method: "startTask",
    invoke: (registry, key) => registry.startTask(key.provider, {
      home: key.home,
      cwd: "/work",
    }),
  },
  {
    name: "resume",
    capability: "resume",
    method: "resumeTask",
    invoke: (registry, key) => registry.resumeTask(key, { model: "test-model" }),
  },
  {
    name: "fork",
    capability: "fork",
    method: "forkTask",
    invoke: (registry, key) => registry.forkTask(key, "turn-1"),
  },
  {
    name: "send",
    capability: "send",
    method: "send",
    invoke: (registry, key) => registry.send(key, { text: "continue" }),
  },
  {
    name: "steer",
    capability: "steer",
    method: "steer",
    invoke: (registry, key) => registry.steer(key, "turn-1", { text: "redirect" }),
  },
  {
    name: "interrupt",
    capability: "interrupt",
    method: "interrupt",
    invoke: (registry, key) => registry.interrupt(key, "turn-1"),
  },
  {
    name: "archive",
    capability: "archive",
    method: "archive",
    invoke: (registry, key) => registry.archive(key),
  },
  {
    name: "rename",
    capability: "rename",
    method: "rename",
    invoke: (registry, key) => registry.rename(key, "Renamed task"),
  },
  {
    name: "subscribe",
    capability: "subscribe",
    method: "subscribe",
    invoke: (registry, key) => registry.subscribe(key, vi.fn()),
  },
];

describe("ProviderRegistry identity", () => {
  it("acknowledges only the exact current task fingerprint through the selected adapter", async () => {
    const registry = new ProviderRegistry();
    const key = createNativeTaskKey("anthropic", "/tmp/provider-home", "task-1");
    const acknowledgeReconciliation = vi.fn(async () => undefined);
    const readTask = vi.fn(async () =>
      taskAtRevision("anthropic", key.home, key.nativeTaskId, "fingerprint-current"));
    registry.register(key.home, fakeAdapter("anthropic", { read: true }, {
      readTask,
      acknowledgeReconciliation,
    }));

    await expect(registry.acknowledgeReconciliation(key, "fingerprint-current"))
      .resolves.toBeUndefined();
    expect(readTask).toHaveBeenCalledWith(key, true);
    expect(acknowledgeReconciliation)
      .toHaveBeenCalledWith(key, "fingerprint-current");
  });

  it("rejects stale reconciliation fingerprints before the adapter can clear its latch", async () => {
    const registry = new ProviderRegistry();
    const key = createNativeTaskKey("anthropic", "/tmp/provider-home", "task-1");
    const acknowledgeReconciliation = vi.fn(async () => undefined);
    registry.register(key.home, fakeAdapter("anthropic", { read: true }, {
      readTask: async () =>
        taskAtRevision("anthropic", key.home, key.nativeTaskId, "fingerprint-new"),
      acknowledgeReconciliation,
    }));

    await expect(registry.acknowledgeReconciliation(key, "fingerprint-stale"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(acknowledgeReconciliation).not.toHaveBeenCalled();
  });

  it("supports exact generic acknowledgement for adapters without a private latch", async () => {
    const registry = new ProviderRegistry();
    const key = createNativeTaskKey("openai", "/tmp/provider-home", "task-1");
    registry.register(key.home, fakeAdapter("openai", { read: true }, {
      readTask: async () =>
        taskAtRevision("openai", key.home, key.nativeTaskId, "fingerprint-current"),
    }));

    await expect(registry.acknowledgeReconciliation(key, "fingerprint-current"))
      .resolves.toBeUndefined();
  });

  it("keys adapters by provider and canonical home without cross-provider fallback", () => {
    const registry = new ProviderRegistry();
    const adapter = fakeAdapter("openai", { list: true });
    registry.register("/tmp/a/../provider-home", adapter);

    expect(registry.lookup("openai", "/tmp/provider-home")).toBe(adapter);
    expect(() => registry.lookup("anthropic", "/tmp/provider-home")).toThrow(
      ProviderRegistryNotFoundError,
    );
    expect(() => registry.register("/tmp/provider-home", adapter)).toThrow(/already registered/i);
  });

  it("rejects a non-canonical key before invoking an adapter", async () => {
    const readTask = vi.fn(async () => task("openai", "/tmp/provider-home"));
    const registry = new ProviderRegistry();
    registry.register("/tmp/provider-home", fakeAdapter("openai", { read: true }, { readTask }));

    await expect(
      registry.readTask(
        { provider: "openai", home: "/tmp/a/../provider-home", nativeTaskId: "task-1" },
        true,
      ),
    ).rejects.toThrow(/canonical/i);
    expect(readTask).not.toHaveBeenCalled();
  });

  it("deduplicates registrations that name the same home through a symlink", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-registry-home-"));
    try {
      const actual = path.join(root, "actual");
      const link = path.join(root, "linked");
      mkdirSync(actual);
      symlinkSync(actual, link);
      const registry = new ProviderRegistry();
      const adapter = fakeAdapter("openai", { list: true });

      registry.register(actual, adapter);

      expect(registry.lookup("openai", link)).toBe(adapter);
      expect(() => registry.register(link, adapter)).toThrow(/already registered/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("snapshots a caller-owned key before awaiting adapter capabilities", async () => {
    let releaseCapabilities!: () => void;
    const capabilitiesReady = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });
    const readTask = vi.fn(async (key) => task("openai", key.home, key.nativeTaskId));
    const adapter = {
      ...fakeAdapter("openai", { read: true }, { readTask }),
      capabilities: async () => {
        await capabilitiesReady;
        return defineProviderCapabilities({ read: true });
      },
    };
    const registry = new ProviderRegistry();
    registry.register("/tmp/provider-home", adapter);
    const callerKey = {
      provider: "openai" as const,
      home: "/tmp/provider-home",
      nativeTaskId: "task-1",
    };

    const pending = registry.readTask(callerKey, true);
    callerKey.nativeTaskId = "task-2";
    releaseCapabilities();
    await pending;

    expect(readTask).toHaveBeenCalledWith(
      expect.objectContaining({ nativeTaskId: "task-1" }),
      true,
    );
    expect(Object.isFrozen(readTask.mock.calls[0]![0])).toBe(true);
  });
});

describe("ProviderRegistry dispatch", () => {
  it("canonicalizes list homes, gates capability, and validates returned ownership", async () => {
    const listTasks = vi.fn(async (input) => ({
      items: [task("openai", input.home)],
      nextCursor: null,
    }));
    const registry = new ProviderRegistry();
    registry.register("/tmp/provider-home", fakeAdapter("openai", { list: true }, { listTasks }));

    const page = await registry.listTasks("openai", {
      home: "/tmp/a/../provider-home",
      limit: 10,
    });
    expect(page.items[0]!.key.home).toBe("/tmp/provider-home");
    expect(listTasks).toHaveBeenCalledWith({ home: "/tmp/provider-home", limit: 10 });
  });

  it("fails closed before invoking an unsupported operation", async () => {
    const startTask = vi.fn(async () => task("openai", "/tmp/provider-home"));
    const registry = new ProviderRegistry();
    registry.register("/tmp/provider-home", fakeAdapter("openai", {}, { startTask }));

    await expect(
      registry.startTask("openai", { home: "/tmp/provider-home", cwd: "/work" }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(startTask).not.toHaveBeenCalled();
  });

  it("wraps adapter failures without disguising capability failures", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { list: true }, {
        listTasks: async () => {
          throw new Error("provider offline");
        },
      }),
    );

    await expect(
      registry.listTasks("openai", { home: "/tmp/provider-home" }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ADAPTER_FAILURE",
      provider: "openai",
      home: "/tmp/provider-home",
    });
    await expect(
      registry.listTasks("openai", { home: "/tmp/provider-home" }),
    ).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  it("projects typed input failures without exposing adapter messages", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => {
          throw new ProviderOperationError(
            "INVALID_INPUT",
            "Bearer adapter-secret-never-expose",
          );
        },
      }),
    );

    const error = await registry.startTask("openai", {
      home: "/tmp/provider-home",
      cwd: "/work",
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderOperationError);
    expect(error).toMatchObject({ code: "INVALID_INPUT", message: "Provider input is invalid" });
    expect(JSON.stringify(error)).not.toContain("adapter-secret-never-expose");
  });

  it("preserves non-retryable mutation uncertainty without leaking its cause", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { send: true }, {
        send: async () => {
          throw new ProviderOperationError(
            "MUTATION_UNCERTAIN",
            "timeout Bearer adapter-secret-never-expose",
          );
        },
      }),
    );
    const error = await registry.send(
      createNativeTaskKey("openai", "/tmp/provider-home", "task-1"),
      { text: "send once" },
    ).catch((reason: unknown) => reason) as ProviderOperationError;
    expect(error).toMatchObject({
      code: "MUTATION_UNCERTAIN",
      message: "Provider mutation outcome is uncertain; do not retry automatically",
    });
    expect(error.task).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("adapter-secret-never-expose");
  });

  it("projects native-task-missing without exposing adapter detail, cause, or task identity", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { read: true }, {
        readTask: async () => {
          throw new ProviderOperationError(
            "NATIVE_TASK_MISSING",
            "thread not loaded: secret-native-task-id",
            { cause: new Error("Bearer adapter-secret-never-expose") },
          );
        },
      }),
    );

    const error = await registry.readTask(
      createNativeTaskKey("openai", "/tmp/provider-home", "secret-native-task-id"),
    ).catch((reason: unknown) => reason) as ProviderOperationError;

    expect(error).toBeInstanceOf(ProviderOperationError);
    expect(error).toMatchObject({
      code: "NATIVE_TASK_MISSING",
      message: "Provider native task is missing",
    });
    expect(error.task).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("secret-native-task-id");
    expect(JSON.stringify(error)).not.toContain("adapter-secret-never-expose");
  });

  it("contains a native-task-missing failure that carries a task projection", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { read: true }, {
        readTask: async () => {
          throw new ProviderOperationError(
            "NATIVE_TASK_MISSING",
            "raw provider failure",
            { task: task("openai", "/tmp/provider-home", "must-never-project") },
          );
        },
      }),
    );

    await expect(registry.readTask(
      createNativeTaskKey("openai", "/tmp/provider-home", "task-1"),
    )).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  it("contains a provider operation error with an accessor code without invoking it", async () => {
    const hostile = new ProviderOperationError("INVALID_INPUT", "raw provider failure");
    let codeReads = 0;
    Object.defineProperty(hostile, "code", {
      configurable: true,
      enumerable: true,
      get() {
        codeReads += 1;
        return "PARTIAL_START";
      },
    });
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => { throw hostile; },
      }),
    );

    const failure = await registry.startTask("openai", {
      home: "/tmp/provider-home",
      cwd: "/work",
    }).catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(codeReads).toBe(0);
    expect(failure).not.toHaveProperty("task");
  });

  it("contains a task accessor that mutates its error code before a forged partial projection", async () => {
    const hostile = new ProviderOperationError("INVALID_INPUT", "raw provider failure");
    const projected = {
      ...task("openai", "/tmp/provider-home", "must-never-project"),
      cwd: "/secret/project-home",
    };
    let taskReads = 0;
    Object.defineProperty(hostile, "task", {
      configurable: true,
      enumerable: true,
      get() {
        taskReads += 1;
        (hostile as unknown as { code: string }).code = "PARTIAL_START";
        return taskReads === 1 ? undefined : projected;
      },
    });
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => { throw hostile; },
      }),
    );

    const failure = await registry.startTask("openai", {
      home: "/tmp/provider-home",
      cwd: "/work",
    }).catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(taskReads).toBe(0);
    expect(failure).not.toHaveProperty("task");
    expect(JSON.stringify(failure)).not.toContain("must-never-project");
    expect(JSON.stringify(failure)).not.toContain("/secret/project-home");
  });

  it("contains a provider operation proxy whose descriptor trap throws", async () => {
    let descriptorReads = 0;
    const hostile = new Proxy(
      new ProviderOperationError("INVALID_INPUT", "raw provider failure"),
      {
        getOwnPropertyDescriptor() {
          descriptorReads += 1;
          throw new Error("descriptor secret must never escape");
        },
      },
    );
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => { throw hostile; },
      }),
    );

    const failure = await registry.startTask("openai", {
      home: "/tmp/provider-home",
      cwd: "/work",
    }).catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(descriptorReads).toBe(0);
    expect(failure).not.toHaveProperty("task");
    expect(JSON.stringify(failure)).not.toContain("descriptor secret");
  });

  it.each([
    ["throwing getPrototypeOf", () => {
      const trap = new Error("prototype trap secret must never escape");
      const target = new ProviderOperationError(
        "PARTIAL_START",
        "raw missing task must-never-project",
        {
          cause: new Error("raw cause secret must never escape"),
          task: {
            ...task("openai", "/secret/provider-home", "secret-native-task-id"),
            cwd: "/secret/project-home",
          },
        },
      );
      return {
        hostile: new Proxy(target, {
          getPrototypeOf() { throw trap; },
        }),
        rawCause: trap,
      };
    }],
    ["revoked", () => {
      const rawCause = new Error("revoked proxy cause secret must never escape");
      const revocable = Proxy.revocable(
        new ProviderOperationError(
          "PARTIAL_START",
          "raw revoked task must-never-project",
          {
            cause: rawCause,
            task: {
              ...task("openai", "/secret/provider-home", "secret-native-task-id"),
              cwd: "/secret/project-home",
            },
          },
        ),
        {},
      );
      revocable.revoke();
      return { hostile: revocable.proxy, rawCause };
    }],
  ] as const)("contains a %s provider operation proxy before typed classification", async (_name, create) => {
    const { hostile, rawCause } = create();
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => { throw hostile; },
      }),
    );

    const failure = await registry.startTask("openai", {
      home: "/tmp/provider-home",
      cwd: "/work",
    }).catch((reason: unknown) => reason) as ProviderAdapterError;

    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(failure).not.toBe(rawCause);
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(failure.cause).not.toBe(rawCause);
    expect((failure.cause as Error).message)
      .toBe("provider operation failure classification is invalid");
    expect((failure.cause as Error).cause).toBeUndefined();
    expect(failure).not.toHaveProperty("task");
    const projected = `${failure.message}\n${(failure.cause as Error).message}\n${JSON.stringify(failure)}`;
    for (const secret of [
      "prototype trap secret",
      "raw cause secret",
      "revoked proxy cause secret",
      "must-never-project",
      "secret-native-task-id",
      "/secret/provider-home",
      "/secret/project-home",
    ]) expect(projected).not.toContain(secret);
  });

  it.each([
    ["capability", ProviderCapabilityError.prototype],
    ["registry-not-found", ProviderRegistryNotFoundError.prototype],
    ["adapter", ProviderAdapterError.prototype],
  ] as const)("contains a provider operation proxy that spoofs the %s prototype", async (_name, prototype) => {
    const rawCause = new Error("spoofed prototype cause secret must never escape");
    const hostile = new Proxy(
      new ProviderOperationError(
        "PARTIAL_START",
        "spoofed prototype task must-never-project",
        {
          cause: rawCause,
          task: {
            ...task("openai", "/secret/provider-home", "secret-native-task-id"),
            cwd: "/secret/project-home",
          },
        },
      ),
      { getPrototypeOf: () => prototype },
    );
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => { throw hostile; },
      }),
    );

    const failure = await registry.startTask("openai", {
      home: "/tmp/provider-home",
      cwd: "/work",
    }).catch((reason: unknown) => reason) as ProviderAdapterError;

    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(failure).not.toBe(hostile);
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(failure.cause).not.toBe(rawCause);
    expect((failure.cause as Error).message)
      .toBe("provider operation failure classification is invalid");
    expect((failure.cause as Error).cause).toBeUndefined();
    expect(failure).not.toHaveProperty("task");
    const projected = `${failure.message}\n${(failure.cause as Error).message}\n${JSON.stringify(failure)}`;
    for (const secret of [
      "spoofed prototype cause secret",
      "must-never-project",
      "secret-native-task-id",
      "/secret/provider-home",
      "/secret/project-home",
    ]) expect(projected).not.toContain(secret);
  });

  it.each([
    ["capability", ProviderCapabilityError.prototype, "PROVIDER_CAPABILITY_UNAVAILABLE"],
    ["registry-not-found", ProviderRegistryNotFoundError.prototype, "PROVIDER_ADAPTER_NOT_FOUND"],
    ["adapter", ProviderAdapterError.prototype, "PROVIDER_ADAPTER_FAILURE"],
  ] as const)("contains a non-proxy object with the foreign %s prototype", async (_name, prototype, code) => {
    let accessorReads = 0;
    const hostile = Object.create(prototype) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      code: { configurable: true, enumerable: true, value: code },
      message: {
        configurable: true,
        enumerable: true,
        value: "foreign prototype secret-native-task-id /secret/provider-home",
      },
      capability: {
        configurable: true,
        enumerable: true,
        get() { accessorReads += 1; return "secret-capability"; },
      },
      provider: {
        configurable: true,
        enumerable: true,
        get() { accessorReads += 1; return "secret-provider"; },
      },
      home: {
        configurable: true,
        enumerable: true,
        get() { accessorReads += 1; return "/secret/provider-home"; },
      },
      cause: {
        configurable: true,
        enumerable: true,
        get() { accessorReads += 1; return new Error("foreign cause secret"); },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { read: true }, {
        readTask: async () => { throw hostile; },
      }),
    );

    const failure = await registry.readTask(
      createNativeTaskKey("openai", "/tmp/provider-home", "task-1"),
    ).catch((reason: unknown) => reason) as ProviderAdapterError;

    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(failure).not.toBe(hostile);
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect((failure.cause as Error).message)
      .toBe("provider classified failure is invalid");
    expect((failure.cause as Error).cause).toBeUndefined();
    expect(accessorReads).toBe(0);
    expect(failure).not.toHaveProperty("task");
    const projected = `${failure.message}\n${(failure.cause as Error).message}\n${JSON.stringify(failure)}`;
    for (const secret of [
      "secret-native-task-id",
      "/secret/provider-home",
      "secret-capability",
      "secret-provider",
      "foreign cause secret",
    ]) expect(projected).not.toContain(secret);
  });

  it.each([
    ["capability", () => {
      const error = new ProviderCapabilityError("read", "openai");
      return { error, field: "capability" };
    }],
    ["registry-not-found", () => {
      const error = new ProviderRegistryNotFoundError("openai", "/tmp/provider-home");
      return { error, field: "home" };
    }],
    ["adapter", () => {
      const error = new ProviderAdapterError(
        "openai",
        "/tmp/provider-home",
        new Error("raw adapter cause secret"),
      );
      return { error, field: "provider" };
    }],
  ] as const)("contains a real %s failure with an accessor classification field", async (_name, create) => {
    const { error: hostile, field } = create();
    let accessorReads = 0;
    Object.defineProperty(hostile, field, {
      configurable: true,
      enumerable: true,
      get() {
        accessorReads += 1;
        return field === "home" ? "/secret/provider-home" : "secret-classification-value";
      },
    });
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { read: true }, {
        readTask: async () => { throw hostile; },
      }),
    );

    const failure = await registry.readTask(
      createNativeTaskKey("openai", "/tmp/provider-home", "task-1"),
    ).catch((reason: unknown) => reason) as ProviderAdapterError;

    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(failure).not.toBe(hostile);
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect((failure.cause as Error).message)
      .toBe("provider classified failure is invalid");
    expect((failure.cause as Error).cause).toBeUndefined();
    expect(accessorReads).toBe(0);
    const projected = `${failure.message}\n${(failure.cause as Error).message}\n${JSON.stringify(failure)}`;
    for (const secret of [
      "secret-classification-value",
      "/secret/provider-home",
      "raw adapter cause secret",
    ]) expect(projected).not.toContain(secret);
  });

  it.each([
    [
      "capability",
      () => new ProviderCapabilityError("read", "openai"),
      ProviderCapabilityError,
      { code: "PROVIDER_CAPABILITY_UNAVAILABLE", capability: "read", provider: "openai" },
    ],
    ["registry-not-found", () =>
      new ProviderRegistryNotFoundError("openai", "/tmp/provider-home"),
    ProviderRegistryNotFoundError,
    { code: "PROVIDER_ADAPTER_NOT_FOUND", provider: "openai", home: "/tmp/provider-home" }],
    ["adapter", () =>
      new ProviderAdapterError("openai", "/tmp/provider-home", new Error("raw cause secret")),
    ProviderAdapterError,
    { code: "PROVIDER_ADAPTER_FAILURE", provider: "openai", home: "/tmp/provider-home" }],
  ] as const)("reconstructs a legitimate non-proxy %s failure", async (_name, create, ErrorClass, fields) => {
    const expected = create();
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { read: true }, {
        readTask: async () => { throw expected; },
      }),
    );

    const failure = await registry.readTask(
      createNativeTaskKey("openai", "/tmp/provider-home", "task-1"),
    ).catch((reason: unknown) => reason) as Error;

    expect(failure).toBeInstanceOf(ErrorClass);
    expect(failure).not.toBe(expected);
    expect(failure).toMatchObject(fields);
    if (failure instanceof ProviderAdapterError) {
      expect(failure.cause).toBeInstanceOf(TypeError);
      expect(failure.cause).not.toBe(expected.cause);
      expect((failure.cause as Error).message).toBe("Provider adapter failure");
      expect((failure.cause as Error).cause).toBeUndefined();
    }
    expect(`${failure.message}\n${JSON.stringify(failure)}`).not.toContain("raw cause secret");
  });

  it("fills the invoked provider into a legitimate capability failure that omits it", async () => {
    const expected = new ProviderCapabilityError("read");
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { read: true }, {
        readTask: async () => { throw expected; },
      }),
    );

    const failure = await registry.readTask(
      createNativeTaskKey("openai", "/tmp/provider-home", "task-1"),
    ).catch((reason: unknown) => reason) as ProviderCapabilityError;

    expect(failure).toBeInstanceOf(ProviderCapabilityError);
    expect(failure).not.toBe(expected);
    expect(failure).toMatchObject({
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      capability: "read",
      provider: "openai",
    });
  });

  it("ownership-validates and snapshots a partial task for non-retryable recovery", async () => {
    const partial = task("openai", "/tmp/provider-home", "created-task");
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => {
          throw new ProviderOperationError("PARTIAL_START", "raw provider failure", {
            task: { ...partial, adapterSecret: "never-project" } as NativeTask,
          });
        },
      }),
    );

    const error = await registry.startTask("openai", {
      home: "/tmp/provider-home",
      cwd: "/work",
    }).catch((reason: unknown) => reason) as ProviderOperationError;
    expect(error).toBeInstanceOf(ProviderOperationError);
    expect(error).toMatchObject({
      code: "PARTIAL_START",
      task: { key: { nativeTaskId: "created-task" } },
    });
    expect(error.message).not.toContain("raw provider failure");
    expect(error.task).not.toHaveProperty("adapterSecret");
    expect(Object.isFrozen(error.task)).toBe(true);
    expect(Object.isFrozen(error.task?.key)).toBe(true);
  });

  it("contains a partial task projected under foreign ownership", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => {
          throw new ProviderOperationError("PARTIAL_START", "raw", {
            task: task("anthropic", "/tmp/provider-home", "foreign"),
          });
        },
      }),
    );
    await expect(registry.startTask("openai", {
      home: "/tmp/provider-home",
      cwd: "/work",
    })).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  it("never exposes the source task as a successful or partial fork", async () => {
    const source = createNativeTaskKey("openai", "/tmp/provider-home", "source-task");
    for (const forkTask of [
      async () => task("openai", "/tmp/provider-home", "source-task"),
      async () => {
        throw new ProviderOperationError("PARTIAL_FORK", "raw", {
          task: task("openai", "/tmp/provider-home", "source-task"),
        });
      },
    ]) {
      const registry = new ProviderRegistry();
      registry.register(
        "/tmp/provider-home",
        fakeAdapter("openai", { fork: true }, { forkTask }),
      );
      await expect(registry.forkTask(source)).rejects.toBeInstanceOf(ProviderAdapterError);
    }
  });

  it("rejects a task returned under a different provider", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { start: true }, {
        startTask: async () => task("anthropic", "/tmp/provider-home"),
      }),
    );

    await expect(
      registry.startTask("openai", { home: "/tmp/provider-home", cwd: "/work" }),
    ).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  it.each([false, true, null])(
    "preserves the exact tri-state archived value %s from an adapter",
    async (archived) => {
      const registry = new ProviderRegistry();
      registry.register(
        "/tmp/provider-home",
        fakeAdapter("openai", { list: true }, {
          listTasks: async () => ({
            items: [{ ...task("openai", "/tmp/provider-home"), archived }],
            nextCursor: null,
          }),
        }),
      );

      const page = await registry.listTasks("openai", { home: "/tmp/provider-home" });

      expect(page.items[0]?.archived).toBe(archived);
      expect(Object.isFrozen(page.items[0])).toBe(true);
    },
  );

  it("rejects an adapter archive state that is neither boolean nor unknown", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      "/tmp/provider-home",
      fakeAdapter("openai", { list: true }, {
        listTasks: async () => ({
          items: [{
            ...task("openai", "/tmp/provider-home"),
            archived: "false",
          } as never],
          nextCursor: null,
        }),
      }),
    );

    await expect(
      registry.listTasks("openai", { home: "/tmp/provider-home" }),
    ).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  it.each([
    { name: "list", capability: "list", method: "listTasks", nativeTaskId: "task-1" },
    { name: "read", capability: "read", method: "readTask", nativeTaskId: "task-1" },
    { name: "start", capability: "start", method: "startTask", nativeTaskId: "task-1" },
    { name: "resume", capability: "resume", method: "resumeTask", nativeTaskId: "task-1" },
    { name: "fork", capability: "fork", method: "forkTask", nativeTaskId: "fork-1" },
  ] as const)(
    "snapshots mutable adapter-owned $name results before exposing them",
    async ({ capability, method, nativeTaskId }) => {
      const providerKey = {
        provider: "openai" as const,
        home: "/tmp/provider-home",
        nativeTaskId,
      };
      const providerTask = {
        key: providerKey,
        title: "Provider title",
        cwd: "/work",
        model: null,
        status: "complete",
        createdAt: null,
        updatedAt: null,
        archived: false,
        source: "native",
        turns: [],
        adapterSecret: "adapter-secret-never-expose",
      } as NativeTask & { adapterSecret: string };
      const providerMethod = vi.fn(async () => method === "listTasks"
        ? { items: [providerTask], nextCursor: null }
        : providerTask);
      const registry = new ProviderRegistry();
      registry.register(
        providerKey.home,
        fakeAdapter(
          "openai",
          { [capability]: true } as Partial<ProviderCapabilities>,
          { [method]: providerMethod } as Partial<ProviderAdapter>,
        ),
      );
      const sourceKey = createNativeTaskKey("openai", providerKey.home, "task-1");

      const output = method === "listTasks"
        ? await registry.listTasks("openai", { home: providerKey.home })
        : method === "readTask"
          ? await registry.readTask(sourceKey, true)
          : method === "startTask"
            ? await registry.startTask("openai", { home: providerKey.home, cwd: "/work" })
            : method === "resumeTask"
              ? await registry.resumeTask(sourceKey)
              : await registry.forkTask(sourceKey);
      const exposed = "items" in output ? output.items[0]! : output;

      providerKey.nativeTaskId = "mutated-after-return";
      providerTask.title = "Mutated title";
      providerTask.adapterSecret = "mutated-adapter-secret";

      expect(exposed.key.nativeTaskId).toBe(nativeTaskId);
      expect(exposed.title).toBe("Provider title");
      expect(exposed).not.toHaveProperty("adapterSecret");
      expect(JSON.stringify(exposed)).not.toContain("adapter-secret-never-expose");
      expect(Object.isFrozen(exposed.key)).toBe(true);
      expect(Object.isFrozen(exposed)).toBe(true);
      expect(Object.isFrozen(output)).toBe(true);
    },
  );
});

describe("ProviderRegistry operation isolation", () => {
  it.each(extendedRegistryOperations)(
    "fails closed before invoking $name when $capability is false",
    async (operation) => {
      const method = vi.fn();
      const registry = new ProviderRegistry();
      registry.register(
        "/tmp/provider-home",
        fakeAdapter("openai", {}, { [operation.method]: method } as Partial<ProviderAdapter>),
      );
      const key = createNativeTaskKey("openai", "/tmp/provider-home", "task-1");

      await expect(operation.invoke(registry, key)).rejects.toMatchObject({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        capability: operation.capability,
        provider: "openai",
      });
      expect(method).not.toHaveBeenCalled();
    },
  );

  it.each(extendedRegistryOperations)(
    "dispatches $name only to the matching provider and home",
    async (operation) => {
      const key = createNativeTaskKey("openai", "/tmp/provider-home", "task-1");
      const openaiMethod = vi.fn(async () => {
        if (operation.method === "listTasks") {
          return { items: [task("openai", key.home, key.nativeTaskId)], nextCursor: null };
        }
        if (
          operation.method === "readTask" ||
          operation.method === "startTask" ||
          operation.method === "resumeTask"
        ) {
          return task("openai", key.home, key.nativeTaskId);
        }
        if (operation.method === "forkTask") {
          return task("openai", key.home, "fork-1");
        }
        if (operation.method === "send") {
          return { taskKey: key, turnId: "turn-2" };
        }
        if (operation.method === "subscribe") return () => undefined;
        return undefined;
      });
      const anthropicMethod = vi.fn();
      const enabled = { [operation.capability]: true } as Partial<ProviderCapabilities>;
      const registry = new ProviderRegistry();
      registry.register(
        key.home,
        fakeAdapter("openai", enabled, {
          [operation.method]: openaiMethod,
        } as Partial<ProviderAdapter>),
      );
      registry.register(
        key.home,
        fakeAdapter("anthropic", enabled, {
          [operation.method]: anthropicMethod,
        } as Partial<ProviderAdapter>),
      );

      await operation.invoke(registry, key);

      expect(openaiMethod).toHaveBeenCalledTimes(1);
      expect(anthropicMethod).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "command-approval", capability: "approveCommand", payload: { decision: "cancel" } },
    { kind: "file-change-approval", capability: "approveFileChange", payload: { decision: "cancel" } },
    { kind: "permission", capability: "approvePermissions", payload: { permissions: [] } },
    { kind: "user-input", capability: "requestUserInput", payload: { answers: {} } },
    { kind: "mcp-elicitation", capability: "mcpElicitation", payload: { decision: "cancel" } },
  ] as const)(
    "maps $kind responses only to the truthful $capability capability",
    async ({ kind, capability, payload }) => {
      const respond = vi.fn();
      let emit: ProviderEventSink | undefined;
      const registry = new ProviderRegistry();
      const key = createNativeTaskKey("openai", "/tmp/provider-home", "task-1");
      registry.register(key.home, fakeAdapter("openai", { subscribe: true }, {
        respond,
        subscribe: async (_key, sink) => {
          emit = sink;
          return () => undefined;
        },
      }));
      const identity = createProviderRequestIdentity({
        key,
        generation: 1,
        turnId: "turn-1",
        requestId: "request-1",
        itemId: "item-1",
        approvalId: null,
      });
      await registry.subscribe(key, vi.fn());
      emit?.({
        type: "request",
        provider: "openai",
        key,
        occurredAt: "2026-07-13T01:00:00.000Z",
        request: kind === "user-input"
          ? { kind, identity, autoResolutionMs: null }
          : { kind, identity },
      });

      await expect(registry.respond({ kind, identity, ...payload } as Parameters<
        ProviderRegistry["respond"]
      >[0])).rejects.toMatchObject({ capability });
      expect(respond).not.toHaveBeenCalled();
    },
  );
});

describe("ProviderRegistry descriptor census", () => {
  it("isolates capability probe failures with all-settled rows", async () => {
    const registry = new ProviderRegistry();
    registry.register("/tmp/openai", fakeAdapter("openai", { list: true }));
    registry.register("/tmp/anthropic", {
      ...fakeAdapter("anthropic", {}),
      capabilities: async () => {
        throw new Error("secret token=not-for-browser");
      },
    });

    const census = await registry.descriptorCensus();
    expect(census).toHaveLength(2);
    expect(census[0]).toMatchObject({
      provider: "openai",
      home: "/tmp/openai",
      status: "available",
      capabilities: { list: true },
    });
    expect(census[1]).toMatchObject({
      provider: "anthropic",
      home: "/tmp/anthropic",
      status: "unavailable",
      error: { code: "PROVIDER_ADAPTER_FAILURE" },
    });
    expect(JSON.stringify(census[1])).not.toContain("not-for-browser");
  });

  it("does not copy adapter-defined capability fields into the census", async () => {
    const registry = new ProviderRegistry();
    registry.register("/tmp/openai", {
      ...fakeAdapter("openai", {}),
      capabilities: async () => ({
        ...defineProviderCapabilities({ list: true }),
        internalAuthState: "never-browser-safe",
      }) as ProviderCapabilities,
    });

    const [descriptor] = await registry.descriptorCensus();

    expect(descriptor?.status).toBe("available");
    expect(descriptor).not.toHaveProperty("capabilities.internalAuthState");
    expect(JSON.stringify(descriptor)).not.toContain("never-browser-safe");
  });
});

describe("ProviderRegistry adapter trust boundaries", () => {
  it("allowlists and deep-freezes adapter-owned events returned in task turns", async () => {
    const key = createNativeTaskKey("openai", "/tmp/provider-home", "task-1");
    const secret = "Bearer adapter-secret-never-expose";
    const mutableEvent = {
      type: "message-delta",
      provider: "openai",
      key: { ...key },
      occurredAt: "2026-07-13T01:00:00.000Z",
      role: "assistant",
      delta: "safe original",
      turnId: "turn-1",
      itemId: "item-1",
      authorization: secret,
      internal: { token: secret },
    };
    const mutableTurn = {
      id: "turn-1",
      status: "complete",
      startedAt: null,
      completedAt: null,
      events: [mutableEvent],
      adapterInternal: secret,
    };
    const providerTask = {
      ...task("openai", key.home),
      turns: [mutableTurn],
    } as unknown as NativeTask;
    const registry = new ProviderRegistry();
    registry.register(key.home, fakeAdapter("openai", { read: true }, {
      readTask: async () => providerTask,
    }));

    const exposed = await registry.readTask(key, true);
    mutableEvent.delta = "mutated after return";
    mutableEvent.key.nativeTaskId = "mutated-task";
    mutableEvent.internal.token = "mutated secret";
    mutableTurn.status = "mutated";

    expect(exposed.turns[0]).toMatchObject({ id: "turn-1", status: "complete" });
    expect(exposed.turns[0]?.events[0]).toMatchObject({
      type: "message-delta",
      delta: "safe original",
      key,
    });
    expect(JSON.stringify(exposed)).not.toContain("adapter-secret-never-expose");
    expect(exposed.turns[0]?.events[0]).not.toHaveProperty("authorization");
    expect(exposed.turns[0]?.events[0]).not.toHaveProperty("internal");
    expect(Object.isFrozen(exposed.turns)).toBe(true);
    expect(Object.isFrozen(exposed.turns[0])).toBe(true);
    expect(Object.isFrozen(exposed.turns[0]?.events)).toBe(true);
    expect(Object.isFrozen(exposed.turns[0]?.events[0])).toBe(true);
    expect(Object.isFrozen(exposed.turns[0]?.events[0]?.key)).toBe(true);
  });

  it("allowlists and deep-freezes live adapter events before invoking a subscriber", async () => {
    const key = createNativeTaskKey("openai", "/tmp/provider-home", "task-1");
    const received: unknown[] = [];
    let adapterSink: ProviderEventSink | undefined;
    const registry = new ProviderRegistry();
    registry.register(key.home, fakeAdapter("openai", { subscribe: true }, {
      subscribe: async (_key, sink) => {
        adapterSink = sink;
        return () => undefined;
      },
    }));
    await registry.subscribe(key, (event) => received.push(event));
    const secret = "Bearer live-adapter-secret";
    const mutableEvent = {
      type: "activity",
      provider: "openai",
      key: { ...key },
      occurredAt: "2026-07-13T01:00:00.000Z",
      turnId: "turn-1",
      itemId: "item-1",
      activity: "command",
      status: "started",
      message: "pnpm test",
      authorization: secret,
      internal: { secret },
    };

    adapterSink?.(mutableEvent as never);
    mutableEvent.message = "mutated after emit";
    mutableEvent.key.nativeTaskId = "mutated-task";
    mutableEvent.internal.secret = "mutated secret";

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "activity",
      key,
      message: "pnpm test",
    });
    expect(received[0]).not.toHaveProperty("authorization");
    expect(received[0]).not.toHaveProperty("internal");
    expect(JSON.stringify(received[0])).not.toContain("live-adapter-secret");
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(Object.isFrozen((received[0] as { key: object }).key)).toBe(true);
  });

  it("rejects an embedded readTask event owned by another native task", async () => {
    const key = createNativeTaskKey("openai", "/tmp/provider-home", "task-1");
    const foreignKey = createNativeTaskKey("openai", key.home, "task-2");
    const secret = "cross-task-content-never-expose";
    const providerTask = {
      ...task("openai", key.home),
      turns: [{
        id: "turn-1",
        status: "complete",
        startedAt: null,
        completedAt: null,
        events: [{
          type: "message",
          provider: "openai",
          key: foreignKey,
          occurredAt: "2026-07-13T01:00:00.000Z",
          role: "assistant",
          text: secret,
          turnId: "turn-1",
          itemId: null,
        }],
      }],
    } as NativeTask;
    const registry = new ProviderRegistry();
    registry.register(key.home, fakeAdapter("openai", { read: true }, {
      readTask: async () => providerTask,
    }));

    const exposed = await registry.readTask(key, true);

    expect(exposed.turns[0]?.events[0]).toMatchObject({
      type: "diagnostic",
      code: "PROVIDER_EVENT_OWNERSHIP_MISMATCH",
      provider: "openai",
      key,
    });
    expect(JSON.stringify(exposed)).not.toContain(secret);
    expect(Object.isFrozen(exposed.turns[0]?.events[0])).toBe(true);
  });

  it.each([
    {
      label: "provider",
      provider: "anthropic" as const,
      foreignKey: createNativeTaskKey("anthropic", "/tmp/provider-home", "task-1"),
    },
    {
      label: "home",
      provider: "openai" as const,
      foreignKey: createNativeTaskKey("openai", "/tmp/provider-other-home", "task-1"),
    },
    {
      label: "native task id",
      provider: "openai" as const,
      foreignKey: createNativeTaskKey("openai", "/tmp/provider-home", "task-2"),
    },
  ])("rejects a live event with mismatched $label ownership", async ({ provider, foreignKey }) => {
    const key = createNativeTaskKey("openai", "/tmp/provider-home", "task-1");
    const received: unknown[] = [];
    let adapterSink: ProviderEventSink | undefined;
    const registry = new ProviderRegistry();
    registry.register(key.home, fakeAdapter("openai", { subscribe: true }, {
      subscribe: async (_key, sink) => {
        adapterSink = sink;
        return () => undefined;
      },
    }));
    await registry.subscribe(key, (event) => received.push(event));
    const secret = `foreign-${provider}-${foreignKey.home}-${foreignKey.nativeTaskId}`;

    adapterSink?.({
      type: "message",
      provider,
      key: foreignKey,
      occurredAt: "2026-07-13T01:00:00.000Z",
      role: "assistant",
      text: secret,
      turnId: "turn-1",
      itemId: null,
    } as never);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "diagnostic",
      code: "PROVIDER_EVENT_OWNERSHIP_MISMATCH",
      provider: "openai",
      key,
    });
    expect(JSON.stringify(received[0])).not.toContain(secret);
    expect(Object.isFrozen(received[0])).toBe(true);
  });
});

describe("ProviderRegistry subscription cleanup", () => {
  const key = createNativeTaskKey("openai", "/tmp/provider-subscription-home", "task-1");
  const identity = (requestId: number) => createProviderRequestIdentity({
    key,
    generation: 3,
    turnId: "turn-1",
    requestId,
    itemId: "item-1",
    approvalId: null,
  });
  const requestEvent = (requestIdentity: Readonly<ProviderRequestIdentity>) => ({
    type: "request" as const,
    provider: "openai" as const,
    key,
    occurredAt: "2026-07-13T01:00:00.000Z",
    request: { kind: "command-approval" as const, identity: requestIdentity },
  });
  const response = (requestIdentity: Readonly<ProviderRequestIdentity>): ProviderRequestResponse => ({
    kind: "command-approval",
    identity: requestIdentity,
    decision: "cancel",
  });

  it("awaits one underlying asynchronous unsubscribe and stops delivery immediately", async () => {
    let adapterSink: ProviderEventSink | undefined;
    let finishUnsubscribe!: () => void;
    const pendingUnsubscribe = new Promise<void>((resolve) => {
      finishUnsubscribe = resolve;
    });
    const adapterUnsubscribe = vi.fn(() => pendingUnsubscribe);
    const received: unknown[] = [];
    const registry = new ProviderRegistry();
    registry.register(key.home, fakeAdapter("openai", { subscribe: true }, {
      subscribe: async (_key, sink) => {
        adapterSink = sink;
        return adapterUnsubscribe;
      },
    }));
    const unsubscribe = await registry.subscribe(key, (event) => received.push(event));

    const first = Promise.resolve(unsubscribe());
    const second = Promise.resolve(unsubscribe());
    adapterSink?.({
      type: "message",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T01:00:00.000Z",
      role: "assistant",
      text: "must not escape after unsubscribe starts",
      turnId: "turn-1",
      itemId: "item-1",
    });

    expect(adapterUnsubscribe).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
    finishUnsubscribe();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("clears only pending requests observed by the subscription being removed", async () => {
    const sinks: ProviderEventSink[] = [];
    const adapterRespond = vi.fn(async () => undefined);
    const registry = new ProviderRegistry();
    registry.register(key.home, fakeAdapter("openai", {
      subscribe: true,
      approveCommand: true,
    }, {
      respond: adapterRespond,
      subscribe: async (_key, sink) => {
        sinks.push(sink);
        return () => undefined;
      },
    }));
    const unsubscribeFirst = await registry.subscribe(key, vi.fn());
    await registry.subscribe(key, vi.fn());
    const firstIdentity = identity(1);
    const secondIdentity = identity(2);
    sinks[0]?.(requestEvent(firstIdentity));
    sinks[1]?.(requestEvent(secondIdentity));

    await unsubscribeFirst();

    await expect(registry.respond(response(firstIdentity))).resolves.toBe("stale");
    await expect(registry.respond(response(secondIdentity))).resolves.toBe("dispatched");
    expect(adapterRespond).toHaveBeenCalledTimes(1);
  });

  it("retains a pending request still observed by another live subscription", async () => {
    const sinks: ProviderEventSink[] = [];
    const adapterRespond = vi.fn(async () => undefined);
    const registry = new ProviderRegistry();
    registry.register(key.home, fakeAdapter("openai", {
      subscribe: true,
      approveCommand: true,
    }, {
      respond: adapterRespond,
      subscribe: async (_key, sink) => {
        sinks.push(sink);
        return () => undefined;
      },
    }));
    const unsubscribeFirst = await registry.subscribe(key, vi.fn());
    await registry.subscribe(key, vi.fn());
    const sharedIdentity = identity(1);
    sinks[0]?.(requestEvent(sharedIdentity));
    sinks[1]?.(requestEvent(sharedIdentity));

    await unsubscribeFirst();

    await expect(registry.respond(response(sharedIdentity))).resolves.toBe("dispatched");
    expect(adapterRespond).toHaveBeenCalledTimes(1);
  });

  it("rolls back requests emitted by an adapter whose subscribe setup fails", async () => {
    const registry = new ProviderRegistry();
    const failedIdentity = identity(1);
    registry.register(key.home, fakeAdapter("openai", {
      subscribe: true,
      approveCommand: true,
    }, {
      subscribe: async (_key, sink) => {
        sink(requestEvent(failedIdentity));
        throw new Error("subscribe failed after emit");
      },
    }));

    await expect(registry.subscribe(key, vi.fn())).rejects.toBeInstanceOf(ProviderAdapterError);
    await expect(registry.respond(response(failedIdentity))).resolves.toBe("stale");
  });
});

describe("ProviderRegistry pending request ledger", () => {
  const key = createNativeTaskKey("openai", "/tmp/provider-ledger-home", "task-1");
  const identity = (overrides: Partial<ProviderRequestIdentity> = {}) =>
    createProviderRequestIdentity({
      key,
      generation: 3,
      turnId: "turn-1",
      requestId: 1,
      itemId: "item-1",
      approvalId: 2,
      ...overrides,
    });
  const response = (
    requestIdentity: Readonly<ProviderRequestIdentity> = identity(),
  ): ProviderRequestResponse => ({
    kind: "command-approval",
    identity: requestIdentity,
    decision: "cancel",
  });

  async function setup(respond = vi.fn(async () => undefined)) {
    let emit: ProviderEventSink | undefined;
    const registry = new ProviderRegistry();
    registry.register(key.home, fakeAdapter("openai", {
      subscribe: true,
      approveCommand: true,
    }, {
      respond,
      subscribe: async (_key, sink) => {
        emit = sink;
        return () => undefined;
      },
    }));
    await registry.subscribe(key, vi.fn());
    return { registry, respond, emit: (event: Parameters<ProviderEventSink>[0]) => emit?.(event) };
  }

  function requestEvent(requestIdentity: Readonly<ProviderRequestIdentity> = identity()) {
    return {
      type: "request" as const,
      provider: "openai" as const,
      key,
      occurredAt: "2026-07-13T01:00:00.000Z",
      request: { kind: "command-approval" as const, identity: requestIdentity },
    };
  }

  it("returns stale without adapter dispatch for an unseen response", async () => {
    const { registry, respond } = await setup();

    await expect(registry.respond(response())).resolves.toBe("stale");
    expect(respond).not.toHaveBeenCalled();
  });

  it("consumes a pending response once before adapter dispatch", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapterRespond = vi.fn(async () => pending);
    const { registry, emit } = await setup(adapterRespond);
    const exactIdentity = identity();
    emit(requestEvent(exactIdentity));

    const first = registry.respond(response(exactIdentity));
    await expect(registry.respond(response(exactIdentity))).resolves.toBe("stale");
    expect(adapterRespond).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe("dispatched");
  });

  it("does not re-arm a consumed identity when a duplicate request event is replayed", async () => {
    const { registry, respond, emit } = await setup();
    const exactIdentity = identity();
    emit(requestEvent(exactIdentity));
    await expect(registry.respond(response(exactIdentity))).resolves.toBe("dispatched");

    emit(requestEvent(exactIdentity));

    await expect(registry.respond(response(exactIdentity))).resolves.toBe("stale");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("removes a pending identity when the provider resolves it", async () => {
    const { registry, respond, emit } = await setup();
    const exactIdentity = identity();
    emit(requestEvent(exactIdentity));
    emit({
      type: "request-resolved",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T01:00:01.000Z",
      identity: exactIdentity,
    });

    await expect(registry.respond(response(exactIdentity))).resolves.toBe("stale");
    expect(respond).not.toHaveBeenCalled();
  });

  it("tombstones a resolution observed before a replayed request", async () => {
    const { registry, respond, emit } = await setup();
    const exactIdentity = identity();
    emit({
      type: "request-resolved",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T01:00:00.000Z",
      identity: exactIdentity,
    });

    emit(requestEvent(exactIdentity));

    await expect(registry.respond(response(exactIdentity))).resolves.toBe("stale");
    expect(respond).not.toHaveBeenCalled();
  });

  it("keeps numeric and string JSON-RPC ids in separate pending slots", async () => {
    const { registry, respond, emit } = await setup();
    const numericIdentity = identity({ requestId: 1, approvalId: 2 });
    emit(requestEvent(numericIdentity));

    await expect(registry.respond(response(identity({
      requestId: "1",
      approvalId: "2",
    })))).resolves.toBe("stale");
    await expect(registry.respond(response(numericIdentity))).resolves.toBe("dispatched");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("keeps restarted process generations in separate pending slots", async () => {
    const { registry, respond, emit } = await setup();
    const beforeRestart = identity({ generation: 3, requestId: 1, approvalId: 2 });
    const afterRestart = identity({ generation: 4, requestId: 1, approvalId: 2 });
    emit(requestEvent(afterRestart));

    await expect(registry.respond(response(beforeRestart))).resolves.toBe("stale");
    await expect(registry.respond(response(afterRestart))).resolves.toBe("dispatched");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "home", overrides: { key: createNativeTaskKey("openai", "/tmp/provider-ledger-other", "task-1") } },
    { label: "task", overrides: { key: createNativeTaskKey("openai", key.home, "task-2") } },
    { label: "turn", overrides: { turnId: "turn-2" } },
    { label: "item", overrides: { itemId: "item-2" } },
    { label: "approval", overrides: { approvalId: 3 } },
  ] as const)("does not route a response with a colliding request id across $label identity", async ({ overrides }) => {
    const { registry, respond, emit } = await setup();
    const exactIdentity = identity();
    emit(requestEvent(exactIdentity));

    await expect(registry.respond(response(identity(overrides)))).resolves.toBe("stale");
    await expect(registry.respond(response(exactIdentity))).resolves.toBe("dispatched");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("never re-arms a consumed response after adapter dispatch fails", async () => {
    const adapterRespond = vi.fn(async () => {
      throw new Error("uncertain provider failure");
    });
    const { registry, emit } = await setup(adapterRespond);
    const exactIdentity = identity();
    emit(requestEvent(exactIdentity));

    await expect(registry.respond(response(exactIdentity))).rejects.toBeInstanceOf(
      ProviderAdapterError,
    );
    await expect(registry.respond(response(exactIdentity))).resolves.toBe("stale");
    expect(adapterRespond).toHaveBeenCalledTimes(1);
  });

  it("fails closed when more than 512 provider requests are pending", async () => {
    const { registry, respond, emit } = await setup();
    for (let requestId = 0; requestId <= MAX_PENDING_PROVIDER_REQUESTS; requestId += 1) {
      emit(requestEvent(identity({ requestId, approvalId: null })));
    }

    await expect(registry.respond(response(identity({
      requestId: MAX_PENDING_PROVIDER_REQUESTS,
      approvalId: null,
    })))).resolves.toBe("stale");
    await expect(registry.respond(response(identity({
      requestId: MAX_PENDING_PROVIDER_REQUESTS - 1,
      approvalId: null,
    })))).resolves.toBe("dispatched");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("bounds terminal replay tombstones at 4096 identities", async () => {
    const { registry, emit } = await setup();
    for (let requestId = 0; requestId <= MAX_TERMINAL_PROVIDER_REQUESTS; requestId += 1) {
      const exactIdentity = identity({ requestId, approvalId: null });
      emit(requestEvent(exactIdentity));
      emit({
        type: "request-resolved",
        provider: "openai",
        key,
        occurredAt: "2026-07-13T01:00:01.000Z",
        identity: exactIdentity,
      });
    }

    const internal = registry as unknown as { terminalRequests: ReadonlySet<string> };
    expect(internal.terminalRequests.size).toBeLessThanOrEqual(MAX_TERMINAL_PROVIDER_REQUESTS);
    await expect(registry.respond(response(identity({
      requestId: MAX_TERMINAL_PROVIDER_REQUESTS,
      approvalId: null,
    })))).resolves.toBe("stale");
  });
});
