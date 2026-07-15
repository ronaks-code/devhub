import { describe, expect, it, vi } from "vitest";
import {
  CodexNativeAdapter,
  CodexNativeAdapterError,
} from "../../src/providers/codex/native-adapter.js";
import { CodexRemoteRpcError } from "../../src/providers/codex/protocol/rpc-peer.js";
import { buildCodexNativeRevision } from "../../src/providers/codex/revision.js";
import { parseCodexThreadReadResult } from "../../src/providers/codex/native-shapes.js";
import type {
  AdapterReconciliationLatchInput,
  AdapterReconciliationSnapshot,
  AdapterReconciliationStore,
  AppServerReconcileContext,
  CodexAppServerLease,
  CodexSupervisorAcquireOptions,
  NativeTaskWriterLease,
  NativeTaskKey,
} from "../../src/providers/index.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const HOME = "/tmp/devhub-codex-native";

const nativeTurn = (
  id = "turn-1",
  status = "completed",
  items: readonly Record<string, unknown>[] = [],
): Record<string, unknown> => ({
  id,
  itemsView: "full",
  status,
  error: null,
  startedAt: 1_700_000_010,
  completedAt: status === "inProgress" ? null : 1_700_000_020,
  durationMs: status === "inProgress" ? null : 10_000,
  items,
});

const nativeThread = (
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  sessionId: id,
  forkedFromId: null,
  parentThreadId: null,
  preview: `Preview ${id}`,
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_020,
  recencyAt: 1_700_000_021,
  status: { type: "idle" },
  path: null,
  cwd: "/tmp/project",
  cliVersion: "0.144.1",
  source: "vscode",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: `Task ${id}`,
  turns: [],
  ...overrides,
});

const configuredResult = (
  thread: Record<string, unknown>,
  sandboxType: "readOnly" | "workspaceWrite" | "dangerFullAccess" = "workspaceWrite",
): Record<string, unknown> => ({
  thread,
  model: "gpt-5.4",
  modelProvider: "openai",
  serviceTier: null,
  cwd: "/tmp/project",
  instructionSources: [],
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: sandboxType === "readOnly"
    ? { type: "readOnly", networkAccess: false }
    : sandboxType === "workspaceWrite"
      ? {
          type: "workspaceWrite",
          writableRoots: ["/tmp/project"],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        }
      : { type: "dangerFullAccess" },
  reasoningEffort: "high",
});

class FakeLease implements CodexAppServerLease {
  readonly home = HOME;
  generation = 1;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly responders = new Map<string, Array<(params: unknown) => unknown | Promise<unknown>>>();
  releaseCalls = 0;

  enqueue(method: string, response: unknown | ((params: unknown) => unknown | Promise<unknown>)): void {
    const queue = this.responders.get(method) ?? [];
    queue.push(typeof response === "function"
      ? response as (params: unknown) => unknown | Promise<unknown>
      : () => response);
    this.responders.set(method, queue);
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const response = this.responders.get(method)?.shift();
    if (!response) throw new Error(`missing fake response for ${method}`);
    return await response(params) as T;
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
  }
}

class FakeSupervisor {
  readonly lease = new FakeLease();
  readonly acquires: CodexSupervisorAcquireOptions[] = [];

  async acquire(options: CodexSupervisorAcquireOptions): Promise<CodexAppServerLease> {
    this.acquires.push(options);
    return this.lease;
  }
}

const adapter = (supervisor = new FakeSupervisor(), enabled = true) => ({
  native: new CodexNativeAdapter({
    home: HOME,
    supervisor,
    cursorSecret: SECRET,
    isEnabled: () => enabled,
    requestMode: "manual",
  }),
  supervisor,
});

const nativeKey = (nativeTaskId = "thread-1") => ({
  provider: "openai" as const,
  home: HOME,
  nativeTaskId,
});

const missingRemoteError = (
  nativeTaskId: string,
  overrides: { readonly code?: number; readonly message?: string; readonly data?: unknown } = {},
) => new CodexRemoteRpcError({
  code: overrides.code ?? -32600,
  message: overrides.message ?? `thread not loaded: ${nativeTaskId}`,
  ...(Object.prototype.hasOwnProperty.call(overrides, "data") ? { data: overrides.data } : {}),
});

describe("CodexNativeAdapter native task projection", () => {
  it.each([
    ["read", (h: ReturnType<typeof adapter>) => h.native.readTask(nativeKey(), false)],
    ["resume pre-read", (h: ReturnType<typeof adapter>) =>
      h.native.resumeTask(nativeKey(), { permissionMode: "read-only" })],
    ["fork pre-read", (h: ReturnType<typeof adapter>) => h.native.forkTask(nativeKey())],
    ["existing-task subscription", (h: ReturnType<typeof adapter>) =>
      h.native.subscribe(nativeKey(), () => undefined)],
  ] as const)("classifies an exact rejected thread/read during %s as native-task-missing", async (_name, invoke) => {
    const h = adapter();
    h.supervisor.lease.enqueue("thread/read", async () => {
      throw missingRemoteError("thread-1");
    });

    await expect(invoke(h)).rejects.toMatchObject({
      code: "NATIVE_TASK_MISSING",
      message: "Provider native task is missing",
    });
  });

  it.each([
    ["wrong code", () => missingRemoteError("thread-1", { code: -32601 })],
    ["wrong requested id", () => missingRemoteError("different-thread")],
    ["inexact message", () => missingRemoteError("thread-1", {
      message: "thread not loaded: thread-1 (deleted)",
    })],
    ["defined data", () => missingRemoteError("thread-1", { data: null })],
    ["wrong error class", () => Object.assign(new Error("thread not loaded: thread-1"), {
      code: -32600,
      data: undefined,
    })],
  ] as const)("does not classify a %s thread/read rejection as missing", async (_name, createCause) => {
    const h = adapter();
    const cause = createCause();
    h.supervisor.lease.enqueue("thread/read", async () => { throw cause; });

    await expect(h.native.readTask(nativeKey(), false)).rejects.toBe(cause);
  });

  it("keeps an exact missing-looking mutation rejection mutation-uncertain", async () => {
    const h = adapter();
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/resume", async () => {
      throw missingRemoteError("thread-1");
    });

    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
  });

  it("lists both bounded lanes without dropping fetched rows and reconstructs safe history", async () => {
    const h = adapter();
    h.supervisor.lease.enqueue("thread/list", (params) => ({
      data: [nativeThread("active", { updatedAt: 1_700_000_030 })],
      nextCursor: null,
      backwardsCursor: null,
      lane: params,
    }));
    h.supervisor.lease.enqueue("thread/list", {
      data: [nativeThread("archived", { updatedAt: 1_700_000_025 })],
      nextCursor: null,
      backwardsCursor: null,
    });

    const page = await h.native.listTasks({
      home: HOME,
      includeArchived: true,
      limit: 5,
    });

    expect(page.items.map(({ key }) => key.nativeTaskId)).toEqual(["active", "archived"]);
    expect(page.items.map(({ archived }) => archived)).toEqual([false, true]);
    expect(page.nextCursor).toBeNull();
    expect(h.supervisor.lease.calls.map(({ params }) => params)).toEqual([
      expect.objectContaining({
        archived: false,
        limit: 3,
        sourceKinds: ["vscode", "appServer"],
        sortKey: "updated_at",
        sortDirection: "desc",
      }),
      expect.objectContaining({
        archived: true,
        limit: 2,
        sourceKinds: ["vscode", "appServer"],
        sortKey: "updated_at",
        sortDirection: "desc",
      }),
    ]);

    const secret = "sk-proj-0123456789abcdefghijklmnop";
    const items = [
      {
        type: "userMessage",
        id: "user-1",
        clientId: null,
        content: [{ type: "text", text: "hello", text_elements: [] }],
      },
      { type: "agentMessage", id: "agent-1", text: "world", phase: null, memoryCitation: null },
      { type: "plan", id: "plan-1", text: "ship it" },
      { type: "reasoning", id: "reason-1", summary: [secret], content: ["hidden"] },
      {
        type: "commandExecution",
        id: "command-1",
        command: `echo ${secret}`,
        cwd: "/tmp/project",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: secret,
        exitCode: 0,
        durationMs: 1,
      },
    ];
    h.supervisor.lease.enqueue("thread/read", {
      thread: nativeThread("active", { turns: [nativeTurn("turn-1", "completed", items)] }),
    });
    const task = await h.native.readTask({
      provider: "openai",
      home: HOME,
      nativeTaskId: "active",
    }, true);

    expect(task.archived).toBeNull();
    expect(task.turns[0]?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message", role: "user", text: "hello", itemId: "user-1" }),
      expect.objectContaining({ type: "message", role: "assistant", text: "world", itemId: "agent-1" }),
      expect.objectContaining({ type: "plan", text: "ship it", itemId: "plan-1" }),
      expect.objectContaining({ type: "activity", activity: "commandExecution", message: null }),
    ]));
    expect(JSON.stringify(task)).not.toContain(secret);
    expect(JSON.stringify(task)).not.toContain("hidden");
    expect(JSON.stringify(task)).not.toContain("aggregatedOutput");
    const replay = task.turns[0]!.events;
    expect(replay.at(-1)).toMatchObject({
      type: "status",
      scope: "turn",
      status: "completed",
      occurredAt: "2023-11-14T22:13:40.000Z",
    });
    expect(replay.findIndex((event) => event.type === "message"))
      .toBeLessThan(replay.length - 1);
  });

  it("starts with explicit safe policy and sends optional input exactly once", async () => {
    const h = adapter();
    const thread = nativeThread("created");
    h.supervisor.lease.enqueue("thread/start", configuredResult(thread));
    h.supervisor.lease.enqueue("turn/start", {
      turn: nativeTurn("turn-created", "inProgress"),
    });
    h.supervisor.lease.enqueue("thread/read", {
      thread: nativeThread("created", {
        turns: [nativeTurn("turn-created", "inProgress")],
      }),
    });

    const task = await h.native.startTask({
      home: HOME,
      cwd: "/tmp/project",
      model: "gpt-5.4",
      permissionMode: "workspace-write",
      input: {
        text: "Build it",
        attachments: [{ name: "shot.png", path: "/tmp/shot.png", mediaType: "image/png" }],
      },
    });

    expect(task.key.nativeTaskId).toBe("created");
    expect(task.model).toBe("gpt-5.4");
    expect(h.supervisor.lease.calls[0]).toEqual({
      method: "thread/start",
      params: expect.objectContaining({
        cwd: "/tmp/project",
        model: "gpt-5.4",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        ephemeral: false,
        serviceName: "devhub",
        threadSource: "appServer",
      }),
    });
    expect(h.supervisor.lease.calls[1]).toEqual({
      method: "turn/start",
      params: expect.objectContaining({
        threadId: "created",
        approvalPolicy: "on-request",
        input: [
          { type: "text", text: "Build it", text_elements: [] },
          { type: "localImage", path: "/tmp/shot.png" },
        ],
      }),
    });
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "turn/start")).toHaveLength(1);
  });

  it("rejects unsafe overrides and verifies resume/fork policy responses", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };

    await expect(h.native.resumeTask(key, { mode: "plan" })).rejects.toBeInstanceOf(
      CodexNativeAdapterError,
    );
    await expect(h.native.resumeTask(key, { permissionMode: "danger-full-access" }))
      .rejects.toMatchObject({ code: "UNSAFE_OVERRIDE" });
    expect(h.supervisor.acquires).toHaveLength(0);

    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/resume", configuredResult(
      nativeThread("thread-1"),
      "dangerFullAccess",
    ));
    await expect(h.native.resumeTask(key, { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "POLICY_MISMATCH" });

    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/fork", configuredResult(
      nativeThread("fork-1", { forkedFromId: "thread-1" }),
      "readOnly",
    ));
    const fork = await h.native.forkTask(key, "turn-1");
    expect(fork.key.nativeTaskId).toBe("fork-1");
    expect(h.supervisor.lease.calls.at(-1)).toEqual({
      method: "thread/fork",
      params: expect.objectContaining({
        threadId: "thread-1",
        lastTurnId: "turn-1",
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      }),
    });

    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/fork", configuredResult(
      nativeThread("thread-1", { forkedFromId: "thread-1" }),
      "readOnly",
    ));
    const sameId = await h.native.forkTask(key).catch((error: unknown) => error) as {
      code?: string;
      task?: unknown;
    };
    expect(sameId).toMatchObject({ code: "OWNERSHIP" });
    expect(sameId.task).toBeUndefined();
  });
});

describe("CodexNativeAdapter live dispatch", () => {
  it("normalizes live events, correlates exact approval responses, and unsubscribes once", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const received: unknown[] = [];
    const unsubscribe = await h.native.subscribe(key, (event) => received.push(event));
    const handlers = h.supervisor.acquires[0]!.handlers;
    const signal = new AbortController().signal;

    await handlers.onNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hi " },
    }, { home: HOME, generation: 1, signal });
    expect(received).toContainEqual(expect.objectContaining({
      type: "message-delta",
      delta: "hi ",
      itemId: "item-1",
    }));

    const response = handlers.onServerRequest({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        approvalId: null,
        startedAtMs: 1,
      },
    }, { home: HOME, generation: 1, signal });
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: "request" })));
    const requestEvent = received.find((event) =>
      typeof event === "object" && event !== null && (event as { type?: string }).type === "request") as {
        request: { identity: Record<string, unknown> };
      };
    await expect(h.native.respond({
      kind: "command-approval",
      identity: requestEvent.request.identity as never,
      decision: "allow",
    })).resolves.toBeUndefined();
    await expect(response).resolves.toEqual({ decision: "accept" });

    await unsubscribe();
    await unsubscribe();
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "thread/unsubscribe"))
      .toHaveLength(1);
  });

  it("implements direct controls but advertises unproven interaction capabilities as false", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    const capabilities = await h.native.capabilities();
    expect(capabilities).toMatchObject({
      list: true,
      read: true,
      start: true,
      resume: true,
      fork: true,
      send: true,
      steer: false,
      interrupt: true,
      subscribe: true,
      approveCommand: false,
      approveFileChange: false,
      approvePermissions: false,
      requestUserInput: false,
      mcpElicitation: false,
      archive: true,
      rename: true,
    });

    h.supervisor.lease.enqueue("turn/start", { turn: nativeTurn("turn-2", "inProgress") });
    h.supervisor.lease.enqueue("turn/steer", { turnId: "turn-2" });
    h.supervisor.lease.enqueue("turn/interrupt", {});
    h.supervisor.lease.enqueue("thread/archive", {});
    h.supervisor.lease.enqueue("thread/name/set", {});
    await expect(h.native.send(key, { text: "next" })).resolves.toMatchObject({ turnId: "turn-2" });
    await h.native.steer(key, "turn-2", { text: "adjust" });
    await h.native.interrupt(key, "turn-2");
    await h.native.archive(key);
    await h.native.rename(key, "Renamed");
    expect(h.supervisor.lease.calls.slice(-5).map(({ method }) => method)).toEqual([
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "thread/archive",
      "thread/name/set",
    ]);
  });

  it("never publishes a credential split across live text deltas", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const received: unknown[] = [];
    const unsubscribe = await h.native.subscribe(key, (event) => received.push(event));
    const handlers = h.supervisor.acquires[0]!.handlers;
    const context = { home: HOME, generation: 1, signal: new AbortController().signal };

    await handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-secret",
        delta: "token sk-proj-0123456789",
      },
    }, context);
    expect(JSON.stringify(received)).not.toContain("sk-proj");
    await handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-secret",
        delta: "abcdefghijklmnop done ",
      },
    }, context);

    const visible = received
      .filter((event): event is { type: "message-delta"; delta: string } =>
        typeof event === "object" && event !== null &&
        (event as { type?: string }).type === "message-delta")
      .map((event) => event.delta)
      .join("");
    expect(visible).toBe("token [REDACTED] done ");
    expect(visible).not.toContain("0123456789abcdefghijklmnop");
    await unsubscribe();
  });

  it("does not re-normalize raw text after a stream item is suppressed", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const sink = vi.fn();
    const unsubscribe = await h.native.subscribe(key, sink);
    const handler = h.supervisor.acquires[0]!.handlers.onNotification;
    const context = { home: HOME, generation: 1, signal: new AbortController().signal };

    await handler({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "oversized-item",
        delta: "a".repeat(64 * 1_024 + 1),
      },
    }, context);
    const startedAt = performance.now();
    await handler({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "oversized-item",
        delta: `${"b".repeat(64 * 1_024 - 1)} `,
      },
    }, context);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "message-delta",
      itemId: "oversized-item",
    }));
    await unsubscribe();
  });

  it("does not join an in-progress history prefix with a post-subscribe secret suffix", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", {
      thread: nativeThread("thread-1", {
        turns: [nativeTurn("turn-1", "inProgress", [{
          type: "agentMessage",
          id: "item-secret",
          text: "sk-proj-0123",
          phase: null,
          memoryCitation: null,
        }])],
      }),
    });
    const history = await h.native.readTask(key, true);
    expect(JSON.stringify(history)).not.toContain("sk-proj-0123");

    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const received: unknown[] = [];
    const unsubscribe = await h.native.subscribe(key, (event) => received.push(event));
    await h.supervisor.acquires[0]!.handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-secret",
        delta: "456789abcdefghijklmnop ",
      },
    }, { home: HOME, generation: 1, signal: new AbortController().signal });
    expect(`${JSON.stringify(history)}${JSON.stringify(received)}`)
      .not.toContain("sk-proj-0123456789abcdefghijklmnop");
    await unsubscribe();
  });

  it("drops withheld stream state on the last unsubscribe without a terminal notification", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const firstEvents: unknown[] = [];
    const first = await h.native.subscribe(key, (event) => firstEvents.push(event));
    const handlers = h.supervisor.acquires[0]!.handlers;
    const context = { home: HOME, generation: 1, signal: new AbortController().signal };
    await handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "reused", delta: "Bearer ",
      },
    }, context);
    expect(firstEvents).toEqual([]);
    await first();

    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const secondEvents: unknown[] = [];
    const second = await h.native.subscribe(key, (event) => secondEvents.push(event));
    await handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "reused", delta: "plain-suffix ",
      },
    }, context);
    expect(secondEvents).toContainEqual(expect.objectContaining({
      type: "message-delta",
      delta: "plain-suffix ",
    }));
    await second();
  });

  it("performs generation reconciliation without replaying a turn start", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const unsubscribe = await h.native.subscribe(key, vi.fn());
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
      async call<T>(method: "thread/list" | "thread/read" | "thread/resume", params?: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === "thread/read") return { thread: nativeThread("thread-1") } as T;
        if (method === "thread/resume") {
          return configuredResult(nativeThread("thread-1"), "readOnly") as T;
        }
        return { data: [], nextCursor: null } as T;
      },
    };
    await h.native.reconcile({
      home: HOME,
      generation: 2,
      signal: new AbortController().signal,
      rpc,
    } satisfies AppServerReconcileContext);

    expect(calls.map(({ method }) => method)).toEqual(["thread/read", "thread/resume"]);
    expect(calls.some(({ method }) => method === ("turn/start" as never))).toBe(false);
    await unsubscribe();
  });

  it("classifies an exact rejected reconciliation thread/read as native-task-missing", async () => {
    const h = adapter();
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const unsubscribe = await h.native.subscribe(nativeKey(), vi.fn());
    const rpc = {
      async call<T>(method: "thread/list" | "thread/read" | "thread/resume"): Promise<T> {
        if (method === "thread/read") throw missingRemoteError("thread-1");
        throw new Error(`unexpected reconciliation method ${method}`);
      },
    };

    await expect(h.native.reconcile({
      home: HOME,
      generation: 2,
      signal: new AbortController().signal,
      rpc,
    } satisfies AppServerReconcileContext)).rejects.toMatchObject({
      code: "NATIVE_TASK_MISSING",
      message: "Provider native task is missing",
    });
    await unsubscribe();
  });

  it("does no process work while disabled and releases the persistent lease on dispose", async () => {
    const disabled = adapter(new FakeSupervisor(), false);
    expect(await disabled.native.capabilities()).toEqual(expect.objectContaining({
      list: false,
      start: false,
      subscribe: false,
    }));
    await expect(disabled.native.listTasks({ home: HOME })).rejects.toMatchObject({
      code: "DISABLED",
    });
    expect(disabled.supervisor.acquires).toHaveLength(0);

    const enabled = adapter();
    enabled.supervisor.lease.enqueue("thread/list", {
      data: [], nextCursor: null, backwardsCursor: null,
    });
    await enabled.native.listTasks({ home: HOME });
    await enabled.native.dispose();
    await enabled.native.dispose();
    expect(enabled.supervisor.lease.releaseCalls).toBe(1);
  });
});

describe("CodexNativeAdapter hardening boundaries", () => {
  it("rejects a native list lane that exceeds the issued public quota", async () => {
    const h = adapter();
    h.supervisor.lease.enqueue("thread/list", {
      data: [nativeThread("one"), nativeThread("two")],
      nextCursor: null,
      backwardsCursor: null,
    });

    await expect(h.native.listTasks({ home: HOME, limit: 1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("validates optional list filters instead of silently changing their meaning", async () => {
    const h = adapter();
    await expect(h.native.listTasks({
      home: HOME,
      includeArchived: "yes" as never,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.supervisor.acquires).toHaveLength(0);
  });

  it("tracks duplicate sink registrations independently", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const sink = vi.fn();
    const first = await h.native.subscribe(key, sink);
    const second = await h.native.subscribe(key, sink);

    await first();
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "thread/unsubscribe"))
      .toHaveLength(0);
    await second();
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "thread/unsubscribe"))
      .toHaveLength(1);
  });

  it("fails unsupported requests closed by default without publishing an unusable prompt", async () => {
    const supervisor = new FakeSupervisor();
    const native = new CodexNativeAdapter({
      home: HOME,
      supervisor,
      cursorSecret: SECRET,
    });
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const sink = vi.fn();
    const unsubscribe = await native.subscribe(key, sink);
    const handlers = supervisor.acquires[0]!.handlers;

    expect(await handlers.onServerRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        approvalId: null,
        startedAtMs: 1,
      },
    }, {
      home: HOME,
      generation: 1,
      signal: new AbortController().signal,
    })).toEqual({ decision: "cancel" });
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: "request" }));
    await unsubscribe();
  });

  it("drops a disabled lease and lazily reacquires after re-enable", async () => {
    let enabled = true;
    const supervisor = new FakeSupervisor();
    const native = new CodexNativeAdapter({
      home: HOME,
      supervisor,
      cursorSecret: SECRET,
      isEnabled: () => enabled,
    });
    supervisor.lease.enqueue("thread/list", {
      data: [], nextCursor: null, backwardsCursor: null,
    });
    await native.listTasks({ home: HOME });
    expect(supervisor.acquires).toHaveLength(1);

    enabled = false;
    await native.refreshEnabled();
    expect(supervisor.lease.releaseCalls).toBe(1);
    await expect(native.listTasks({ home: HOME })).rejects.toMatchObject({ code: "DISABLED" });

    enabled = true;
    await native.refreshEnabled();
    expect(supervisor.acquires).toHaveLength(1);
    supervisor.lease.enqueue("thread/list", {
      data: [], nextCursor: null, backwardsCursor: null,
    });
    await native.listTasks({ home: HOME });
    expect(supervisor.acquires).toHaveLength(2);
    await native.dispose();
    expect(supervisor.lease.releaseCalls).toBe(2);
  });

  it("retains a verified workspace-write policy for follow-up turns", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/resume", configuredResult(
      nativeThread("thread-1"),
      "workspaceWrite",
    ));
    await h.native.resumeTask(key, { permissionMode: "workspace-write" });
    h.supervisor.lease.enqueue("turn/start", { turn: nativeTurn("turn-write", "inProgress") });

    await h.native.send(key, { text: "edit the file" });
    expect(h.supervisor.lease.calls.at(-1)).toEqual({
      method: "turn/start",
      params: expect.objectContaining({
        threadId: "thread-1",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/project"],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      }),
    });
  });

  it("validates optional start input before creating a native task", async () => {
    const h = adapter();
    await expect(h.native.startTask({
      home: HOME,
      cwd: "/tmp/project",
      input: {
        text: "build",
        attachments: [{ name: "bad.txt", path: "relative/bad.txt" }],
      },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.supervisor.acquires).toHaveLength(0);
  });

  it("bounds model overrides before process acquisition", async () => {
    const h = adapter();
    await expect(h.native.startTask({
      home: HOME,
      cwd: "/tmp/project",
      model: "m".repeat(257),
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(h.native.startTask({
      home: HOME,
      cwd: "/tmp/project",
      model: "unsafe\nmodel",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.supervisor.acquires).toHaveLength(0);
  });

  it("returns a safe created-task reference when start policy verification fails", async () => {
    const h = adapter();
    const unsafe = configuredResult(nativeThread("created-unsafe")) as Record<string, unknown>;
    unsafe.sandbox = {
      type: "workspaceWrite",
      writableRoots: ["/tmp/project"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    h.supervisor.lease.enqueue("thread/start", unsafe);

    await expect(h.native.startTask({
      home: HOME,
      cwd: "/tmp/project",
      permissionMode: "workspace-write",
    })).rejects.toMatchObject({
      code: "PARTIAL_START",
      task: { key: { nativeTaskId: "created-unsafe" } },
    });
  });

  it("drops old-generation events immediately while a disable races an in-flight read", async () => {
    let enabled = true;
    const supervisor = new FakeSupervisor();
    const native = new CodexNativeAdapter({
      home: HOME,
      supervisor,
      cursorSecret: SECRET,
      isEnabled: () => enabled,
      requestMode: "manual",
    });
    let resolveRead!: (value: unknown) => void;
    supervisor.lease.enqueue("thread/read", () => new Promise((resolve) => {
      resolveRead = resolve;
    }));
    const sink = vi.fn();
    const pendingSubscription = native.subscribe({
      provider: "openai",
      home: HOME,
      nativeTaskId: "thread-1",
    }, sink);
    await vi.waitFor(() => expect(supervisor.lease.calls).toHaveLength(1));
    const handlers = supervisor.acquires[0]!.handlers;

    enabled = false;
    const disabling = native.refreshEnabled();
    await handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "old ",
      },
    }, { home: HOME, generation: 1, signal: new AbortController().signal });
    expect(sink).not.toHaveBeenCalled();
    resolveRead({ thread: nativeThread("thread-1") });
    await expect(pendingSubscription).rejects.toMatchObject({ code: "DISABLED" });
    await disabling;

    enabled = true;
    await native.refreshEnabled();
    supervisor.lease.generation = 2;
    supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const currentSink = vi.fn();
    const unsubscribe = await native.subscribe({
      provider: "openai", home: HOME, nativeTaskId: "thread-1",
    }, currentSink);
    await handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "stale ",
      },
    }, { home: HOME, generation: 1, signal: new AbortController().signal });
    await handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "current ",
      },
    }, { home: HOME, generation: 2, signal: new AbortController().signal });
    expect(currentSink).toHaveBeenCalledTimes(1);
    expect(currentSink).toHaveBeenCalledWith(expect.objectContaining({ delta: "current " }));
    await unsubscribe();
  });

  it("contains non-canonical live correlation ids without throwing through the handler", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const sink = vi.fn();
    const unsubscribe = await h.native.subscribe(key, sink);
    await expect(h.supervisor.acquires[0]!.handlers.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: " thread-1 ", turnId: "turn-1", itemId: "item-1", delta: "safe ",
      },
    }, { home: HOME, generation: 1, signal: new AbortController().signal }))
      .resolves.toBeUndefined();
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: "message-delta" }));
    await unsubscribe();
  });

  it("classifies dispatched or post-response mutation failures as non-retryable uncertainty", async () => {
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("turn/start", () => {
      throw new Error("mutation outcome is uncertain: timeout after enqueue");
    });
    await expect(h.native.send(key, { text: "send once" })).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
      task: undefined,
    });
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "turn/start"))
      .toHaveLength(1);

    const malformed = adapter();
    malformed.supervisor.lease.enqueue("thread/start", { malformed: true });
    await expect(malformed.native.startTask({
      home: HOME,
      cwd: "/tmp/project",
    })).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
      task: undefined,
    });
    expect(malformed.supervisor.lease.calls.filter(({ method }) => method === "thread/start"))
      .toHaveLength(1);
  });

  it("keeps an exact control cwd while redacting the browser projection", async () => {
    const secretCwd = "/tmp/sk-proj-0123456789abcdefghijklmnop";
    const h = adapter();
    const key = { provider: "openai" as const, home: HOME, nativeTaskId: "thread-1" };
    h.supervisor.lease.enqueue("thread/read", {
      thread: nativeThread("thread-1", { cwd: secretCwd }),
    });
    const resumedResult = configuredResult(
      nativeThread("thread-1", { cwd: secretCwd }),
      "workspaceWrite",
    ) as Record<string, unknown>;
    resumedResult.cwd = secretCwd;
    resumedResult.sandbox = {
      type: "workspaceWrite",
      writableRoots: [secretCwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    h.supervisor.lease.enqueue("thread/resume", resumedResult);

    const resumed = await h.native.resumeTask(key, { permissionMode: "workspace-write" });
    expect(h.supervisor.lease.calls.at(-1)).toEqual({
      method: "thread/resume",
      params: expect.objectContaining({ cwd: secretCwd }),
    });
    expect(resumed.cwd).toBe("/tmp/[REDACTED]");
    expect(JSON.stringify(resumed)).not.toContain("sk-proj-0123456789abcdefghijklmnop");

    h.supervisor.lease.enqueue("thread/read", {
      thread: nativeThread("thread-1", { cwd: secretCwd }),
    });
    const forkResult = configuredResult(
      nativeThread("fork-secret-cwd", { cwd: secretCwd, forkedFromId: "thread-1" }),
      "readOnly",
    ) as Record<string, unknown>;
    forkResult.cwd = secretCwd;
    forkResult.sandbox = { type: "readOnly", networkAccess: false };
    h.supervisor.lease.enqueue("thread/fork", forkResult);
    await h.native.forkTask(key);
    expect(h.supervisor.lease.calls.at(-1)).toEqual({
      method: "thread/fork",
      params: expect.objectContaining({ cwd: secretCwd }),
    });
  });
});

// --- Writer-lease fence + durable reconciliation over existing-task mutations ---

const keyId = (key: NativeTaskKey): string =>
  `${key.provider} ${key.home} ${key.nativeTaskId}`;

class FakeWriterLease implements NativeTaskWriterLease {
  readonly key: Readonly<NativeTaskKey>;
  readonly fence: Readonly<{ readonly key: Readonly<NativeTaskKey>; readonly epoch: number }>;
  private confirmed = false;
  private releasedFlag = false;
  private lostFlag = false;
  confirmReads = 0;
  fencedWrites = 0;
  releaseCalls = 0;

  constructor(
    key: NativeTaskKey,
    epoch: number,
    private readonly opts: { started?: boolean; confirm?: boolean } = {},
  ) {
    this.key = key;
    this.fence = Object.freeze({ key, epoch });
  }

  get rereadRequired(): boolean { return !this.confirmed && !this.releasedFlag; }
  get usable(): boolean { return this.confirmed && !this.releasedFlag && !this.lostFlag; }
  get lost(): boolean { return this.lostFlag; }
  get released(): boolean { return this.releasedFlag; }
  get lossReason(): "ownership" | null { return this.lostFlag ? "ownership" : null; }
  get expiresAtMs(): number { return 15_000; }

  confirmReread(): boolean {
    this.confirmReads += 1;
    if (this.opts.confirm === false || this.releasedFlag || this.lostFlag) {
      this.lostFlag = true;
      return false;
    }
    this.confirmed = true;
    return true;
  }

  heartbeat(): boolean { return this.confirmed && !this.releasedFlag && !this.lostFlag; }

  /** Simulates an external takeover / expiry marking this handle lost out-of-band. */
  forceLost(): void { this.lostFlag = true; }

  runFencedWrite<T>(
    start: (fence: Readonly<{ readonly key: Readonly<NativeTaskKey>; readonly epoch: number }>) => T,
  ): { readonly started: false } | { readonly started: true; readonly value: T } {
    this.fencedWrites += 1;
    if (this.opts.started === false || this.releasedFlag || this.lostFlag || !this.confirmed) {
      this.lostFlag = true;
      return { started: false as const };
    }
    return { started: true as const, value: start(this.fence) };
  }

  release(): boolean {
    this.releaseCalls += 1;
    if (this.releasedFlag) return false;
    this.releasedFlag = true;
    return true;
  }
}

class FakeWriterLeaseStore {
  readonly epochs = new Map<string, number>();
  readonly acquires: NativeTaskKey[] = [];
  readonly handles: FakeWriterLease[] = [];
  /** Live (unreleased) handles per key id, so a takeover can fence a stale holder. */
  private readonly live = new Map<string, FakeWriterLease[]>();
  mode: "ok" | "null" = "ok";
  leaseOpts: { started?: boolean; confirm?: boolean } = {};
  /** When set, `acquire` returns these exact epochs in order (models ABA / non-monotonic clocks). */
  epochSequence: number[] = [];
  /** When true, a fresh acquire for a key marks any still-live prior handle lost (single-writer takeover). */
  markLostOnReacquire = false;

  acquire(key: NativeTaskKey): NativeTaskWriterLease | null {
    this.acquires.push(key);
    if (this.mode === "null") return null;
    const id = keyId(key);
    if (this.markLostOnReacquire) {
      for (const prior of this.live.get(id) ?? []) prior.forceLost();
      this.live.set(id, []);
    }
    let epoch: number;
    if (this.epochSequence.length > 0) {
      epoch = this.epochSequence.shift()!;
    } else {
      epoch = (this.epochs.get(id) ?? 0) + 1;
      this.epochs.set(id, epoch);
    }
    const handle = new FakeWriterLease(key, epoch, this.leaseOpts);
    this.handles.push(handle);
    const liveForKey = this.live.get(id) ?? [];
    liveForKey.push(handle);
    this.live.set(id, liveForKey);
    return handle;
  }
}

type FailOp = "get" | "require" | "ack";

class FakeReconciliationStore implements AdapterReconciliationStore {
  readonly rows = new Map<string, AdapterReconciliationSnapshot>();
  readonly failOn = new Set<FailOp>();
  private failed = false;
  /** When true, an ack first bumps the durable latch revision (a concurrent relatch),
   * so the caller's expected revision is stale and the CAS refuses to clear. */
  relatchOnAck = false;

  get unavailable(): boolean { return this.failed; }

  /** Seeds a durable required latch as if written by a prior process/provider. */
  seedRequired(
    key: NativeTaskKey,
    overrides: Partial<AdapterReconciliationSnapshot> = {},
  ): void {
    const prev = this.rows.get(keyId(key)) ?? this.base();
    this.rows.set(keyId(key), Object.freeze({
      required: true,
      latchRevision: prev.latchRevision + 1,
      reviewedFingerprint: null,
      nativeFingerprint: null,
      writerEpoch: 0,
      reason: "NATIVE_REVISION_MISMATCH",
      ...overrides,
    }));
  }

  private base(): AdapterReconciliationSnapshot {
    return Object.freeze({
      required: false,
      latchRevision: 0,
      reviewedFingerprint: null,
      nativeFingerprint: null,
      writerEpoch: 0,
      reason: null,
    });
  }

  private guard<T>(op: FailOp, run: () => T): T {
    if (this.failed) throw new Error("reconciliation store unavailable");
    if (this.failOn.has(op)) {
      this.failed = true;
      throw new Error("reconciliation store fault");
    }
    return run();
  }

  getReconciliation(key: NativeTaskKey): AdapterReconciliationSnapshot {
    return this.guard("get", () => this.rows.get(keyId(key)) ?? this.base());
  }

  requireReconciliation(
    key: NativeTaskKey,
    input: AdapterReconciliationLatchInput,
  ): AdapterReconciliationSnapshot {
    return this.guard("require", () => {
      const id = keyId(key);
      const prev = this.rows.get(id) ?? this.base();
      const next = Object.freeze({
        required: true,
        latchRevision: prev.latchRevision + 1,
        reviewedFingerprint: input.reviewedFingerprint,
        nativeFingerprint: input.nativeFingerprint,
        writerEpoch: input.writerEpoch,
        reason: input.reason,
      });
      this.rows.set(id, next);
      return next;
    });
  }

  acknowledgeReconciliation(
    key: NativeTaskKey,
    expectedLatchRevision: number,
    reviewedFingerprint: string | null,
    observedNativeFingerprint: string | null,
  ): AdapterReconciliationSnapshot {
    return this.guard("ack", () => {
      const id = keyId(key);
      if (this.relatchOnAck) {
        const current = this.rows.get(id) ?? this.base();
        this.rows.set(id, Object.freeze({ ...current, latchRevision: current.latchRevision + 1 }));
      }
      const prev = this.rows.get(id) ?? this.base();
      if (
        prev.required && prev.latchRevision === expectedLatchRevision &&
        prev.reviewedFingerprint === reviewedFingerprint &&
        prev.nativeFingerprint === observedNativeFingerprint
      ) {
        const next = Object.freeze({ ...prev, required: false, reason: null });
        this.rows.set(id, next);
        return next;
      }
      return prev;
    });
  }
}

const fencedAdapter = (
  enabled = true,
  extra: { maxTrackedRevisions?: number } = {},
) => {
  const supervisor = new FakeSupervisor();
  const writerLeases = new FakeWriterLeaseStore();
  const reconciliationStore = new FakeReconciliationStore();
  const native = new CodexNativeAdapter({
    home: HOME,
    supervisor,
    cursorSecret: SECRET,
    isEnabled: () => enabled,
    requestMode: "manual",
    writerLeases,
    reconciliationStore,
    ...extra,
  });
  return { native, supervisor, writerLeases, reconciliationStore };
};

const enqueueRead = (
  h: ReturnType<typeof fencedAdapter>,
  overrides: Record<string, unknown> = {},
) => h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1", overrides) });

describe("CodexNativeAdapter fenced external-mutation parity", () => {
  it("routes the five turn/control mutations through the exact task writer fence", async () => {
    const h = fencedAdapter();
    for (let i = 0; i < 5; i += 1) enqueueRead(h);
    h.supervisor.lease.enqueue("turn/start", { turn: nativeTurn("turn-2", "inProgress") });
    h.supervisor.lease.enqueue("turn/steer", { turnId: "turn-2" });
    h.supervisor.lease.enqueue("turn/interrupt", {});
    h.supervisor.lease.enqueue("thread/archive", {});
    h.supervisor.lease.enqueue("thread/name/set", {});

    await expect(h.native.send(nativeKey(), { text: "next" }))
      .resolves.toMatchObject({ turnId: "turn-2" });
    await h.native.steer(nativeKey(), "turn-2", { text: "adjust" });
    await h.native.interrupt(nativeKey(), "turn-2");
    await h.native.archive(nativeKey());
    await h.native.rename(nativeKey(), "Renamed");

    expect(h.writerLeases.acquires).toHaveLength(5);
    for (const handle of h.writerLeases.handles) {
      expect(handle.confirmReads).toBe(1);
      expect(handle.fencedWrites).toBe(1);
      expect(handle.releaseCalls).toBeGreaterThanOrEqual(1);
    }
    // A clean run never latches durable reconciliation.
    expect(h.reconciliationStore.rows.size).toBe(0);
  });

  it("resumes an existing task through a reread-compare-confirm-fence sequence", async () => {
    const h = fencedAdapter();
    enqueueRead(h); // resume pre-read for cwd
    enqueueRead(h); // fence reread of exact native revision
    h.supervisor.lease.enqueue(
      "thread/resume",
      configuredResult(nativeThread("thread-1"), "readOnly"),
    );
    const task = await h.native.resumeTask(nativeKey(), { permissionMode: "read-only" });
    expect(task.key.nativeTaskId).toBe("thread-1");
    const handle = h.writerLeases.handles[0]!;
    expect(handle.confirmReads).toBe(1);
    expect(handle.fencedWrites).toBe(1);
    expect(handle.releaseCalls).toBeGreaterThanOrEqual(1);
  });

  it("fails closed and latches when the native revision drifted since last review", async () => {
    const h = fencedAdapter();
    // First resume establishes the reviewed revision.
    enqueueRead(h);
    enqueueRead(h);
    h.supervisor.lease.enqueue(
      "thread/resume",
      configuredResult(nativeThread("thread-1"), "readOnly"),
    );
    await h.native.resumeTask(nativeKey(), { permissionMode: "read-only" });

    // Second resume: the fence reread observes an externally advanced revision.
    enqueueRead(h); // pre-read
    enqueueRead(h, { updatedAt: 1_700_099_999 }); // fence reread differs
    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const row = h.reconciliationStore.rows.get(keyId(nativeKey()));
    expect(row?.required).toBe(true);
    expect(row?.reason).toBe("NATIVE_REVISION_MISMATCH");
    // No thread/resume was dispatched on the drift.
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "thread/resume"))
      .toHaveLength(1);
    // The latch is durable: a later mutation stays blocked without a fresh read.
    await expect(h.native.rename(nativeKey(), "later"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
  });

  it("fails closed when a persisted task is deleted before a mutation", async () => {
    const h = fencedAdapter();
    enqueueRead(h); // rename fence reread establishes everPersisted
    h.supervisor.lease.enqueue("thread/name/set", {});
    await h.native.rename(nativeKey(), "first");

    h.supervisor.lease.enqueue("thread/read", async () => {
      throw missingRemoteError("thread-1");
    });
    await expect(h.native.rename(nativeKey(), "second"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.reason).toBe("NATIVE_TASK_MISSING");
  });

  it("fails closed and never replays when the writer lease is lost", async () => {
    const h = fencedAdapter();
    h.writerLeases.mode = "null";
    await expect(h.native.rename(nativeKey(), "x"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const row = h.reconciliationStore.rows.get(keyId(nativeKey()));
    expect(row?.required).toBe(true);
    expect(row?.reason).toBe("WRITER_LEASE_LOST");
    // Even with a healthy lease again, the durable latch keeps it closed.
    h.writerLeases.mode = "ok";
    await expect(h.native.rename(nativeKey(), "y"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    // No provider mutation ever reached the app server.
    expect(h.supervisor.lease.calls.some(({ method }) => method === "thread/name/set")).toBe(false);
  });

  it("fails closed when the lease reread cannot be confirmed", async () => {
    const h = fencedAdapter();
    h.writerLeases.leaseOpts = { confirm: false };
    enqueueRead(h);
    await expect(h.native.rename(nativeKey(), "x"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.reason).toBe("WRITER_LEASE_LOST");
  });

  it("fails closed when the fenced write never starts", async () => {
    const h = fencedAdapter();
    h.writerLeases.leaseOpts = { started: false };
    enqueueRead(h);
    await expect(h.native.rename(nativeKey(), "x"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.supervisor.lease.calls.some(({ method }) => method === "thread/name/set")).toBe(false);
  });

  it("latches and never replays when a dispatched mutation outcome is uncertain", async () => {
    const h = fencedAdapter();
    enqueueRead(h);
    h.supervisor.lease.enqueue("turn/start", async () => { throw new Error("connection reset"); });
    await expect(h.native.send(nativeKey(), { text: "send once" }))
      .rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.reason)
      .toBe("MUTATION_OUTCOME_UNCERTAIN");
    // The response is never replayed: the next attempt fails closed before dispatch.
    await expect(h.native.send(nativeKey(), { text: "send once" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "turn/start"))
      .toHaveLength(1);
  });

  it("fails closed and marks the unified runtime unavailable on a durable-store fault", async () => {
    const h = fencedAdapter();
    h.reconciliationStore.failOn.add("get");
    await expect(h.native.rename(nativeKey(), "x"))
      .rejects.toMatchObject({ code: "DISABLED" });
    expect(h.reconciliationStore.unavailable).toBe(true);
    // The whole adapter is now unavailable; every later call fails closed.
    await expect(h.native.readTask(nativeKey(), false))
      .rejects.toMatchObject({ code: "DISABLED" });
  });
});

// --- Remaining Task 4 adversarial reconciliation / lease scenarios ---

/** The exact durable fingerprint the fence computes for a given native thread shape. */
const codexFingerprint = (overrides: Record<string, unknown> = {}): string =>
  buildCodexNativeRevision(
    parseCodexThreadReadResult({ thread: nativeThread("thread-1", overrides) }).thread,
  ).fingerprint;

const anthropicKey = (nativeTaskId = "thread-1"): NativeTaskKey =>
  ({ provider: "anthropic", home: HOME, nativeTaskId }) as unknown as NativeTaskKey;

describe("CodexNativeAdapter adversarial writer-lease + reconciliation parity", () => {
  it("fails a racing writer closed when another adapter takes the key over mid-reread", async () => {
    // Two adapters (two supervised processes) share one writer-lease store and one
    // durable reconciliation store, contending for the exact same task key.
    const writerLeases = new FakeWriterLeaseStore();
    writerLeases.markLostOnReacquire = true;
    const reconciliationStore = new FakeReconciliationStore();
    const build = () => {
      const supervisor = new FakeSupervisor();
      const native = new CodexNativeAdapter({
        home: HOME,
        supervisor,
        cursorSecret: SECRET,
        isEnabled: () => true,
        requestMode: "manual",
        writerLeases,
        reconciliationStore,
      });
      return { native, supervisor };
    };
    const a = build();
    const b = build();

    // Adapter A acquires first (epoch 1) and then parks at its fence reread.
    let resolveARead!: (value: unknown) => void;
    a.supervisor.lease.enqueue("thread/read", () => new Promise((resolve) => {
      resolveARead = resolve;
    }));
    a.supervisor.lease.enqueue("thread/name/set", {});
    const aRename = a.native.rename(nativeKey(), "A");
    await vi.waitFor(() =>
      expect(a.supervisor.lease.calls.some(({ method }) => method === "thread/read")).toBe(true));

    // Adapter B takes the key over with a full mutation (epoch 2), fencing A's handle.
    b.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    b.supervisor.lease.enqueue("thread/name/set", {});
    await expect(b.native.rename(nativeKey(), "B")).resolves.toBeUndefined();

    // A resumes: its lease was taken over, so the reread can no longer be confirmed.
    resolveARead({ thread: nativeThread("thread-1") });
    await expect(aRename).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(reconciliationStore.rows.get(keyId(nativeKey()))?.reason).toBe("WRITER_LEASE_LOST");

    // Single-writer ordering: monotonic epochs, and A never wrote its name.
    expect(writerLeases.handles.map((handle) => handle.fence.epoch)).toEqual([1, 2]);
    expect(a.supervisor.lease.calls.some(({ method }) => method === "thread/name/set")).toBe(false);
  });

  it("isolates a Codex task from a Claude latch that shares the same native task id", async () => {
    const h = fencedAdapter();
    // A Claude (anthropic) reconciliation latch for the identical native id must not
    // block the Codex (openai) task; the locator carries the provider.
    h.reconciliationStore.seedRequired(anthropicKey("thread-1"));

    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/name/set", {});
    await expect(h.native.rename(nativeKey("thread-1"), "codex-ok")).resolves.toBeUndefined();
    // The anthropic latch is untouched and no openai row was created by the clean run.
    expect(h.reconciliationStore.rows.get(keyId(anthropicKey("thread-1")))?.required).toBe(true);
    expect(h.reconciliationStore.rows.has(keyId(nativeKey("thread-1")))).toBe(false);

    // The reverse also holds: latching the openai task leaves the anthropic row intact.
    // Establish a reviewed baseline via resume, then drift it to latch the openai task.
    enqueueRead(h);
    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/resume", configuredResult(nativeThread("thread-1"), "readOnly"));
    await h.native.resumeTask(nativeKey("thread-1"), { permissionMode: "read-only" });
    enqueueRead(h);
    enqueueRead(h, { updatedAt: 1_700_099_999 });
    await expect(h.native.resumeTask(nativeKey("thread-1"), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey("thread-1")))?.required).toBe(true);
    expect(h.reconciliationStore.rows.get(keyId(anthropicKey("thread-1")))?.required).toBe(true);
  });

  it("fails closed on a non-monotonic (ABA) writer epoch before any reread or dispatch", async () => {
    const h = fencedAdapter();
    // First mutation gets epoch 5 and records it as the last writer epoch.
    h.writerLeases.epochSequence = [5, 5];
    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/name/set", {});
    await expect(h.native.rename(nativeKey(), "first")).resolves.toBeUndefined();

    // A stale writer returns to epoch 5 (ABA). The fence refuses it before reading.
    await expect(h.native.rename(nativeKey(), "second"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.reason).toBe("WRITER_LEASE_LOST");
    // Only the first mutation ever reread or dispatched.
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "thread/read")).toHaveLength(1);
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "thread/name/set")).toHaveLength(1);
  });

  it("refuses a fenced write whose fence identity was tampered by a hostile clock", async () => {
    // A lease that invokes the fenced-write body with a mismatched epoch (as if a
    // hostile clock resurrected an old fence) must be rejected as OWNERSHIP.
    const tampering: NativeTaskWriterLease = {
      key: nativeKey() as NativeTaskKey,
      fence: Object.freeze({ key: nativeKey() as NativeTaskKey, epoch: 7 }),
      rereadRequired: true,
      usable: true,
      lost: false,
      released: false,
      lossReason: null,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      confirmReread: () => true,
      heartbeat: () => true,
      runFencedWrite: <T>(start: (fence: { key: NativeTaskKey; epoch: number }) => T) =>
        ({ started: true as const, value: start({ key: nativeKey() as NativeTaskKey, epoch: 999 }) }),
      release: () => true,
    } as unknown as NativeTaskWriterLease;
    const supervisor = new FakeSupervisor();
    const reconciliationStore = new FakeReconciliationStore();
    const native = new CodexNativeAdapter({
      home: HOME,
      supervisor,
      cursorSecret: SECRET,
      isEnabled: () => true,
      requestMode: "manual",
      writerLeases: { acquire: () => tampering },
      reconciliationStore,
    });
    supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    supervisor.lease.enqueue("thread/name/set", {});
    await expect(native.rename(nativeKey(), "x")).rejects.toMatchObject({ code: "OWNERSHIP" });
    expect(supervisor.lease.calls.some(({ method }) => method === "thread/name/set")).toBe(false);
  });

  it("fails closed and releases the lease when the fenced write cannot start (heartbeat loss)", async () => {
    const h = fencedAdapter();
    h.writerLeases.leaseOpts = { started: false };
    enqueueRead(h);
    await expect(h.native.rename(nativeKey(), "x"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.reason).toBe("WRITER_LEASE_LOST");
    // The lease is always released on the terminal path.
    expect(h.writerLeases.handles[0]?.releaseCalls).toBeGreaterThanOrEqual(1);
    expect(h.supervisor.lease.calls.some(({ method }) => method === "thread/name/set")).toBe(false);
  });

  it("never dispatches a send before native contact when the writer lease is lost, and never replays", async () => {
    const h = fencedAdapter();
    h.writerLeases.mode = "null";
    await expect(h.native.send(nativeKey(), { text: "before" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.supervisor.lease.calls.some(({ method }) => method === "turn/start")).toBe(false);
    // The durable latch keeps a retry closed even once the lease is healthy again.
    h.writerLeases.mode = "ok";
    await expect(h.native.send(nativeKey(), { text: "before" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.supervisor.lease.calls.some(({ method }) => method === "turn/start")).toBe(false);
  });

  it("latches and never replays when a process generation change commits during a send", async () => {
    const h = fencedAdapter();
    enqueueRead(h);
    h.supervisor.lease.enqueue("turn/start", async () => {
      // A supervised process generation change lands after the dispatch began.
      await h.native.reconcile({
        home: HOME,
        generation: 2,
        signal: new AbortController().signal,
        rpc: { call: async () => ({}) },
      } as unknown as AppServerReconcileContext);
      return { turn: nativeTurn("turn-2", "inProgress") };
    });
    await expect(h.native.send(nativeKey(), { text: "go" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.reason).toBe("PROCESS_GENERATION_CHANGED");
    // The turn/start was issued exactly once and is never replayed.
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    await expect(h.native.send(nativeKey(), { text: "again" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.supervisor.lease.calls.filter(({ method }) => method === "turn/start")).toHaveLength(1);
  });

  it("stays fence-consistent when a live callback reenters during a fenced dispatch", async () => {
    const h = fencedAdapter();
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const received: unknown[] = [];
    const unsubscribe = await h.native.subscribe(nativeKey(), (event) => received.push(event));
    const handlers = h.supervisor.acquires[0]!.handlers;

    enqueueRead(h); // fence reread for the send
    h.supervisor.lease.enqueue("turn/start", async () => {
      // A live notification arrives (reentrant callback) while the mutation is in flight.
      await handlers.onNotification({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hi " },
      }, { home: HOME, generation: 1, signal: new AbortController().signal });
      return { turn: nativeTurn("turn-2", "inProgress") };
    });
    await expect(h.native.send(nativeKey(), { text: "go" })).resolves.toMatchObject({ turnId: "turn-2" });
    expect(received).toContainEqual(expect.objectContaining({ type: "message-delta", delta: "hi " }));
    // The reentrant callback did not spuriously latch reconciliation.
    expect(h.reconciliationStore.rows.size).toBe(0);
    await unsubscribe();
  });

  it("routes respond through the fence and correlates the exact approval once", async () => {
    const h = fencedAdapter();
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const received: unknown[] = [];
    const unsubscribe = await h.native.subscribe(nativeKey(), (event) => received.push(event));
    const handlers = h.supervisor.acquires[0]!.handlers;
    const signal = new AbortController().signal;

    const response = handlers.onServerRequest({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", approvalId: null, startedAtMs: 1 },
    }, { home: HOME, generation: 1, signal });
    await vi.waitFor(() =>
      expect(received).toContainEqual(expect.objectContaining({ type: "request" })));
    const requestEvent = received.find((event) =>
      typeof event === "object" && event !== null &&
      (event as { type?: string }).type === "request") as { request: { identity: Record<string, unknown> } };

    enqueueRead(h); // fence reread for respond
    await expect(h.native.respond({
      kind: "command-approval",
      identity: requestEvent.request.identity as never,
      decision: "allow",
    })).resolves.toBeUndefined();
    await expect(response).resolves.toEqual({ decision: "accept" });
    // respond acquired the exact-task writer lease and fenced the dispatch.
    expect(h.writerLeases.acquires.some((key) => key.nativeTaskId === "thread-1")).toBe(true);
    expect(h.writerLeases.handles.at(-1)?.fencedWrites).toBe(1);
    expect(h.reconciliationStore.rows.size).toBe(0);
    await unsubscribe();
  });

  it("treats a stale approval respond as a fenced no-op that never latches or replays", async () => {
    const h = fencedAdapter();
    h.supervisor.lease.enqueue("thread/read", { thread: nativeThread("thread-1") });
    h.supervisor.lease.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const received: unknown[] = [];
    const unsubscribe = await h.native.subscribe(nativeKey(), (event) => received.push(event));
    const handlers = h.supervisor.acquires[0]!.handlers;
    const signal = new AbortController().signal;

    const response = handlers.onServerRequest({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", approvalId: null, startedAtMs: 1 },
    }, { home: HOME, generation: 1, signal });
    await vi.waitFor(() =>
      expect(received).toContainEqual(expect.objectContaining({ type: "request" })));
    const identity = (received.find((event) =>
      typeof event === "object" && event !== null &&
      (event as { type?: string }).type === "request") as { request: { identity: Record<string, unknown> } })
      .request.identity;

    enqueueRead(h); // first respond fence reread (dispatches)
    await h.native.respond({ kind: "command-approval", identity: identity as never, decision: "allow" });
    await expect(response).resolves.toEqual({ decision: "accept" });

    // The request is now resolved; a second respond is stale and must be a benign no-op.
    enqueueRead(h); // second respond fence reread
    await expect(h.native.respond({
      kind: "command-approval",
      identity: identity as never,
      decision: "allow",
    })).resolves.toBeUndefined();
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.required ?? false).toBe(false);
    await unsubscribe();
  });

  it("restores a durable latch on a fresh (restarted) adapter before any mutation", async () => {
    const store = new FakeReconciliationStore();
    store.seedRequired(nativeKey());
    // A brand-new adapter (both providers restarted) shares only the durable store;
    // it has no in-memory latch but must honor the persisted one.
    const supervisor = new FakeSupervisor();
    const writerLeases = new FakeWriterLeaseStore();
    const native = new CodexNativeAdapter({
      home: HOME,
      supervisor,
      cursorSecret: SECRET,
      isEnabled: () => true,
      requestMode: "manual",
      writerLeases,
      reconciliationStore: store,
    });
    await expect(native.rename(nativeKey(), "after restart"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    // No provider mutation and no writer-lease acquisition slipped past the durable latch.
    expect(supervisor.lease.calls.some(({ method }) => method === "thread/name/set")).toBe(false);
  });

  it("keeps a latched task through in-memory cache eviction pressure", async () => {
    const h = fencedAdapter(true, { maxTrackedRevisions: 2 });
    h.reconciliationStore.seedRequired(nativeKey("keep"));
    // Restore the durable latch into this process' in-memory cache.
    await expect(h.native.rename(nativeKey("keep"), "blocked"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    // Churn other tasks to force eviction; the latched task must never be evicted.
    for (const id of ["churn-a", "churn-b", "churn-c"]) {
      h.supervisor.lease.enqueue("thread/read", { thread: nativeThread(id) });
      h.supervisor.lease.enqueue("thread/name/set", {});
      await expect(h.native.rename(nativeKey(id), "ok")).resolves.toBeUndefined();
    }

    // The latched task is still fenced closed with no fresh durable read needed.
    await expect(h.native.rename(nativeKey("keep"), "still blocked"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey("keep")))?.required).toBe(true);
  });

  it("monotonically increments the durable latch revision across clear then same-fingerprint relatch", async () => {
    const h = fencedAdapter();
    const fp0 = codexFingerprint();
    const drift = { updatedAt: 1_700_099_999 };
    const fp1 = codexFingerprint(drift);

    // Establish a reviewed baseline (fp0), then drift to latch (revision 1).
    enqueueRead(h);
    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/resume", configuredResult(nativeThread("thread-1"), "readOnly"));
    await h.native.resumeTask(nativeKey(), { permissionMode: "read-only" });
    enqueueRead(h);
    enqueueRead(h, drift);
    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const first = h.reconciliationStore.rows.get(keyId(nativeKey()));
    expect(first?.latchRevision).toBe(1);
    expect(first?.reviewedFingerprint).toBe(fp0);
    expect(first?.nativeFingerprint).toBe(fp1);

    // Acknowledge with the exact reviewed fingerprint and the current native (fp1).
    enqueueRead(h, drift);
    await h.native.acknowledgeReconciliation(nativeKey(), fp0);
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.required).toBe(false);

    // The reviewed baseline is now fp1; drift it again to relatch with the same shape.
    const drift2 = { updatedAt: 1_700_199_999 };
    enqueueRead(h, drift);
    enqueueRead(h, drift2);
    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    // The durable latch revision advanced instead of resetting.
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.latchRevision).toBe(2);
  });

  it("refuses a stale-revision acknowledge when a newer durable latch exists", async () => {
    const h = fencedAdapter();
    const fp0 = codexFingerprint();
    const drift = { updatedAt: 1_700_099_999 };

    enqueueRead(h);
    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/resume", configuredResult(nativeThread("thread-1"), "readOnly"));
    await h.native.resumeTask(nativeKey(), { permissionMode: "read-only" });
    enqueueRead(h);
    enqueueRead(h, drift);
    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    // A concurrent relatch bumps the durable revision between read and CAS.
    h.reconciliationStore.relatchOnAck = true;
    enqueueRead(h, drift);
    await expect(h.native.acknowledgeReconciliation(nativeKey(), fp0))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.required).toBe(true);
    // Still fenced closed for later mutations.
    await expect(h.native.rename(nativeKey(), "blocked"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
  });

  it("stays latched when an acknowledge presents a mismatched reviewed fingerprint", async () => {
    const h = fencedAdapter();
    const drift = { updatedAt: 1_700_099_999 };

    enqueueRead(h);
    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/resume", configuredResult(nativeThread("thread-1"), "readOnly"));
    await h.native.resumeTask(nativeKey(), { permissionMode: "read-only" });
    enqueueRead(h);
    enqueueRead(h, drift);
    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    // Acknowledge with a fingerprint that does not match the reviewed baseline.
    enqueueRead(h, drift);
    await expect(h.native.acknowledgeReconciliation(nativeKey(), "codex-rev-wrong-fingerprint"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.required).toBe(true);
  });

  it("clears the durable and live latch on an exact acknowledge and re-enables mutations", async () => {
    const h = fencedAdapter();
    const fp0 = codexFingerprint();
    const drift = { updatedAt: 1_700_099_999 };

    enqueueRead(h);
    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/resume", configuredResult(nativeThread("thread-1"), "readOnly"));
    await h.native.resumeTask(nativeKey(), { permissionMode: "read-only" });
    enqueueRead(h);
    enqueueRead(h, drift);
    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    // Authoritative reread + exact-fingerprint acknowledge clears the latch.
    enqueueRead(h, drift);
    await expect(h.native.acknowledgeReconciliation(nativeKey(), fp0)).resolves.toBeUndefined();
    expect(h.reconciliationStore.rows.get(keyId(nativeKey()))?.required).toBe(false);

    // A follow-up mutation now proceeds (reviewed baseline is the acknowledged native).
    enqueueRead(h, drift);
    h.supervisor.lease.enqueue("thread/name/set", {});
    await expect(h.native.rename(nativeKey(), "after ack")).resolves.toBeUndefined();
  });

  it("fails closed and marks the runtime unavailable on a durable require fault", async () => {
    const h = fencedAdapter();
    // Establish a reviewed baseline so a drift attempts a durable requireReconciliation.
    enqueueRead(h);
    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/resume", configuredResult(nativeThread("thread-1"), "readOnly"));
    await h.native.resumeTask(nativeKey(), { permissionMode: "read-only" });

    h.reconciliationStore.failOn.add("require");
    enqueueRead(h);
    enqueueRead(h, { updatedAt: 1_700_099_999 });
    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "DISABLED" });
    expect(h.reconciliationStore.unavailable).toBe(true);
    await expect(h.native.readTask(nativeKey(), false)).rejects.toMatchObject({ code: "DISABLED" });
  });

  it("fails closed and marks the runtime unavailable on a durable acknowledge fault", async () => {
    const h = fencedAdapter();
    const drift = { updatedAt: 1_700_099_999 };
    enqueueRead(h);
    enqueueRead(h);
    h.supervisor.lease.enqueue("thread/resume", configuredResult(nativeThread("thread-1"), "readOnly"));
    await h.native.resumeTask(nativeKey(), { permissionMode: "read-only" });
    enqueueRead(h);
    enqueueRead(h, drift);
    await expect(h.native.resumeTask(nativeKey(), { permissionMode: "read-only" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    h.reconciliationStore.failOn.add("ack");
    enqueueRead(h, drift);
    await expect(h.native.acknowledgeReconciliation(nativeKey(), codexFingerprint()))
      .rejects.toMatchObject({ code: "DISABLED" });
    expect(h.reconciliationStore.unavailable).toBe(true);
    await expect(h.native.readTask(nativeKey(), false)).rejects.toMatchObject({ code: "DISABLED" });
  });
});
