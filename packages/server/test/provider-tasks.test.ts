import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Engine } from "@devhub/engine";
import {
  ProviderCapabilityError,
  ProviderOperationError,
  ProviderRegistry,
  createNativeTaskKey,
  createProviderRequestIdentity,
  defineProviderCapabilities,
  type ListTasksInput,
  type NativeTask,
  type NativeTaskKey,
  type NativeTurnRef,
  type Page,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventSink,
  type ProviderId,
  type ProviderRequestResponse,
  type StartTaskInput,
  type TaskOverrides,
  type Unsubscribe,
  type UserInput,
} from "@devhub/engine/providers";
import { buildApp } from "../src/app.js";

const OPENAI_HOME = path.resolve(os.tmpdir(), "devhub-provider-openai");
const ANTHROPIC_HOME = path.resolve(os.tmpdir(), "devhub-provider-anthropic");

interface AdapterCalls {
  capabilities: number;
  list: ListTasksInput[];
  read: Array<{ key: NativeTaskKey; includeTurns: boolean }>;
  start: StartTaskInput[];
  resume: Array<{ key: NativeTaskKey; overrides?: TaskOverrides }>;
  fork: Array<{ key: NativeTaskKey; lastTurnId?: string }>;
  send: Array<{ key: NativeTaskKey; input: UserInput }>;
  steer: Array<{ key: NativeTaskKey; expectedTurnId: string; input: UserInput }>;
  interrupt: Array<{ key: NativeTaskKey; turnId: string }>;
  respond: ProviderRequestResponse[];
  archive: NativeTaskKey[];
  rename: Array<{ key: NativeTaskKey; name: string }>;
  acknowledgeReconciliation: Array<{ key: NativeTaskKey; fingerprint: string }>;
  subscribe: Array<{ key: NativeTaskKey; sink: ProviderEventSink }>;
}

interface AdapterBehavior {
  capabilities?: () => Promise<ProviderCapabilities>;
  list?: (input: ListTasksInput) => Promise<Page<NativeTask>>;
  read?: (key: NativeTaskKey, includeTurns: boolean) => Promise<NativeTask>;
  start?: (input: StartTaskInput) => Promise<NativeTask>;
  resume?: (key: NativeTaskKey, overrides?: TaskOverrides) => Promise<NativeTask>;
  fork?: (key: NativeTaskKey, lastTurnId?: string) => Promise<NativeTask>;
  send?: (key: NativeTaskKey, input: UserInput) => Promise<NativeTurnRef>;
  steer?: (key: NativeTaskKey, expectedTurnId: string, input: UserInput) => Promise<void>;
  interrupt?: (key: NativeTaskKey, turnId: string) => Promise<void>;
  respond?: (response: ProviderRequestResponse) => Promise<void>;
  archive?: (key: NativeTaskKey) => Promise<void>;
  rename?: (key: NativeTaskKey, name: string) => Promise<void>;
  acknowledgeReconciliation?: (key: NativeTaskKey, fingerprint: string) => Promise<void>;
  subscribe?: (key: NativeTaskKey, sink: ProviderEventSink) => Promise<Unsubscribe>;
}

function nativeTask(provider: ProviderId, home: string, nativeTaskId: string): NativeTask {
  return {
    key: createNativeTaskKey(provider, home, nativeTaskId),
    title: `${provider} task`,
    cwd: "/workspace/project",
    model: null,
    status: "idle",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    archived: false,
    source: "native",
    turns: [],
  };
}

function makeAdapter(
  provider: ProviderId,
  capabilities: ProviderCapabilities,
  behavior: AdapterBehavior = {},
): { adapter: ProviderAdapter; calls: AdapterCalls } {
  const calls: AdapterCalls = {
    capabilities: 0,
    list: [],
    read: [],
    start: [],
    resume: [],
    fork: [],
    send: [],
    steer: [],
    interrupt: [],
    respond: [],
    archive: [],
    rename: [],
    acknowledgeReconciliation: [],
    subscribe: [],
  };
  const unexpected = (method: string): never => {
    throw new Error(`unexpected adapter call: ${method}`);
  };

  const adapter: ProviderAdapter = {
    provider,
    async capabilities() {
      calls.capabilities += 1;
      return behavior.capabilities?.() ?? capabilities;
    },
    async listTasks(input) {
      calls.list.push(input);
      return behavior.list?.(input) ?? { items: [], nextCursor: null };
    },
    async readTask(key, includeTurns) {
      calls.read.push({ key, includeTurns });
      return behavior.read?.(key, includeTurns) ?? nativeTask(provider, key.home, key.nativeTaskId);
    },
    async startTask(input) {
      calls.start.push(input);
      return behavior.start?.(input) ?? nativeTask(provider, input.home, "started-task");
    },
    async resumeTask(key, overrides) {
      calls.resume.push({ key, ...(overrides ? { overrides } : {}) });
      return behavior.resume?.(key, overrides) ?? nativeTask(provider, key.home, key.nativeTaskId);
    },
    async forkTask(key, lastTurnId) {
      calls.fork.push({ key, ...(lastTurnId ? { lastTurnId } : {}) });
      return behavior.fork?.(key, lastTurnId) ?? nativeTask(provider, key.home, "forked-task");
    },
    async send(key, input) {
      calls.send.push({ key, input });
      return behavior.send?.(key, input) ?? { taskKey: key, turnId: "turn-new" };
    },
    async steer(key, expectedTurnId, input) {
      calls.steer.push({ key, expectedTurnId, input });
      return behavior.steer?.(key, expectedTurnId, input);
    },
    async interrupt(key, turnId) {
      calls.interrupt.push({ key, turnId });
      return behavior.interrupt?.(key, turnId);
    },
    async respond(response) {
      calls.respond.push(response);
      return behavior.respond?.(response);
    },
    async archive(key) {
      calls.archive.push(key);
      return behavior.archive?.(key);
    },
    async rename(key, name) {
      calls.rename.push({ key, name });
      return behavior.rename?.(key, name);
    },
    async acknowledgeReconciliation(key, fingerprint) {
      calls.acknowledgeReconciliation.push({ key, fingerprint });
      return behavior.acknowledgeReconciliation?.(key, fingerprint);
    },
    async subscribe(key, sink) {
      calls.subscribe.push({ key, sink });
      return behavior.subscribe?.(key, sink) ?? unexpected("subscribe");
    },
  };

  return { adapter, calls };
}

interface AppHandle {
  app: FastifyInstance;
  engine: Engine;
  root: string;
}

const activeApps: AppHandle[] = [];

async function makeApp(
  providerRegistry: ProviderRegistry,
  token = "",
): Promise<FastifyInstance> {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-provider-route-test-"));
  const engine = new Engine(path.join(root, "index.db"));
  const { app } = buildApp({ engine, providerRegistry, token });
  await app.ready();
  activeApps.push({ app, engine, root });
  return app;
}

async function listenApp(app: FastifyInstance): Promise<string> {
  return app.listen({ host: "127.0.0.1", port: 0 });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("timed out waiting for provider SSE")), 2_000);
      }),
    ]);
    if (result.done || !result.value) throw new Error("provider SSE ended unexpectedly");
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

afterEach(async () => {
  for (const handle of activeApps.splice(0).reverse()) {
    await handle.app.close();
    handle.engine.close();
    rmSync(handle.root, { recursive: true, force: true });
  }
});

describe("provider task HTTP seam", () => {
  it("returns a descriptor census while isolating one failing adapter", async () => {
    const registry = new ProviderRegistry();
    const available = makeAdapter(
      "openai",
      defineProviderCapabilities({ list: true, read: true }),
    );
    const unavailable = makeAdapter(
      "anthropic",
      defineProviderCapabilities({ list: true }),
      { capabilities: async () => { throw new Error("provider is offline"); } },
    );
    registry.register(OPENAI_HOME, available.adapter);
    registry.register(ANTHROPIC_HOME, unavailable.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/providers" });

    expect(response.statusCode).toBe(200);
    const census = response.json() as Array<{
      provider: ProviderId;
      home: string;
      status: "available" | "unavailable";
      capabilities?: ProviderCapabilities;
      error?: { code: string };
    }>;
    expect(census).toHaveLength(2);
    expect(census.find((row) => row.provider === "openai")).toMatchObject({
      provider: "openai",
      home: OPENAI_HOME,
      status: "available",
      capabilities: { list: true, read: true, start: false },
    });
    expect(census.find((row) => row.provider === "anthropic")).toEqual({
      provider: "anthropic",
      home: ANTHROPIC_HOME,
      status: "unavailable",
      error: {
        code: "PROVIDER_ADAPTER_FAILURE",
        message: "provider is offline",
      },
    });
    expect(available.calls.capabilities).toBe(1);
    expect(unavailable.calls.capabilities).toBe(1);
  });

  it("lists tasks through only the matching provider and home", async () => {
    const registry = new ProviderRegistry();
    const expected = nativeTask("openai", OPENAI_HOME, "openai-task-1");
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ list: true }),
      { list: async () => ({ items: [expected], nextCursor: "next-page" }) },
    );
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ list: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    registry.register(OPENAI_HOME, anthropic.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(OPENAI_HOME)}&cursor=cursor-1&limit=25&includeArchived=true`,
    });

    expect(response.statusCode).toBe(200);
    const { turns: _adapterOnlyTurns, ...expectedSummary } = expected;
    expect(response.json()).toEqual({ items: [expectedSummary], nextCursor: "next-page" });
    expect(response.json().items[0]).not.toHaveProperty("turns");
    expect(openai.calls.list).toEqual([{
      home: OPENAI_HOME,
      cursor: "cursor-1",
      limit: 25,
      includeArchived: true,
    }]);
    expect(anthropic.calls.list).toEqual([]);
  });

  it("round-trips a valid provider list cursor longer than a native task id", async () => {
    const longCursor = `dhlc1.${"a".repeat(700)}`;
    const registry = new ProviderRegistry();
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ list: true }),
      {
        list: async (request) => ({
          items: [],
          nextCursor: request.cursor === undefined ? longCursor : null,
        }),
      },
    );
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry);

    const first = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(OPENAI_HOME)}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().nextCursor).toBe(longCursor);

    const second = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(OPENAI_HOME)}&cursor=${encodeURIComponent(longCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(openai.calls.list.at(-1)).toEqual({ home: OPENAI_HOME, cursor: longCursor });
  });

  it("reads one native task and forwards the optional includeTurns flag", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ read: true }));
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ read: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    registry.register(OPENAI_HOME, anthropic.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/native-task-7?home=${encodeURIComponent(OPENAI_HOME)}&includeTurns=true`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().key).toEqual({
      provider: "openai",
      home: OPENAI_HOME,
      nativeTaskId: "native-task-7",
    });
    expect(openai.calls.read).toEqual([{
      key: createNativeTaskKey("openai", OPENAI_HOME, "native-task-7"),
      includeTurns: true,
    }]);
    expect(anthropic.calls.read).toEqual([]);
  });

  it("maps native-task-missing to an exact value-free provider 404", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ read: true }),
      {
        read: async () => {
          throw new ProviderOperationError(
            "NATIVE_TASK_MISSING",
            "thread not loaded: secret-native-task-id",
            { cause: new Error(`secret home ${OPENAI_HOME}`) },
          );
        },
      },
    );
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/secret-native-task-id?home=${encodeURIComponent(OPENAI_HOME)}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "provider_task_not_found",
      code: "NATIVE_TASK_MISSING",
      provider: "openai",
    });
    expect(response.body).not.toContain("secret-native-task-id");
    expect(response.body).not.toContain(OPENAI_HOME);
    expect(response.body).not.toContain("secret home");
  });

  it("contains a malformed typed provider failure before HTTP projection", async () => {
    let accessorReads = 0;
    const hostile = Object.create(ProviderCapabilityError.prototype) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      code: {
        configurable: true,
        enumerable: true,
        value: "PROVIDER_CAPABILITY_UNAVAILABLE",
      },
      message: {
        configurable: true,
        enumerable: true,
        value: "secret-native-task-id /secret/provider-home raw trap message",
      },
      provider: {
        configurable: true,
        enumerable: true,
        get() { accessorReads += 1; return "secret-provider"; },
      },
      capability: {
        configurable: true,
        enumerable: true,
        get() { accessorReads += 1; return "secret-capability"; },
      },
      home: {
        configurable: true,
        enumerable: true,
        get() { accessorReads += 1; return "/secret/provider-home"; },
      },
      cause: {
        configurable: true,
        enumerable: true,
        get() { accessorReads += 1; return new Error("secret cause"); },
      },
    });
    const registry = new ProviderRegistry();
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ read: true }),
      { read: async () => { throw hostile; } },
    );
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/secret-native-task-id?home=${encodeURIComponent(OPENAI_HOME)}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "provider_unavailable",
      code: "PROVIDER_ADAPTER_FAILURE",
      provider: "openai",
    });
    expect(accessorReads).toBe(0);
    for (const secret of [
      "secret-native-task-id",
      "/secret/provider-home",
      "secret-provider",
      "secret-capability",
      "raw trap message",
      "secret cause",
    ]) expect(response.body).not.toContain(secret);
  });

  it("maps a legitimate provider-omitted capability failure with the invoked provider", async () => {
    const raw = new ProviderCapabilityError("read");
    const registry = new ProviderRegistry();
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ read: true }),
      { read: async () => { throw raw; } },
    );
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/native-task-7?home=${encodeURIComponent(OPENAI_HOME)}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "provider_capability_unavailable",
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      provider: "openai",
      capability: "read",
    });
    expect(response.body).not.toContain(raw.message);
  });

  it("returns 404 for an unknown provider without invoking an adapter", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ list: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/other/tasks?home=${encodeURIComponent(OPENAI_HOME)}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "provider_not_found",
      code: "PROVIDER_ADAPTER_NOT_FOUND",
      provider: "other",
    });
    expect(openai.calls.capabilities).toBe(0);
    expect(openai.calls.list).toEqual([]);
  });

  it("returns 409 when the selected provider lacks the requested capability", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ list: false }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(OPENAI_HOME)}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "provider_capability_unavailable",
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      provider: "openai",
      capability: "list",
    });
    expect(openai.calls.list).toEqual([]);
  });

  it("returns 503 when the selected adapter fails without probing another provider", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ list: true }),
      { list: async () => { throw new Error("runtime disconnected"); } },
    );
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ list: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    registry.register(OPENAI_HOME, anthropic.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(OPENAI_HOME)}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "provider_unavailable",
      code: "PROVIDER_ADAPTER_FAILURE",
      provider: "openai",
    });
    expect(openai.calls.list).toHaveLength(1);
    expect(anthropic.calls.capabilities).toBe(0);
    expect(anthropic.calls.list).toEqual([]);
  });

  it("uses header-only auth for provider reads before revealing validation details", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ list: true, read: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const descriptor = await app.inject({
      method: "GET",
      url: "/api/providers?token=secret",
    });
    const invalidList = await app.inject({
      method: "GET",
      url: "/api/providers/openai/tasks?token=secret",
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/task-1?home=${encodeURIComponent(OPENAI_HOME)}&token=secret`,
    });
    const headerAndUrlToken = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(OPENAI_HOME)}&token=secret`,
      headers: { authorization: "Bearer secret" },
    });
    for (const response of [descriptor, invalidList, read, headerAndUrlToken]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    }
    expect(openai.calls.list).toEqual([]);
    expect(openai.calls.read).toEqual([]);

    const authorized = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(OPENAI_HOME)}`,
      headers: { authorization: "Bearer secret" },
    });
    expect(authorized.statusCode).toBe(200);
    expect(openai.calls.list).toHaveLength(1);
  });

  it("rejects unknown list query fields instead of forwarding a widened request", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ list: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(OPENAI_HOME)}&unexpected=true`,
    });
    const urlCredential = await app.inject({
      method: "GET",
      url: "/api/providers?token=not-configured",
    });

    expect(response.statusCode).toBe(400);
    expect(urlCredential.statusCode).toBe(401);
    expect(urlCredential.json()).toEqual({ error: "unauthorized" });
    expect(openai.calls.list).toEqual([]);
  });
});

describe("provider task mutation authentication", () => {
  const startPayload: StartTaskInput = {
    home: OPENAI_HOME,
    cwd: "/workspace/project",
    input: { text: "Start the task" },
  };

  it("disables mutations when the server has no configured token", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ start: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "");

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks",
      payload: startPayload,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "provider_mutations_disabled" });
    expect(openai.calls.start).toEqual([]);
  });

  it("does not authorize a mutation with only a query-string token", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ start: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks?token=secret",
      payload: startPayload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    const headerAndUrlToken = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks?token=secret",
      headers: { authorization: "Bearer secret" },
      payload: startPayload,
    });
    expect(headerAndUrlToken.statusCode).toBe(401);
    expect(headerAndUrlToken.json()).toEqual({ error: "unauthorized" });
    expect(openai.calls.start).toEqual([]);
  });

  it("rejects a valid Bearer mutation when start is not supported", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ start: false }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks",
      headers: { authorization: "Bearer secret" },
      payload: startPayload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "provider_capability_unavailable",
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      provider: "openai",
      capability: "start",
    });
    expect(openai.calls.start).toEqual([]);
  });

  it("delegates a valid Bearer mutation only to the selected start-capable adapter", async () => {
    const registry = new ProviderRegistry();
    const expected = nativeTask("openai", OPENAI_HOME, "created-task");
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ start: true }),
      { start: async () => expected },
    );
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ start: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    registry.register(OPENAI_HOME, anthropic.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks",
      headers: { authorization: "Bearer secret" },
      payload: startPayload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(expected);
    expect(openai.calls.start).toEqual([startPayload]);
    expect(anthropic.calls.start).toEqual([]);
  });

  it("returns a created partial task instead of inviting a duplicate start retry", async () => {
    const registry = new ProviderRegistry();
    const expected = nativeTask("openai", OPENAI_HOME, "created-before-turn-failed");
    const created = {
      ...expected,
      adapterOnlySecret: "sk-live-adapter-only-secret",
    } as NativeTask;
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ start: true }),
      {
        start: async () => {
          throw new ProviderOperationError(
            "PARTIAL_START",
            "raw adapter detail with sk-live-super-secret",
            { task: created },
          );
        },
      },
    );
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks",
      headers: { authorization: "Bearer secret" },
      payload: startPayload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      outcome: "partial",
      code: "PARTIAL_START",
      provider: "openai",
      task: expected,
    });
    expect(response.body).not.toContain("adapterOnlySecret");
    expect(response.body).not.toContain("adapter-only-secret");
    expect(response.body).not.toContain("raw adapter detail");
    expect(response.body).not.toContain("super-secret");
    expect(openai.calls.start).toEqual([startPayload]);
  });

  it("maps typed invalid provider input to a safe non-retryable client error", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ start: true }),
      {
        start: async () => {
          throw new ProviderOperationError(
            "INVALID_INPUT",
            "unsafe provider detail with sk-live-super-secret",
          );
        },
      },
    );
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks",
      headers: { authorization: "Bearer secret" },
      payload: startPayload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "provider_invalid_request",
      code: "INVALID_INPUT",
      provider: "openai",
    });
    expect(response.body).not.toContain("unsafe provider detail");
    expect(response.body).not.toContain("super-secret");
  });

  it("maps every safe provider operation classification without exposing its message", async () => {
    const cases = [
      { code: "UNSAFE_OVERRIDE", status: 400, error: "provider_invalid_request" },
      { code: "POLICY_MISMATCH", status: 409, error: "provider_policy_mismatch" },
      {
        code: "RECONCILIATION_REQUIRED",
        status: 409,
        error: "provider_reconciliation_required",
      },
      { code: "DISABLED", status: 409, error: "provider_runtime_disabled" },
      {
        code: "UNSUPPORTED_INTERACTION",
        status: 409,
        error: "provider_interaction_unavailable",
      },
      { code: "SUBSCRIPTION_CAPACITY", status: 429, error: "provider_capacity_reached" },
      { code: "DISPOSED", status: 503, error: "provider_unavailable" },
      { code: "OWNERSHIP", status: 503, error: "provider_unavailable" },
    ] as const;
    let nextCode: typeof cases[number]["code"] = "UNSAFE_OVERRIDE";
    const registry = new ProviderRegistry();
    const openai = makeAdapter(
      "openai",
      defineProviderCapabilities({ start: true }),
      {
        start: async () => {
          throw new ProviderOperationError(
            nextCode,
            `unsafe adapter detail for ${nextCode} with sk-live-super-secret`,
          );
        },
      },
    );
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    for (const expected of cases) {
      nextCode = expected.code;
      const response = await app.inject({
        method: "POST",
        url: "/api/providers/openai/tasks",
        headers: { authorization: "Bearer secret" },
        payload: startPayload,
      });
      expect(response.statusCode, expected.code).toBe(expected.status);
      expect(response.json(), expected.code).toEqual({
        error: expected.error,
        code: expected.code,
        provider: "openai",
      });
      expect(response.body).not.toContain("unsafe adapter detail");
      expect(response.body).not.toContain("super-secret");
    }
  });
});

describe("provider reconciliation acknowledgement", () => {
  const taskId = "native-task-reconcile";
  const key = createNativeTaskKey("anthropic", ANTHROPIC_HOME, taskId);
  const fingerprint = "revision-fingerprint-current";
  const reviewedTask = (): NativeTask => ({
    ...nativeTask("anthropic", ANTHROPIC_HOME, taskId),
    revision: {
      updatedAt: 1,
      status: "idle",
      lastTurnId: null,
      lastTurnStatus: null,
      lastItemId: null,
      fingerprint,
    },
  });

  it("requires mutation authentication before parsing acknowledgement details", async () => {
    const registry = new ProviderRegistry();
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ read: true }), {
      read: async () => reviewedTask(),
    });
    registry.register(ANTHROPIC_HOME, anthropic.adapter);
    const app = await makeApp(registry, "secret");

    for (const request of [
      { url: `/api/providers/anthropic/tasks/${taskId}/reconciliation`, payload: { home: ANTHROPIC_HOME, fingerprint } },
      { url: `/api/providers/anthropic/tasks/${taskId}/reconciliation?token=secret`, payload: { unexpected: "secret-shape" } },
    ]) {
      const response = await app.inject({ method: "POST", ...request });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    }
    expect(anthropic.calls.read).toEqual([]);
    expect(anthropic.calls.acknowledgeReconciliation).toEqual([]);
  });

  it("keeps acknowledgement disabled without a configured mutation token", async () => {
    const registry = new ProviderRegistry();
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ read: true }), {
      read: async () => reviewedTask(),
    });
    registry.register(ANTHROPIC_HOME, anthropic.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "POST",
      url: `/api/providers/anthropic/tasks/${taskId}/reconciliation`,
      payload: { home: ANTHROPIC_HOME, fingerprint },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "provider_mutations_disabled" });
    expect(anthropic.calls.read).toEqual([]);
  });

  it("acknowledges the exact reviewed fingerprint through the selected adapter", async () => {
    const registry = new ProviderRegistry();
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ read: true }), {
      read: async () => reviewedTask(),
    });
    registry.register(ANTHROPIC_HOME, anthropic.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: `/api/providers/anthropic/tasks/${taskId}/reconciliation`,
      headers: { authorization: "Bearer secret" },
      payload: { home: ANTHROPIC_HOME, fingerprint },
    });
    expect(response.statusCode).toBe(204);
    expect(anthropic.calls.read).toEqual([{ key, includeTurns: true }]);
    expect(anthropic.calls.acknowledgeReconciliation).toEqual([{ key, fingerprint }]);
  });

  it("rejects stale and malformed acknowledgement without clearing the adapter latch", async () => {
    const registry = new ProviderRegistry();
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ read: true }), {
      read: async () => reviewedTask(),
    });
    registry.register(ANTHROPIC_HOME, anthropic.adapter);
    const app = await makeApp(registry, "secret");
    const headers = { authorization: "Bearer secret" };

    const stale = await app.inject({
      method: "POST",
      url: `/api/providers/anthropic/tasks/${taskId}/reconciliation`,
      headers,
      payload: { home: ANTHROPIC_HOME, fingerprint: "revision-fingerprint-stale" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: "provider_reconciliation_required",
      code: "RECONCILIATION_REQUIRED",
      provider: "anthropic",
    });

    const extra = await app.inject({
      method: "POST",
      url: `/api/providers/anthropic/tasks/${taskId}/reconciliation`,
      headers,
      payload: { home: ANTHROPIC_HOME, fingerprint, extra: true },
    });
    expect(extra.statusCode).toBe(400);
    expect(anthropic.calls.acknowledgeReconciliation).toEqual([]);
  });
});

describe("provider task lifecycle mutations", () => {
  const taskId = "native-task-7";
  const key = createNativeTaskKey("openai", OPENAI_HOME, taskId);
  const input: UserInput = {
    text: "Continue safely",
    attachments: [{ name: "notes.txt", path: "/workspace/notes.txt", mediaType: "text/plain" }],
  };

  const actionRequests = [
    { path: "resume", payload: { home: OPENAI_HOME } },
    { path: "fork", payload: { home: OPENAI_HOME, lastTurnId: "turn-4" } },
    { path: "send", payload: { home: OPENAI_HOME, input } },
    { path: "steer", payload: { home: OPENAI_HOME, expectedTurnId: "turn-4", input } },
    { path: "interrupt", payload: { home: OPENAI_HOME, turnId: "turn-4" } },
    {
      path: "respond",
      payload: {
        home: OPENAI_HOME,
        kind: "command-approval",
        identity: {
          generation: 2,
          turnId: "turn-4",
          requestId: 1,
          itemId: "item-1",
          approvalId: 2,
        },
        decision: "deny",
      },
    },
    { path: "archive", payload: { home: OPENAI_HOME } },
    { path: "rename", payload: { home: OPENAI_HOME, name: "Renamed task" } },
  ] as const;

  it("requires the exact Bearer header for every lifecycle mutation", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({
      resume: true,
      fork: true,
      send: true,
      steer: true,
      interrupt: true,
      approveCommand: true,
      archive: true,
      rename: true,
    }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    for (const action of actionRequests) {
      const response = await app.inject({
        method: "POST",
        url: `/api/providers/openai/tasks/${taskId}/${action.path}?token=secret`,
        payload: action.payload,
      });
      expect(response.statusCode, action.path).toBe(401);
      expect(response.json(), action.path).toEqual({ error: "unauthorized" });
    }

    expect(openai.calls.resume).toEqual([]);
    expect(openai.calls.fork).toEqual([]);
    expect(openai.calls.send).toEqual([]);
    expect(openai.calls.steer).toEqual([]);
    expect(openai.calls.interrupt).toEqual([]);
    expect(openai.calls.respond).toEqual([]);
    expect(openai.calls.archive).toEqual([]);
    expect(openai.calls.rename).toEqual([]);
  });

  it("authenticates before revealing lifecycle payload validation", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ resume: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/resume?token=secret`,
      payload: { unexpected: "payload detail" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(openai.calls.resume).toEqual([]);
  });

  it("keeps every lifecycle mutation disabled when no server token is configured", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ resume: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry);

    const response = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/resume`,
      payload: { home: OPENAI_HOME },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "provider_mutations_disabled" });
    expect(openai.calls.resume).toEqual([]);
  });

  it("delegates lifecycle mutations with immutable ownership only to the selected adapter", async () => {
    const registry = new ProviderRegistry();
    const capabilities = defineProviderCapabilities({
      resume: true,
      fork: true,
      send: true,
      steer: true,
      interrupt: true,
      archive: true,
      rename: true,
    });
    const openai = makeAdapter("openai", capabilities);
    const anthropic = makeAdapter("anthropic", capabilities);
    registry.register(OPENAI_HOME, openai.adapter);
    registry.register(OPENAI_HOME, anthropic.adapter);
    const app = await makeApp(registry, "secret");
    const headers = { authorization: "Bearer secret" };

    const resume = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/resume`,
      headers,
      payload: {
        home: OPENAI_HOME,
        model: "gpt-5",
        mode: "code",
        permissionMode: "workspace-write",
      },
    });
    const fork = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/fork`,
      headers,
      payload: { home: OPENAI_HOME, lastTurnId: "turn-4" },
    });
    const send = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/send`,
      headers,
      payload: { home: OPENAI_HOME, input },
    });
    const steer = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/steer`,
      headers,
      payload: { home: OPENAI_HOME, expectedTurnId: "turn-4", input },
    });
    const interrupt = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/interrupt`,
      headers,
      payload: { home: OPENAI_HOME, turnId: "turn-4" },
    });
    const archive = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/archive`,
      headers,
      payload: { home: OPENAI_HOME },
    });
    const rename = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/rename`,
      headers,
      payload: { home: OPENAI_HOME, name: "  Renamed task  " },
    });

    expect(resume.statusCode).toBe(200);
    expect(resume.json().key).toEqual(key);
    expect(fork.statusCode).toBe(201);
    expect(fork.json().key.nativeTaskId).toBe("forked-task");
    expect(send.statusCode).toBe(202);
    expect(send.json()).toEqual({ taskKey: key, turnId: "turn-new" });
    for (const response of [steer, interrupt, archive, rename]) {
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    }

    expect(openai.calls.resume).toEqual([{
      key,
      overrides: { model: "gpt-5", mode: "code", permissionMode: "workspace-write" },
    }]);
    expect(openai.calls.fork).toEqual([{ key, lastTurnId: "turn-4" }]);
    expect(openai.calls.send).toEqual([{ key, input }]);
    expect(openai.calls.steer).toEqual([{ key, expectedTurnId: "turn-4", input }]);
    expect(openai.calls.interrupt).toEqual([{ key, turnId: "turn-4" }]);
    expect(openai.calls.archive).toEqual([key]);
    expect(openai.calls.rename).toEqual([{ key, name: "Renamed task" }]);
    expect(anthropic.calls.resume).toEqual([]);
    expect(anthropic.calls.fork).toEqual([]);
    expect(anthropic.calls.send).toEqual([]);
    expect(anthropic.calls.steer).toEqual([]);
    expect(anthropic.calls.interrupt).toEqual([]);
    expect(anthropic.calls.archive).toEqual([]);
    expect(anthropic.calls.rename).toEqual([]);
  });

  it("maps an unsupported lifecycle capability without invoking the adapter", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ resume: false }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/resume`,
      headers: { authorization: "Bearer secret" },
      payload: { home: OPENAI_HOME },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "provider_capability_unavailable",
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      provider: "openai",
      capability: "resume",
    });
    expect(openai.calls.resume).toEqual([]);
  });

  it("returns a created partial fork without leaking adapter-only task fields", async () => {
    const taskId = "source-task";
    const expected = nativeTask("openai", OPENAI_HOME, "created-fork");
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ fork: true }), {
      fork: async () => {
        throw new ProviderOperationError(
          "PARTIAL_FORK",
          "raw fork detail with sk-live-super-secret",
          {
            task: {
              ...expected,
              adapterOnlySecret: "sk-live-adapter-only-secret",
            } as NativeTask,
          },
        );
      },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/fork`,
      headers: { authorization: "Bearer secret" },
      payload: { home: OPENAI_HOME, lastTurnId: "turn-1" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      outcome: "partial",
      code: "PARTIAL_FORK",
      provider: "openai",
      task: expected,
    });
    expect(response.body).not.toContain("raw fork detail");
    expect(response.body).not.toContain("adapterOnlySecret");
    expect(response.body).not.toContain("adapter-only-secret");
    expect(openai.calls.fork).toEqual([{
      key: createNativeTaskKey("openai", OPENAI_HOME, taskId),
      lastTurnId: "turn-1",
    }]);
  });

  it("never reports a same-id partial fork as a newly created task", async () => {
    const taskId = "source-task";
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ fork: true }), {
      fork: async () => {
        throw new ProviderOperationError(
          "PARTIAL_FORK",
          "provider incorrectly projected the source as a fork",
          { task: nativeTask("openai", OPENAI_HOME, taskId) },
        );
      },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/fork`,
      headers: { authorization: "Bearer secret" },
      payload: { home: OPENAI_HOME, lastTurnId: "turn-1" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "provider_unavailable",
      code: "PROVIDER_ADAPTER_FAILURE",
      provider: "openai",
    });
    expect(response.body).not.toContain("outcome");
    expect(response.body).not.toContain("provider incorrectly projected");
  });

  it("enforces bounded exact request schemas before adapter delegation", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ send: true, rename: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");
    const headers = { authorization: "Bearer secret" };

    const cases = [
      {
        url: `/api/providers/openai/tasks/${taskId}/rename`,
        payload: { home: OPENAI_HOME, name: "n".repeat(201) },
      },
      {
        url: `/api/providers/openai/tasks/${taskId}/send`,
        payload: { home: OPENAI_HOME, input: { text: "x".repeat(100_001) } },
      },
      {
        url: `/api/providers/openai/tasks/${taskId}/send`,
        payload: { home: OPENAI_HOME, input, unexpected: true },
      },
      {
        url: `/api/providers/openai/tasks/${taskId}/fork`,
        payload: { home: OPENAI_HOME, lastTurnId: "i".repeat(513) },
      },
      {
        url: `/api/providers/openai/tasks/${taskId}/send`,
        payload: { home: OPENAI_HOME, input: { text: 42 } },
      },
      {
        url: `/api/providers/openai/tasks/${taskId}/send`,
        payload: {
          home: OPENAI_HOME,
          input: {
            text: "attachment",
            attachments: { name: "notes.txt", path: "/workspace/notes.txt" },
          },
        },
      },
      {
        url: `/api/providers/openai/tasks/${taskId}/rename`,
        payload: { home: OPENAI_HOME, name: 42 },
      },
    ];

    for (const request of cases) {
      const response = await app.inject({ method: "POST", headers, ...request });
      expect(response.statusCode).toBe(400);
    }
    expect(openai.calls.send).toEqual([]);
    expect(openai.calls.rename).toEqual([]);
  });

  it("never exposes an adapter error cause or secret in a mutation response", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ send: true }), {
      send: async () => { throw new Error("runtime failed with sk-live-super-secret"); },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/send`,
      headers: { authorization: "Bearer secret" },
      payload: { home: OPENAI_HOME, input },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "provider_unavailable",
      code: "PROVIDER_ADAPTER_FAILURE",
      provider: "openai",
    });
    expect(response.body).not.toContain("runtime failed");
    expect(response.body).not.toContain("super-secret");
  });

  it("marks uncertain start, fork, and send outcomes as explicitly non-retryable", async () => {
    const registry = new ProviderRegistry();
    const uncertain = async (): Promise<never> => {
      throw new ProviderOperationError(
        "MUTATION_UNCERTAIN",
        "provider may have committed sk-live-super-secret",
      );
    };
    const openai = makeAdapter("openai", defineProviderCapabilities({
      start: true,
      fork: true,
      send: true,
    }), {
      start: uncertain,
      fork: uncertain,
      send: uncertain,
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");
    const headers = { authorization: "Bearer secret" };

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/providers/openai/tasks",
        headers,
        payload: { home: OPENAI_HOME, cwd: "/workspace/project" },
      }),
      app.inject({
        method: "POST",
        url: `/api/providers/openai/tasks/${taskId}/fork`,
        headers,
        payload: { home: OPENAI_HOME },
      }),
      app.inject({
        method: "POST",
        url: `/api/providers/openai/tasks/${taskId}/send`,
        headers,
        payload: { home: OPENAI_HOME, input },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "provider_mutation_uncertain",
        code: "MUTATION_UNCERTAIN",
        provider: "openai",
        retryable: false,
      });
      expect(response.body).not.toContain("committed");
      expect(response.body).not.toContain("super-secret");
      expect(response.body).not.toContain("task");
    }
  });
});

describe("provider request response route", () => {
  it("reconstructs generation-aware identities without collapsing numeric and string RPC ids", async () => {
    const taskId = "native-task-requests";
    const key = createNativeTaskKey("openai", OPENAI_HOME, taskId);
    let emit: ProviderEventSink | undefined;
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({
      subscribe: true,
      approveCommand: true,
      approvePermissions: true,
      requestUserInput: true,
    }), {
      subscribe: async (_key, sink) => {
        emit = sink;
        return () => undefined;
      },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const unsubscribe = await registry.subscribe(key, () => undefined);
    const numericIdentity = createProviderRequestIdentity({
      key,
      generation: 7,
      turnId: "turn-1",
      requestId: 1,
      itemId: "item-1",
      approvalId: 2,
    });
    const stringIdentity = createProviderRequestIdentity({
      key,
      generation: 7,
      turnId: "turn-1",
      requestId: "1",
      itemId: "item-1",
      approvalId: "2",
    });
    const permissionIdentity = createProviderRequestIdentity({
      key,
      generation: 7,
      turnId: "turn-1",
      requestId: 3,
      itemId: "item-3",
      approvalId: null,
    });
    const userInputIdentity = createProviderRequestIdentity({
      key,
      generation: 7,
      turnId: "turn-1",
      requestId: 4,
      itemId: "item-4",
      approvalId: null,
    });
    const requestEvent = (identity: typeof numericIdentity): ProviderEvent => ({
      type: "request",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T01:00:00.000Z",
      request: { kind: "command-approval", identity },
    });
    emit?.(requestEvent(numericIdentity));
    emit?.(requestEvent(stringIdentity));
    emit?.({
      type: "request",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T01:00:00.000Z",
      request: { kind: "permission", identity: permissionIdentity },
    });
    emit?.({
      type: "request",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T01:00:00.000Z",
      request: { kind: "user-input", identity: userInputIdentity, autoResolutionMs: null },
    });
    const app = await makeApp(registry, "secret");
    const headers = { authorization: "Bearer secret" };
    const base = {
      home: OPENAI_HOME,
      kind: "command-approval",
      decision: "deny",
    } as const;

    const stringResponse = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/respond`,
      headers,
      payload: {
        ...base,
        identity: {
          generation: 7,
          turnId: "turn-1",
          requestId: "1",
          itemId: "item-1",
          approvalId: "2",
        },
      },
    });
    const numericResponse = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/respond`,
      headers,
      payload: {
        ...base,
        identity: {
          generation: 7,
          turnId: "turn-1",
          requestId: 1,
          itemId: "item-1",
          approvalId: 2,
        },
      },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/respond`,
      headers,
      payload: {
        ...base,
        identity: {
          generation: 7,
          turnId: "turn-1",
          requestId: 1,
          itemId: "item-1",
          approvalId: 2,
        },
      },
    });
    const permissionResponse = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/respond`,
      headers,
      payload: {
        home: OPENAI_HOME,
        kind: "permission",
        identity: {
          generation: 7,
          turnId: "turn-1",
          requestId: 3,
          itemId: "item-3",
          approvalId: null,
        },
        permissions: ["workspace-read", "workspace-write"],
      },
    });
    const userInputResponse = await app.inject({
      method: "POST",
      url: `/api/providers/openai/tasks/${taskId}/respond`,
      headers,
      payload: {
        home: OPENAI_HOME,
        kind: "user-input",
        identity: {
          generation: 7,
          turnId: "turn-1",
          requestId: 4,
          itemId: "item-4",
          approvalId: null,
        },
        answers: { scope: "workspace" },
      },
    });

    expect(stringResponse.statusCode).toBe(200);
    expect(stringResponse.json()).toEqual({ status: "dispatched" });
    expect(numericResponse.statusCode).toBe(200);
    expect(numericResponse.json()).toEqual({ status: "dispatched" });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ status: "stale" });
    expect(permissionResponse.json()).toEqual({ status: "dispatched" });
    expect(userInputResponse.json()).toEqual({ status: "dispatched" });
    expect(openai.calls.respond).toHaveLength(4);
    expect(openai.calls.respond[0]?.identity).toEqual(stringIdentity);
    expect(openai.calls.respond[1]?.identity).toEqual(numericIdentity);
    expect(openai.calls.respond[2]).toEqual({
      kind: "permission",
      identity: permissionIdentity,
      permissions: ["workspace-read", "workspace-write"],
    });
    expect(openai.calls.respond[3]).toEqual({
      kind: "user-input",
      identity: userInputIdentity,
      answers: { scope: "workspace" },
    });
    await unsubscribe();
  });

  it("rejects unsafe response identities and fields before request correlation", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ approveCommand: true }));
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");
    const url = "/api/providers/openai/tasks/task-1/respond";
    const headers = { authorization: "Bearer secret" };
    const valid = {
      home: OPENAI_HOME,
      kind: "command-approval",
      identity: {
        generation: 1,
        turnId: null,
        requestId: 1,
        itemId: null,
        approvalId: null,
      },
      decision: "cancel",
    } as const;
    const invalidBodies = [
      { ...valid, identity: { ...valid.identity, requestId: Number.MAX_SAFE_INTEGER + 1 } },
      { ...valid, identity: { ...valid.identity, generation: -1 } },
      { ...valid, identity: { ...valid.identity, unexpected: "field" } },
      { ...valid, decision: "always" },
      {
        home: OPENAI_HOME,
        kind: "permission",
        identity: valid.identity,
        permissions: [1],
      },
      {
        home: OPENAI_HOME,
        kind: "user-input",
        identity: valid.identity,
        answers: { question: 1 },
      },
    ];

    for (const payload of invalidBodies) {
      const response = await app.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode).toBe(400);
    }
    expect(openai.calls.respond).toEqual([]);
  });
});

describe("provider task SSE subscription", () => {
  const taskId = "native-task-stream";
  const key = createNativeTaskKey("openai", OPENAI_HOME, taskId);

  it("rejects URL-token authentication and streams with an Authorization header", async () => {
    let emit: ProviderEventSink | undefined;
    let unsubscribeStarted = 0;
    let unsubscribeFinished = 0;
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ subscribe: true }), {
      subscribe: async (_key, sink) => {
        emit = sink;
        return async () => {
          unsubscribeStarted += 1;
          await Promise.resolve();
          unsubscribeFinished += 1;
        };
      },
    });
    const anthropic = makeAdapter("anthropic", defineProviderCapabilities({ subscribe: true }), {
      subscribe: async () => () => undefined,
    });
    registry.register(OPENAI_HOME, openai.adapter);
    registry.register(OPENAI_HOME, anthropic.adapter);
    const app = await makeApp(registry, "secret");

    const queryToken = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/${taskId}/events?home=${encodeURIComponent(OPENAI_HOME)}&token=secret`,
    });
    expect(queryToken.statusCode).toBe(401);
    expect(queryToken.json()).toEqual({ error: "unauthorized" });
    const headerAndUrlToken = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/${taskId}/events?home=${encodeURIComponent(OPENAI_HOME)}&token=secret`,
      headers: { authorization: "Bearer secret" },
    });
    expect(headerAndUrlToken.statusCode).toBe(401);
    expect(headerAndUrlToken.json()).toEqual({ error: "unauthorized" });
    expect(openai.calls.subscribe).toEqual([]);

    const address = await listenApp(app);
    const controller = new AbortController();
    const response = await fetch(
      `${address}/api/providers/openai/tasks/${taskId}/events?home=${encodeURIComponent(OPENAI_HOME)}`,
      { headers: { authorization: "Bearer secret" }, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = decoder.decode((await readChunkWithTimeout(reader)).value, { stream: true });
    expect(body).toContain(": connected");

    emit?.({
      type: "message-delta",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T01:00:00.000Z",
      role: "assistant",
      delta: "streamed text",
      turnId: "turn-1",
      itemId: "item-1",
    });
    while (!body.includes("data:")) {
      body += decoder.decode((await readChunkWithTimeout(reader)).value, { stream: true });
    }
    expect(body).toContain('"type":"message-delta"');
    expect(body).toContain('"delta":"streamed text"');
    expect(openai.calls.subscribe.map((call) => call.key)).toEqual([key]);
    expect(anthropic.calls.subscribe).toEqual([]);

    await reader.cancel();
    controller.abort();
    await waitFor(() => unsubscribeFinished === 1, "provider unsubscribe did not finish");
    expect(unsubscribeStarted).toBe(1);
  });

  it("authenticates a URL-token stream before revealing query validation", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ subscribe: true }), {
      subscribe: async () => () => undefined,
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/${taskId}/events?token=secret`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(openai.calls.subscribe).toEqual([]);
  });

  it("replaces an oversized provider event with a bounded metadata-only diagnostic", async () => {
    let emit: ProviderEventSink | undefined;
    let unsubscribes = 0;
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ subscribe: true }), {
      subscribe: async (_key, sink) => {
        emit = sink;
        return () => {
          unsubscribes += 1;
        };
      },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");
    const address = await listenApp(app);
    const controller = new AbortController();
    const response = await fetch(
      `${address}/api/providers/openai/tasks/${taskId}/events?home=${encodeURIComponent(OPENAI_HOME)}`,
      { headers: { authorization: "Bearer secret" }, signal: controller.signal },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = decoder.decode((await readChunkWithTimeout(reader)).value, { stream: true });

    emit?.({
      type: "message",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T01:00:00.000Z",
      role: "assistant",
      text: "password=x ".repeat(25_000),
      turnId: "turn-1",
      itemId: "item-1",
    });
    while (!body.includes("data:")) {
      body += decoder.decode((await readChunkWithTimeout(reader)).value, { stream: true });
    }

    expect(body).toContain("PROVIDER_EVENT_TOO_LARGE");
    expect(body).not.toContain("password=x password=x");
    expect(Buffer.byteLength(body)).toBeLessThan(270_000);
    await reader.cancel();
    controller.abort();
    await waitFor(() => unsubscribes === 1, "oversized stream did not unsubscribe");
  });

  it("fails closed and unsubscribes when synchronous pre-header events overflow the queue", async () => {
    let unsubscribes = 0;
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ subscribe: true }), {
      subscribe: async (_key, sink) => {
        for (let index = 0; index < 4; index += 1) {
          sink({
            type: "message",
            provider: "openai",
            key,
            occurredAt: "2026-07-13T01:00:00.000Z",
            role: "assistant",
            text: "password=x ".repeat(8_000),
            turnId: "turn-1",
            itemId: `item-${index}`,
          });
        }
        return () => {
          unsubscribes += 1;
        };
      },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");

    const response = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks/${taskId}/events?home=${encodeURIComponent(OPENAI_HOME)}`,
      headers: { authorization: "Bearer secret" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "provider_stream_overloaded" });
    expect(unsubscribes).toBe(1);
  });

  it("maps subscribe rejection without leaking the adapter cause or consuming a slot", async () => {
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ subscribe: true }), {
      subscribe: async () => {
        throw new Error("subscribe failed with sk-live-super-secret");
      },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");
    const request = () => app.inject({
      method: "GET" as const,
      url: `/api/providers/openai/tasks/${taskId}/events?home=${encodeURIComponent(OPENAI_HOME)}`,
      headers: { authorization: "Bearer secret" },
    });

    const first = await request();
    const second = await request();
    for (const response of [first, second]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "provider_unavailable",
        code: "PROVIDER_ADAPTER_FAILURE",
        provider: "openai",
      });
      expect(response.body).not.toContain("super-secret");
    }
    expect(openai.calls.subscribe).toHaveLength(2);
  });

  it("caps concurrent streams and releases every reservation on close", async () => {
    let unsubscribes = 0;
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ subscribe: true }), {
      subscribe: async () => async () => {
        unsubscribes += 1;
        throw new Error("cleanup failed with sk-live-super-secret");
      },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");
    const address = await listenApp(app);
    const url = `${address}/api/providers/openai/tasks/${taskId}/events?home=${encodeURIComponent(OPENAI_HOME)}`;
    const controllers: AbortController[] = [];
    const request = (track = true) => {
      const controller = new AbortController();
      if (track) controllers.push(controller);
      return fetch(url, {
        headers: { authorization: "Bearer secret" },
        signal: controller.signal,
      });
    };

    const streams = await Promise.all(Array.from({ length: 32 }, request));
    expect(streams.every((response) => response.status === 200)).toBe(true);
    const overflow = await request(false);
    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toEqual({ error: "provider_stream_limit_reached" });
    expect(openai.calls.subscribe).toHaveLength(32);

    await Promise.all(streams.map((response) => response.body?.cancel()));
    for (const controller of controllers) controller.abort();
    await waitFor(() => unsubscribes === 32, "not every stream released its subscription");

    const replacementController = new AbortController();
    const replacement = await fetch(url, {
      headers: { authorization: "Bearer secret" },
      signal: replacementController.signal,
    });
    expect(replacement.status).toBe(200);
    await replacement.body?.cancel();
    replacementController.abort();
    await waitFor(() => unsubscribes === 33, "rejected cleanup did not release stream capacity");
  });

  it("keeps aborted in-flight subscriptions counted until they can be cleaned up", async () => {
    const subscribeReleases: Array<() => void> = [];
    let unsubscribes = 0;
    const registry = new ProviderRegistry();
    const openai = makeAdapter("openai", defineProviderCapabilities({ subscribe: true }), {
      subscribe: async () => {
        await new Promise<void>((resolve) => subscribeReleases.push(resolve));
        return async () => {
          unsubscribes += 1;
        };
      },
    });
    registry.register(OPENAI_HOME, openai.adapter);
    const app = await makeApp(registry, "secret");
    const address = await listenApp(app);
    const url = `${address}/api/providers/openai/tasks/${taskId}/events?home=${encodeURIComponent(OPENAI_HOME)}`;
    const controllers = Array.from({ length: 32 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      fetch(url, {
        headers: { authorization: "Bearer secret" },
        signal: controller.signal,
      }).catch(() => undefined));
    await waitFor(
      () => openai.calls.subscribe.length === 32,
      "in-flight provider subscriptions did not reach the cap",
    );
    for (const controller of controllers) controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    const overflowController = new AbortController();
    const overflowTimeout = setTimeout(() => overflowController.abort(), 1_000);
    try {
      const overflow = await fetch(url, {
        headers: { authorization: "Bearer secret" },
        signal: overflowController.signal,
      });
      expect(overflow.status).toBe(429);
      expect(await overflow.json()).toEqual({ error: "provider_stream_limit_reached" });
      expect(openai.calls.subscribe).toHaveLength(32);
    } finally {
      clearTimeout(overflowTimeout);
      overflowController.abort();
      for (const release of subscribeReleases) release();
      await Promise.all(pending);
    }
    await waitFor(() => unsubscribes === 32, "in-flight subscriptions were not cleaned up");
  });
});
