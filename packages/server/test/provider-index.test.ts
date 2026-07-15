/**
 * Authenticated, locator-only indexed task routes (M5 Task 5).
 *
 * HERMETIC: a real Engine (temp SQLite) so the shared ProviderTaskIndexStore exists, a
 * non-spawning explicit Codex install that contributes one trusted registered home, and a
 * fake ProviderRegistry adapter registered at that exact canonical home. The Codex runtime
 * is never enabled, so no provider process is spawned; every provider call hits the fake.
 *
 * These pin the Task 5 contract: locator-only public surface (no raw home / NUL bytes on any
 * success/error/SSE surface), flag-gated activation, bearer+trusted-origin mutation auth with
 * no query-string tokens, list ordering/cursor + scope-change rejection, freshness read-through,
 * fenced mutations, reconciliation get/ack, additive meta, single-flight rebuild, and the
 * subscribe-buffer-snapshot-drain-live SSE protocol.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Engine } from "@devhub/engine";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  ProviderOperationError,
  ProviderRegistry,
  createNativeTaskKey,
  defineProviderCapabilities,
  homeFingerprint,
  normalizeProviderEvent,
  serializeTaskLocator,
  taskLocator,
  type ListTasksInput,
  type NativeTask,
  type NativeTaskKey,
  type NativeTaskSummary,
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

const TOKEN = "index-token-9";

interface AdapterBehavior {
  capabilities?: () => Promise<ProviderCapabilities>;
  list?: (input: ListTasksInput) => Promise<Page<NativeTaskSummary>>;
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
  subscribe?: (key: NativeTaskKey, sink: ProviderEventSink) => Promise<Unsubscribe>;
}

const FULL_CAPS = defineProviderCapabilities({
  list: true,
  read: true,
  start: true,
  resume: true,
  fork: true,
  send: true,
  steer: true,
  interrupt: true,
  subscribe: true,
  approveCommand: true,
  approveFileChange: true,
  approvePermissions: true,
  requestUserInput: true,
  mcpElicitation: true,
  archive: true,
  rename: true,
});

/** A minimal but store-valid native summary (real native tasks always carry a revision). */
function summaryFor(
  provider: ProviderId,
  home: string,
  nativeTaskId: string,
  overrides: Partial<NativeTaskSummary> = {},
): NativeTaskSummary {
  return {
    key: createNativeTaskKey(provider, home, nativeTaskId),
    title: `task ${nativeTaskId}`,
    cwd: "/workspace/project",
    model: "gpt-x",
    status: "idle",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    archived: false,
    source: "native",
    revision: {
      updatedAt: 1,
      status: "complete",
      lastTurnId: "turn-1",
      lastTurnStatus: "complete",
      lastItemId: "item-1",
      fingerprint: `openai:v1:${nativeTaskId}`,
    },
    ...overrides,
  };
}

/** A store-valid native snapshot: consistent revision plus one turn/event. */
function nativeTask(
  provider: ProviderId,
  home: string,
  nativeTaskId: string,
  overrides: Partial<NativeTask> = {},
): NativeTask {
  const key = createNativeTaskKey(provider, home, nativeTaskId);
  const event = normalizeProviderEvent(
    { type: "message", role: "assistant", text: "response", turnId: "turn-1", itemId: "item-1" },
    { provider, key, occurredAt: "2026-07-14T00:00:30.000Z" },
  );
  return {
    ...summaryFor(provider, home, nativeTaskId),
    key,
    turns: [{
      id: "turn-1",
      status: "complete",
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:01:00.000Z",
      events: [event],
    }],
    ...overrides,
  };
}

function makeAdapter(
  provider: ProviderId,
  behavior: AdapterBehavior = {},
): ProviderAdapter {
  return {
    provider,
    async capabilities() {
      return behavior.capabilities?.() ?? FULL_CAPS;
    },
    async listTasks(input) {
      return behavior.list?.(input) ?? { items: [], nextCursor: null };
    },
    async readTask(key, includeTurns) {
      return behavior.read?.(key, includeTurns) ?? nativeTask(provider, key.home, key.nativeTaskId);
    },
    async startTask(input) {
      return behavior.start?.(input) ?? nativeTask(provider, input.home, "started-task");
    },
    async resumeTask(key, overrides) {
      return behavior.resume?.(key, overrides) ?? nativeTask(provider, key.home, key.nativeTaskId);
    },
    async forkTask(key, lastTurnId) {
      return behavior.fork?.(key, lastTurnId) ?? nativeTask(provider, key.home, "forked-task");
    },
    async send(key, input) {
      return behavior.send?.(key, input) ?? { taskKey: key, turnId: "turn-new" };
    },
    async steer(key, expectedTurnId, input) {
      return behavior.steer?.(key, expectedTurnId, input);
    },
    async interrupt(key, turnId) {
      return behavior.interrupt?.(key, turnId);
    },
    async respond(response) {
      return behavior.respond?.(response);
    },
    async archive(key) {
      return behavior.archive?.(key);
    },
    async rename(key, name) {
      return behavior.rename?.(key, name);
    },
    async subscribe(key, sink) {
      if (behavior.subscribe) return behavior.subscribe(key, sink);
      return () => undefined;
    },
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly engine: Engine;
  readonly root: string;
  readonly codexHome: string;
  readonly fingerprint: string;
  readonly token: string | undefined;
  locatorFor(nativeTaskId: string): string;
  authHeaders(extra?: Record<string, string>): Record<string, string>;
}

const active: Array<{ app: FastifyInstance; engine: Engine; root: string }> = [];

async function harness(opts: {
  token?: string;
  behavior?: AdapterBehavior;
  enableFlag?: boolean;
} = {}): Promise<Harness> {
  const token = opts.token;
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-provider-index-test-"));
  const homeDir = path.join(root, "codex-home");
  mkdirSync(homeDir);
  const codexHome = realpathSync(homeDir);

  // Inject a fake adapter at the trusted home and register that home explicitly (a
  // DoD-sanctioned BuildOptions registration source), so no real native runtime is spawned.
  const registry = new ProviderRegistry();
  registry.register(codexHome, makeAdapter("openai", opts.behavior));

  const engine = new Engine(path.join(root, "index.db"));
  const { app } = buildApp({
    engine,
    providerRegistry: registry,
    nativeCodex: false,
    nativeClaude: false,
    providerHomes: [{ provider: "openai", home: codexHome }],
    ...(token === undefined ? {} : { token }),
  });
  await app.ready();
  active.push({ app, engine, root });

  const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...extra,
  });

  if (opts.enableFlag !== false) {
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: authHeaders(),
      payload: { devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, unifiedTaskIndex: true } },
    });
    if (enabled.statusCode !== 200) {
      throw new Error(`failed to enable unifiedTaskIndex: ${enabled.statusCode}`);
    }
  }

  const fingerprint = homeFingerprint("openai", codexHome);
  return {
    app,
    engine,
    root,
    codexHome,
    fingerprint,
    token,
    authHeaders,
    locatorFor: (nativeTaskId: string) =>
      serializeTaskLocator(taskLocator(createNativeTaskKey("openai", codexHome, nativeTaskId))),
  };
}

/** Recursively assert no canonical-home substring and no NUL byte appears anywhere. */
function assertNoHomeOrNul(text: string, home: string): void {
  expect(text).not.toContain(home);
  expect(text.includes(String.fromCharCode(0))).toBe(false);
}

afterEach(async () => {
  for (const handle of active.splice(0).reverse()) {
    await handle.app.close();
    try { handle.engine.close(); } catch { /* already closed */ }
    rmSync(handle.root, { recursive: true, force: true });
  }
});

describe("indexed routes: flag gating", () => {
  it("reports the feature disabled on every route while the flag is off", async () => {
    const h = await harness({ enableFlag: false });
    const homes = await h.app.inject({ method: "GET", url: "/api/provider-index/homes" });
    expect(homes.statusCode).toBe(404);
    expect(homes.json().error).toBe("unified_task_index_disabled");

    const list = await h.app.inject({ method: "GET", url: "/api/provider-index/tasks" });
    expect(list.statusCode).toBe(404);
  });

  it("activates the routes once the flag is applied true", async () => {
    const h = await harness();
    const homes = await h.app.inject({ method: "GET", url: "/api/provider-index/homes" });
    expect(homes.statusCode).toBe(200);
  });
});

describe("indexed routes: homes", () => {
  it("returns locator-only public homes with fingerprint and capabilities, never the raw home", async () => {
    const h = await harness();
    const response = await h.app.inject({ method: "GET", url: "/api/provider-index/homes" });
    expect(response.statusCode).toBe(200);
    const homes = response.json();
    expect(Array.isArray(homes)).toBe(true);
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatchObject({
      provider: "openai",
      homeFingerprint: h.fingerprint,
      status: "available",
    });
    expect(homes[0].capabilities.list).toBe(true);
    // Only the fingerprint form of the home crosses the boundary, never the raw path.
    expect(Object.keys(homes[0])).toEqual(
      expect.arrayContaining(["provider", "homeFingerprint", "status", "capabilities"]),
    );
    assertNoHomeOrNul(response.body, h.codexHome);
  });
});

describe("indexed routes: auth", () => {
  it("disables the whole mutation surface without a configured token", async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${h.locatorFor("t1")}/archive`,
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("provider_mutations_disabled");
  });

  it("rejects a wrong bearer, a query-string token, and an untrusted origin", async () => {
    const h = await harness({ token: TOKEN });
    const locator = h.locatorFor("t1");

    const wrong = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${locator}/archive`,
      headers: { authorization: "Bearer nope" },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);

    const queryToken = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${locator}/archive?token=${TOKEN}`,
      payload: {},
    });
    expect(queryToken.statusCode).toBe(401);

    const badOrigin = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${locator}/archive`,
      headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example.com" },
      payload: {},
    });
    expect(badOrigin.statusCode).toBe(403);
  });

  it("accepts a valid bearer with no origin (same-origin) for mutations", async () => {
    const h = await harness({ token: TOKEN });
    const response = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${h.locatorFor("t1")}/archive`,
      headers: h.authHeaders(),
      payload: {},
    });
    expect(response.statusCode).toBe(204);
  });
});

describe("indexed routes: list + cursor", () => {
  it("returns an empty active page before any rebuild", async () => {
    const h = await harness();
    const response = await h.app.inject({ method: "GET", url: "/api/provider-index/tasks" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
  });

  it("rejects a home fingerprint without its provider scope", async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: "GET",
      url: `/api/provider-index/tasks?homeFingerprint=${h.fingerprint}`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("orders updatedAt DESC and paginates without skips or duplicates after a rebuild", async () => {
    const summaries: NativeTaskSummary[] = [];
    for (let i = 0; i < 5; i += 1) {
      summaries.push(summaryFor("openai", "PLACEHOLDER", `task-${i}`, {
        updatedAt: `2026-07-1${i}T00:00:00.000Z`,
      }));
    }
    const h = await harness({
      token: TOKEN,
      behavior: {
        list: async (input) => ({
          items: summaries.map((s) => ({
            ...s,
            key: createNativeTaskKey("openai", input.home, s.key.nativeTaskId),
          })),
          nextCursor: null,
        }),
        read: async (key) => nativeTask("openai", key.home, key.nativeTaskId, {
          updatedAt: summaries.find((s) => s.key.nativeTaskId === key.nativeTaskId)?.updatedAt ?? null,
        }),
      },
    });

    const rebuilt = await h.app.inject({
      method: "POST",
      url: "/api/provider-index/rebuild",
      headers: h.authHeaders(),
      payload: { provider: "openai", homeFingerprint: h.fingerprint },
    });
    expect(rebuilt.statusCode).toBe(200);
    expect(rebuilt.json().taskCount).toBe(5);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = `/api/provider-index/tasks?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await h.app.inject({ method: "GET", url, headers: h.authHeaders() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const item of body.items) seen.push(item.locator.nativeTaskId);
      assertNoHomeOrNul(response.body, h.codexHome);
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(["task-4", "task-3", "task-2", "task-1", "task-0"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("rejects a malformed cursor", async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: "GET",
      url: "/api/provider-index/tasks?cursor=not-a-real-cursor",
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("indexed routes: read + freshness", () => {
  it("reads a native snapshot with reconciliation and never leaks the home", async () => {
    const h = await harness({
      behavior: { read: async (key) => nativeTask("openai", key.home, key.nativeTaskId) },
    });
    const response = await h.app.inject({
      method: "GET",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}?freshness=native`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.freshness).toBe("native");
    expect(body.task.locator.nativeTaskId).toBe("task-a");
    expect(body.reconciliation.required).toBe(false);
    assertNoHomeOrNul(response.body, h.codexHome);
  });

  it("maps an authoritative-missing task to a value-free 404", async () => {
    const h = await harness({
      behavior: {
        read: async () => {
          throw new ProviderOperationError("NATIVE_TASK_MISSING", "gone");
        },
      },
    });
    const response = await h.app.inject({
      method: "GET",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NATIVE_TASK_MISSING");
    assertNoHomeOrNul(response.body, h.codexHome);
  });

  it("rejects an unparsable locator", async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: "GET",
      url: "/api/provider-index/tasks/not-a-locator",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_locator");
  });
});

describe("indexed routes: mutations", () => {
  it("starts a task and returns a path-free indexed snapshot", async () => {
    const h = await harness({
      token: TOKEN,
      behavior: { start: async (input) => nativeTask("openai", input.home, "new-task") },
    });
    const response = await h.app.inject({
      method: "POST",
      url: "/api/provider-index/tasks",
      headers: h.authHeaders(),
      payload: { provider: "openai", homeFingerprint: h.fingerprint, cwd: "/workspace/project" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().locator.nativeTaskId).toBe("new-task");
    assertNoHomeOrNul(response.body, h.codexHome);
  });

  it("rejects start against an unknown home fingerprint", async () => {
    const h = await harness({ token: TOKEN });
    const response = await h.app.inject({
      method: "POST",
      url: "/api/provider-index/tasks",
      headers: h.authHeaders(),
      payload: {
        provider: "openai",
        homeFingerprint: "0".repeat(64),
        cwd: "/workspace/project",
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("unknown_home");
  });

  it("sends input and returns a path-free turn ref", async () => {
    const captured: NativeTaskKey[] = [];
    const h = await harness({
      token: TOKEN,
      behavior: {
        send: async (key) => {
          captured.push(key);
          return { taskKey: key, turnId: "turn-42" };
        },
      },
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}/send`,
      headers: h.authHeaders(),
      payload: { input: { text: "hello" } },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.turnId).toBe("turn-42");
    expect(body.taskKey.nativeTaskId).toBe("task-a");
    expect(body.taskKey).not.toHaveProperty("home");
    // The server resolved the raw home internally to dispatch.
    expect(captured[0]?.home).toBe(h.codexHome);
    assertNoHomeOrNul(response.body, h.codexHome);
  });

  it("archives, renames, steers, and interrupts with 204", async () => {
    const h = await harness({ token: TOKEN });
    const locator = h.locatorFor("task-a");
    for (const [suffix, payload] of [
      ["archive", {}],
      ["rename", { name: "renamed" }],
      ["steer", { expectedTurnId: "t1", input: { text: "x" } }],
      ["interrupt", { turnId: "t1" }],
    ] as const) {
      const response = await h.app.inject({
        method: "POST",
        url: `/api/provider-index/tasks/${locator}/${suffix}`,
        headers: h.authHeaders(),
        payload,
      });
      expect(response.statusCode).toBe(204);
    }
  });

  it("maps a reconciliation-required mutation to a value-free 409", async () => {
    const h = await harness({
      token: TOKEN,
      behavior: {
        rename: async () => {
          throw new ProviderOperationError("RECONCILIATION_REQUIRED", `home ${h?.codexHome}`);
        },
      },
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}/rename`,
      headers: h.authHeaders(),
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("RECONCILIATION_REQUIRED");
    assertNoHomeOrNul(response.body, h.codexHome);
  });

  it("responds to a pending request or reports it stale", async () => {
    const h = await harness({ token: TOKEN });
    const response = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}/respond`,
      headers: h.authHeaders(),
      payload: {
        kind: "command-approval",
        identity: {
          generation: 1,
          turnId: "turn-1",
          requestId: "req-1",
          itemId: null,
          approvalId: null,
        },
        decision: "allow",
      },
    });
    // No such request is pending, so the registry reports it stale.
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("provider_response_stale");
  });
});

describe("indexed routes: meta (additive only)", () => {
  it("patches additive local metadata and returns the meta", async () => {
    const h = await harness({ token: TOKEN });
    const response = await h.app.inject({
      method: "PATCH",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}/meta`,
      headers: h.authHeaders(),
      payload: { favorite: true, tags: ["important"], notes: "check later" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.favorite).toBe(true);
    expect(body.tags).toEqual(["important"]);
    assertNoHomeOrNul(response.body, h.codexHome);
  });

  it("rejects an empty or unknown-field meta patch", async () => {
    const h = await harness({ token: TOKEN });
    const empty = await h.app.inject({
      method: "PATCH",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}/meta`,
      headers: h.authHeaders(),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const unknown = await h.app.inject({
      method: "PATCH",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}/meta`,
      headers: h.authHeaders(),
      payload: { title: "override" },
    });
    expect(unknown.statusCode).toBe(400);
  });
});

describe("indexed routes: reconciliation get/ack", () => {
  it("reads a clear reconciliation state", async () => {
    const h = await harness({ token: TOKEN });
    const response = await h.app.inject({
      method: "GET",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}/reconciliation`,
      headers: h.authHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().required).toBe(false);
    assertNoHomeOrNul(response.body, h.codexHome);
  });

  it("rejects an ack against a non-latched revision via store CAS", async () => {
    const h = await harness({
      token: TOKEN,
      behavior: { read: async (key) => nativeTask("openai", key.home, key.nativeTaskId) },
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/api/provider-index/tasks/${h.locatorFor("task-a")}/reconciliation/ack`,
      headers: h.authHeaders(),
      payload: { latchRevision: 5, reviewedFingerprint: null },
    });
    // No latch exists at revision 5, so the exact CAS refuses.
    expect(response.statusCode).toBe(409);
    assertNoHomeOrNul(response.body, h.codexHome);
  });
});

describe("indexed routes: rebuild single-flight", () => {
  it("rejects a concurrent rebuild with rebuild_in_progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness({
      token: TOKEN,
      behavior: {
        list: async (input) => {
          await gate;
          return { items: [summaryFor("openai", input.home, "task-0")], nextCursor: null };
        },
        read: async (key) => nativeTask("openai", key.home, key.nativeTaskId),
      },
    });

    const first = h.app.inject({
      method: "POST",
      url: "/api/provider-index/rebuild",
      headers: h.authHeaders(),
      payload: { provider: "openai", homeFingerprint: h.fingerprint },
    });
    // Give the first rebuild time to claim the single-flight slot.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const second = await h.app.inject({
      method: "POST",
      url: "/api/provider-index/rebuild",
      headers: h.authHeaders(),
      payload: { provider: "openai", homeFingerprint: h.fingerprint },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("rebuild_in_progress");
    release();
    const firstResult = await first;
    expect(firstResult.statusCode).toBe(200);
  });
});

describe("indexed routes: SSE", () => {
  async function connect(
    baseUrl: string,
    locator: string,
    token: string | undefined,
    lastEventId?: string,
  ): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; response: Response }> {
    const response = await fetch(`${baseUrl}/api/provider-index/tasks/${locator}/events`, {
      headers: {
        accept: "text/event-stream",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE connect failed: ${response.status}`);
    }
    return { reader: response.body.getReader(), response };
  }

  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (text: string) => boolean,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let acc = "";
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500)),
      ]);
      if (chunk.done) {
        if (predicate(acc)) return acc;
        continue;
      }
      acc += decoder.decode(chunk.value, { stream: true });
      if (predicate(acc)) return acc;
    }
    throw new Error(`SSE did not satisfy predicate; got: ${acc}`);
  }

  it("emits snapshot then live and takes the full path for any Last-Event-ID", async () => {
    let deliver: ((event: ProviderEvent) => void) | undefined;
    const h = await harness({
      behavior: {
        read: async (key) => nativeTask("openai", key.home, key.nativeTaskId),
        subscribe: async (_key, sink) => {
          deliver = sink;
          return () => { deliver = undefined; };
        },
      },
    });
    const baseUrl = await h.app.listen({ host: "127.0.0.1", port: 0 });
    const locator = h.locatorFor("task-a");
    const { reader } = await connect(baseUrl, locator, h.token, "stale-foreign-id");

    const framed = await readUntil(reader, (text) =>
      text.includes('"type":"snapshot"') && text.includes('"type":"live"'));
    expect(framed).toContain('"streamEpoch"');
    assertNoHomeOrNul(framed, h.codexHome);

    // A live event after the switch is delivered.
    deliver?.({
      type: "message",
      provider: "openai",
      key: createNativeTaskKey("openai", h.codexHome, "task-a"),
      occurredAt: "2026-07-13T00:00:01.000Z",
      role: "assistant",
      text: "streamed",
      turnId: "turn-1",
      itemId: "item-1",
    });
    const withLive = await readUntil(reader, (text) => text.includes("streamed"));
    assertNoHomeOrNul(withLive, h.codexHome);
    await reader.cancel();
  });
});
