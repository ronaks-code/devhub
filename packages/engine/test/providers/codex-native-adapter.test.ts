import { describe, expect, it, vi } from "vitest";
import {
  CodexNativeAdapter,
  CodexNativeAdapterError,
} from "../../src/providers/codex/native-adapter.js";
import { CodexRemoteRpcError } from "../../src/providers/codex/protocol/rpc-peer.js";
import type {
  AppServerReconcileContext,
  CodexAppServerLease,
  CodexSupervisorAcquireOptions,
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
