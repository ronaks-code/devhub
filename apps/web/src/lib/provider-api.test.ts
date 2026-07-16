import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "./api.js";
import {
  ProviderHttpError,
  ProviderMutationUncertainError,
  ProviderProtocolError,
  ProviderReconciliationRequiredError,
  ProviderStreamError,
  createProviderApiClient,
  isProviderReconciliationRequired,
  providerApi,
  type CrossProviderHandoffLink,
  type CrossProviderHandoffPreview,
  type NativeTask,
  type NativeTaskKey,
  type ProviderCapabilities,
  type ProviderEvent,
  type TaskOverrides,
} from "./provider-api.js";

const ACCESS_TOKEN = "provider-browser-token";
const KEY: NativeTaskKey = {
  provider: "openai",
  home: "/Users/test/.codex home",
  nativeTaskId: "task/with spaces",
};
const FINGERPRINT = "revision-fingerprint-current";

const TASK: NativeTask = {
  key: KEY,
  title: "Native task",
  cwd: "/workspace",
  model: "gpt-5",
  status: "idle",
  createdAt: "2026-07-13T01:00:00.000Z",
  updatedAt: "2026-07-13T01:01:00.000Z",
  archived: false,
  source: "native",
  revision: {
    updatedAt: 1,
    status: "idle",
    lastTurnId: null,
    lastTurnStatus: null,
    lastItemId: null,
    fingerprint: FINGERPRINT,
  },
  turns: [],
};

const { turns: _taskTurns, ...TASK_SUMMARY } = TASK;

const CAPABILITIES: ProviderCapabilities = {
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
  skills: false,
  plugins: false,
  hooks: false,
  mcp: false,
  backgroundWork: false,
};

const REQUEST_EVENT: ProviderEvent = {
  type: "request",
  provider: "openai",
  key: KEY,
  occurredAt: "2026-07-13T02:00:00.000Z",
  request: {
    kind: "command-approval",
    identity: {
      key: KEY,
      generation: 1,
      turnId: "turn-1",
      requestId: 7,
      itemId: "item-1",
      approvalId: "approval-1",
    },
  },
};

const DEEP_TASK: NativeTask = {
  ...TASK,
  turns: [{
    id: "turn-1",
    status: "running",
    startedAt: "2026-07-13T02:00:00.000Z",
    completedAt: null,
    events: [REQUEST_EVENT],
  }],
};

function taskWithEvents(events: readonly unknown[]): NativeTask {
  return {
    ...DEEP_TASK,
    turns: [{ ...DEEP_TASK.turns[0]!, events }],
  } as NativeTask;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function empty(status = 204): Response {
  return new Response(null, { status });
}

function bytesResponse(
  chunks: readonly Uint8Array[],
  init: ResponseInit,
  close = true,
): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
    cancel(reason) {
      cancel(reason);
    },
  });
  return { response: new Response(body, init), cancel };
}

function parsedBody(call: unknown[]): unknown {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body));
}

function controlledStream(): {
  response: Response;
  controller: ReadableStreamDefaultController<Uint8Array>;
  cancel: ReturnType<typeof vi.fn>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
    cancel(reason) {
      cancel(reason);
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
    controller,
    cancel,
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => ACCESS_TOKEN,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("providerApi browser HTTP contract", () => {
  it("discovers provider descriptors with a Bearer header and never a URL token", async () => {
    const descriptors = [{
      provider: "openai",
      home: KEY.home,
      status: "unavailable",
      error: { code: "PROVIDER_ADAPTER_FAILURE", message: "offline" },
    }];
    const fetchMock = vi.fn().mockResolvedValue(json(descriptors));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerApi.providers()).resolves.toEqual([{
      ...descriptors[0],
      error: { code: "PROVIDER_ADAPTER_FAILURE", message: "Provider adapter unavailable" },
    }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/providers", {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("token=");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(ACCESS_TOKEN);
  });

  it("encodes list and read ownership in paths and query parameters", async () => {
    const page = { items: [TASK_SUMMARY], nextCursor: "next cursor" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(page))
      .mockResolvedValueOnce(json(TASK));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerApi.list({
      provider: "openai",
      home: KEY.home,
      cursor: "cursor/1",
      limit: 25,
      includeArchived: true,
    })).resolves.toEqual(page);
    await expect(providerApi.read(KEY, true)).resolves.toEqual(TASK);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/providers/openai/tasks?home=%2FUsers%2Ftest%2F.codex+home&cursor=cursor%2F1&limit=25&includeArchived=true",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/providers/openai/tasks/task%2Fwith%20spaces?home=%2FUsers%2Ftest%2F.codex+home&includeTurns=true",
    );
  });

  it("accepts the server's bounded 8 KiB opaque list cursors", async () => {
    const nextCursor = `v1.${"a".repeat(7_000)}.signature`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ items: [], nextCursor })));

    await expect(createProviderApiClient().list({
      provider: "openai",
      home: KEY.home,
    })).resolves.toEqual({ items: [], nextCursor });
  });

  it("passes an abort signal through authoritative reads and preserves AbortError", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        }, { once: true });
      }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createProviderApiClient().read(KEY, true, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("wraps a normal start and preserves a partial start as explicit non-retry outcomes", async () => {
    const partial = {
      outcome: "partial",
      code: "PARTIAL_START",
      provider: "openai",
      task: { ...TASK, key: { ...KEY, nativeTaskId: "created-before-failure" } },
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(TASK, 201))
      .mockResolvedValueOnce(json(partial, 201));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      home: KEY.home,
      cwd: "/workspace",
      model: "gpt-5",
      permissionMode: "read-only",
      input: { text: "Begin" },
    };

    await expect(providerApi.start("openai", input)).resolves.toEqual({
      outcome: "created",
      task: TASK,
    });
    await expect(providerApi.start("openai", input)).resolves.toEqual(partial);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/providers/openai/tasks");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(input),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("supports resume and exposes partial forks without converting them into failures", async () => {
    const client = createProviderApiClient();
    const forked = { ...TASK, key: { ...KEY, nativeTaskId: "forked-task" } };
    const partial = {
      outcome: "partial",
      code: "PARTIAL_FORK",
      provider: "openai",
      task: forked,
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(json(partial, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.resume(KEY, { model: "gpt-5", permissionMode: "read-only" }))
      .resolves.toEqual(TASK);
    await expect(client.fork(KEY, "turn/1")).resolves.toEqual(partial);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/providers/openai/tasks/task%2Fwith%20spaces/resume",
    );
    expect(parsedBody(fetchMock.mock.calls[0]!)).toEqual({
      home: KEY.home,
      model: "gpt-5",
      permissionMode: "read-only",
    });
    expect(parsedBody(fetchMock.mock.calls[1]!)).toEqual({
      home: KEY.home,
      lastTurnId: "turn/1",
    });
  });

  it("M7: builds a cross-provider fork preview and commits it against the target home", async () => {
    const preview: CrossProviderHandoffPreview = {
      sourceLocator: { version: 1, provider: "openai", homeFingerprint: "fp-source", nativeTaskId: KEY.nativeTaskId },
      sourceContentHash: "a".repeat(64),
      targetProvider: "anthropic",
      targetModel: null,
      targetMode: "code",
      targetCwd: "/workspace/target",
      transferredContext: { messages: [{ role: "user", text: "hello" }] },
    };
    const targetKey: NativeTaskKey = {
      provider: "anthropic",
      home: "/Users/test/.claude home",
      nativeTaskId: "claude-task-1",
    };
    const targetTask: NativeTask = {
      ...TASK,
      key: targetKey,
      title: "Forked task",
    };
    const link: CrossProviderHandoffLink = {
      sourceLocator: preview.sourceLocator,
      targetLocator: { version: 1, provider: "anthropic", homeFingerprint: "fp-target", nativeTaskId: targetKey.nativeTaskId },
      sourceContentHash: preview.sourceContentHash,
      createdAt: "2026-07-16T00:00:00.000Z",
      forSource: {
        relation: "handoff-source",
        self: preview.sourceLocator,
        counterpart: { version: 1, provider: "anthropic", homeFingerprint: "fp-target", nativeTaskId: targetKey.nativeTaskId },
        sourceContentHash: preview.sourceContentHash,
        createdAt: "2026-07-16T00:00:00.000Z",
      },
      forTarget: {
        relation: "handoff-target",
        self: { version: 1, provider: "anthropic", homeFingerprint: "fp-target", nativeTaskId: targetKey.nativeTaskId },
        counterpart: preview.sourceLocator,
        sourceContentHash: preview.sourceContentHash,
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    };

    const client = createProviderApiClient();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ previewId: "preview-1", preview }))
      .mockResolvedValueOnce(json({ targetTask, link }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const previewResult = await client.forkPreviewCrossProvider(KEY, {
      provider: "anthropic",
      home: targetKey.home,
      cwd: "/workspace/target",
      mode: "code",
    });
    expect(previewResult).toEqual({ previewId: "preview-1", preview });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/providers/openai/tasks/task%2Fwith%20spaces/fork-preview",
    );
    expect(parsedBody(fetchMock.mock.calls[0]!)).toEqual({
      home: KEY.home,
      target: { provider: "anthropic", home: targetKey.home, cwd: "/workspace/target", mode: "code" },
    });

    const commitResult = await client.forkCommitCrossProvider(
      KEY,
      { provider: "anthropic", home: targetKey.home },
      "preview-1",
    );
    expect(commitResult).toEqual({ targetTask, link });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/providers/openai/tasks/task%2Fwith%20spaces/fork-commit",
    );
    expect(parsedBody(fetchMock.mock.calls[1]!)).toEqual({ previewId: "preview-1" });
  });

  it("M7: surfaces a disabled cross-provider fork preview as a ProviderHttpError", async () => {
    const client = createProviderApiClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "cross_provider_fork_disabled" }, 403)),
    );
    await expect(
      client.forkPreviewCrossProvider(KEY, {
        provider: "anthropic",
        home: "/Users/test/.claude",
        cwd: "/workspace",
      }),
    ).rejects.toMatchObject({ status: 403, code: "cross_provider_fork_disabled" });
  });

  it("never lets runtime extra properties override a task's immutable resume ownership", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(TASK));
    vi.stubGlobal("fetch", fetchMock);
    const untrustedOverrides = {
      model: "gpt-5",
      permissionMode: "read-only",
      home: "/Users/attacker/.codex",
      unexpected: "drop-me",
    } as TaskOverrides;

    await providerApi.resume(KEY, untrustedOverrides);

    expect(parsedBody(fetchMock.mock.calls[0]!)).toEqual({
      home: KEY.home,
      model: "gpt-5",
      permissionMode: "read-only",
    });
  });

  it("sends, steers, and interrupts with exact provider task bodies", async () => {
    const turnRef = { taskKey: KEY, turnId: "turn-2" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(turnRef, 202))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(empty());
    vi.stubGlobal("fetch", fetchMock);
    const input = { text: "Continue", attachments: [{ name: "a.txt", path: "/tmp/a.txt" }] };

    await expect(providerApi.send(KEY, input)).resolves.toEqual(turnRef);
    await expect(providerApi.steer(KEY, "turn-2", input)).resolves.toBeUndefined();
    await expect(providerApi.interrupt(KEY, "turn-2")).resolves.toBeUndefined();

    expect(parsedBody(fetchMock.mock.calls[0]!)).toEqual({ home: KEY.home, input });
    expect(parsedBody(fetchMock.mock.calls[1]!)).toEqual({
      home: KEY.home,
      expectedTurnId: "turn-2",
      input,
    });
    expect(parsedBody(fetchMock.mock.calls[2]!)).toEqual({ home: KEY.home, turnId: "turn-2" });
  });

  it("dispatches request responses without duplicating the task key in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ status: "dispatched" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerApi.respond({
      kind: "command-approval",
      identity: {
        key: KEY,
        generation: 4,
        turnId: "turn-2",
        requestId: 7,
        itemId: "item-3",
        approvalId: "approval-1",
      },
      decision: "allow",
    })).resolves.toBe("dispatched");

    expect(parsedBody(fetchMock.mock.calls[0]!)).toEqual({
      home: KEY.home,
      kind: "command-approval",
      identity: {
        generation: 4,
        turnId: "turn-2",
        requestId: 7,
        itemId: "item-3",
        approvalId: "approval-1",
      },
      decision: "allow",
    });
  });

  it("archives and renames using authenticated POST requests", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(empty()).mockResolvedValueOnce(empty());
    vi.stubGlobal("fetch", fetchMock);

    await providerApi.archive(KEY);
    await providerApi.rename(KEY, "Renamed task");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/providers/openai/tasks/task%2Fwith%20spaces/archive",
      "/api/providers/openai/tasks/task%2Fwith%20spaces/rename",
    ]);
    expect(parsedBody(fetchMock.mock.calls[0]!)).toEqual({ home: KEY.home });
    expect(parsedBody(fetchMock.mock.calls[1]!)).toEqual({ home: KEY.home, name: "Renamed task" });
  });

  it("throws typed unauthorized and safe HTTP errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(json({
        error: "provider_capability_unavailable",
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerApi.providers()).rejects.toBeInstanceOf(UnauthorizedError);
    const failure = providerApi.resume(KEY);
    await expect(failure).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      retryable: false,
    });
    await expect(failure).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("classifies malformed partial envelopes as uncertain instead of inviting a retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      outcome: "partial",
      code: "PARTIAL_FORK",
      provider: "openai",
      task: TASK,
    }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const client = createProviderApiClient();
    await expect(client.start("openai", {
      home: KEY.home,
      cwd: "/workspace",
    })).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
      retryable: false,
    });
  });

  it("classifies mutation transport drops and every 5xx response as non-retryable uncertainty", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket dropped after dispatch /Users/private"))
      .mockResolvedValueOnce(json({
        error: "provider_unavailable",
        code: "PROVIDER_ADAPTER_FAILURE",
      }, 503));
    vi.stubGlobal("fetch", fetchMock);

    for (const run of [
      () => createProviderApiClient().send(KEY, { text: "send once" }),
      () => createProviderApiClient().rename(KEY, "rename once"),
    ]) {
      const operation = run();
      await expect(operation).rejects.toMatchObject({
        name: "ProviderMutationUncertainError",
        code: "MUTATION_UNCERTAIN",
        retryable: false,
        message: "Provider mutation outcome is uncertain",
      });
      await expect(operation).rejects.toBeInstanceOf(ProviderMutationUncertainError);
    }
  });

  it("honors exact server mutation-uncertain responses for task and home scopes", async () => {
    const taskClient = createProviderApiClient();
    const homeClient = createProviderApiClient();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({
      error: "provider_mutation_uncertain",
      code: "MUTATION_UNCERTAIN",
      provider: "openai",
      retryable: false,
    }, 409)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(taskClient.send(KEY, { text: "send once" })).rejects.toBeInstanceOf(
      ProviderMutationUncertainError,
    );
    await expect(taskClient.send(KEY, { text: "must reconcile first" })).rejects.toBeInstanceOf(
      ProviderReconciliationRequiredError,
    );
    await expect(homeClient.start("openai", { home: KEY.home, cwd: "/workspace" }))
      .rejects.toBeInstanceOf(ProviderMutationUncertainError);
    await expect(homeClient.start("openai", { home: KEY.home, cwd: "/workspace" }))
      .rejects.toBeInstanceOf(ProviderReconciliationRequiredError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors an exact server reconciliation-required response without claiming dispatch uncertainty", async () => {
    const client = createProviderApiClient();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({
        error: "provider_reconciliation_required",
        code: "RECONCILIATION_REQUIRED",
        provider: "openai",
        retryable: false,
      }, 409))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ taskKey: KEY, turnId: "turn-after-reconcile" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.send(KEY, { text: "must reconcile" })).rejects.toMatchObject({
      name: "ProviderReconciliationRequiredError",
      code: "RECONCILIATION_REQUIRED",
      scope: "task",
      canAcknowledge: false,
    });
    await expect(client.send(KEY, { text: "must remain blocked" }))
      .rejects.toBeInstanceOf(ProviderReconciliationRequiredError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.read(KEY, true);
    await expect(client.acknowledgeReconciliation({
      scope: "task",
      key: KEY,
      fingerprint: FINGERPRINT,
    })).resolves.toBeUndefined();
    await expect(client.send(KEY, { text: "safe after reconcile" })).resolves.toEqual({
      taskKey: KEY,
      turnId: "turn-after-reconcile",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not trust a partial or mismatched mutation-uncertain error envelope", async () => {
    const client = createProviderApiClient();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      error: "provider_policy_mismatch",
      code: "MUTATION_UNCERTAIN",
    }, 409)));

    await expect(client.send(KEY, { text: "not exact" })).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 409,
      code: "MUTATION_UNCERTAIN",
    });
  });

  it("retains explicit stable non-dispatch errors while allowlisting their codes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({
        error: "provider_capability_unavailable",
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      }, 409))
      .mockResolvedValueOnce(json({
        error: "/Users/private/.codex",
        code: "SK_LIVE_ARBITRARY_SECRET",
      }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerApi.resume(KEY)).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 409,
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      retryable: false,
    });
    const unsafe = providerApi.resume(KEY);
    await expect(unsafe).rejects.toMatchObject({ code: null });
    await expect(unsafe).rejects.not.toThrow(KEY.home);
    await expect(unsafe).rejects.not.toThrow(KEY.nativeTaskId);
    await expect(unsafe).rejects.not.toThrow("SK_LIVE_ARBITRARY_SECRET");
  });

  it("retains the value-free native-task-missing code and public error tag", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({
        error: "provider_task_not_found",
        code: "NATIVE_TASK_MISSING",
        provider: "openai",
        remote: "thread not loaded: secret-native-task-id",
        home: KEY.home,
        cause: "sk-live-arbitrary-secret",
      }, 404))
      .mockResolvedValueOnce(json({
        error: "provider_task_not_found",
        provider: "openai",
      }, 404));
    vi.stubGlobal("fetch", fetchMock);

    const coded = providerApi.read(KEY);
    await expect(coded).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 404,
      code: "NATIVE_TASK_MISSING",
    });
    await expect(coded).rejects.not.toThrow(KEY.home);
    await expect(coded).rejects.not.toThrow(KEY.nativeTaskId);
    await expect(coded).rejects.not.toThrow("sk-live-arbitrary-secret");

    await expect(providerApi.read(KEY)).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 404,
      code: "provider_task_not_found",
    });
  });

  it("keeps unauthorized errors free of task homes and native ids", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "unauthorized" }, 401)));

    const failure = providerApi.read(KEY, true);
    await expect(failure).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(failure).rejects.not.toThrow(KEY.home);
    await expect(failure).rejects.not.toThrow(KEY.nativeTaskId);
    await expect(failure).rejects.not.toThrow("%2FUsers");
  });
});

describe("providerApi exact recursive response validation", () => {
  it("accepts complete descriptors and rejects missing or extra descriptor fields", async () => {
    const valid = [{
      provider: "openai",
      home: KEY.home,
      status: "available",
      capabilities: CAPABILITIES,
    }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(valid))
      .mockResolvedValueOnce(json([{ ...valid[0], unexpected: true }]))
      .mockResolvedValueOnce(json([{
        ...valid[0],
        capabilities: { ...CAPABILITIES, read: undefined },
      }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerApi.providers()).resolves.toEqual(valid);
    await expect(providerApi.providers()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(providerApi.providers()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects list summaries that escape ownership or carry unknown fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({
        items: [{ ...TASK, turns: undefined, key: { ...KEY, home: "/Users/other/.codex" } }],
        nextCursor: null,
      }))
      .mockResolvedValueOnce(json({
        items: [{ ...TASK, turns: undefined, unexpected: true }],
        nextCursor: null,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { provider: "openai" as const, home: KEY.home };

    await expect(providerApi.list(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(providerApi.list(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("validates task turns, events, and request identities recursively and exactly", async () => {
    const wrongIdentity = {
      ...DEEP_TASK,
      turns: [{
        ...DEEP_TASK.turns[0]!,
        events: [{
          ...REQUEST_EVENT,
          request: {
            ...REQUEST_EVENT.request,
            identity: {
              ...REQUEST_EVENT.request.identity,
              key: { ...KEY, nativeTaskId: "foreign-task" },
            },
          },
        }],
      }],
    };
    const extraEventField = {
      ...DEEP_TASK,
      turns: [{
        ...DEEP_TASK.turns[0]!,
        events: [{ ...REQUEST_EVENT, rawArguments: "must-not-cross" }],
      }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(DEEP_TASK))
      .mockResolvedValueOnce(json(wrongIdentity))
      .mockResolvedValueOnce(json(extraEventField));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerApi.read(KEY, true)).resolves.toEqual(DEEP_TASK);
    await expect(providerApi.read(KEY, true)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(providerApi.read(KEY, true)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("requires nested turn and task event identities to match their history owner", async () => {
    const messageWithNullTurn = taskWithEvents([{
      type: "message",
      provider: "openai",
      key: KEY,
      occurredAt: "2026-07-13T02:00:00.000Z",
      role: "assistant",
      text: "must retain turn ownership",
      turnId: null,
      itemId: "item-1",
    }]);
    const requestWithNullTurn = taskWithEvents([{
      ...REQUEST_EVENT,
      request: {
        ...REQUEST_EVENT.request,
        identity: { ...REQUEST_EVENT.request.identity, turnId: null },
      },
    }]);
    const wrongTurnStatus = taskWithEvents([{
      type: "status",
      provider: "openai",
      key: KEY,
      occurredAt: "2026-07-13T02:00:00.000Z",
      scope: "turn",
      status: "completed",
      nativeId: "foreign-turn",
    }]);
    const wrongTaskStatus = taskWithEvents([{
      type: "status",
      provider: "openai",
      key: KEY,
      occurredAt: "2026-07-13T02:00:00.000Z",
      scope: "task",
      status: "active",
      nativeId: "foreign-task",
    }]);
    const fetchMock = vi.fn();
    for (const task of [
      messageWithNullTurn,
      requestWithNullTurn,
      wrongTurnStatus,
      wrongTaskStatus,
    ]) fetchMock.mockResolvedValueOnce(json(task));
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index < 4; index += 1) {
      await expect(providerApi.read(KEY, true)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
  });

  it("requires a safe nonnegative or null plan step index", async () => {
    const plan = {
      type: "plan",
      provider: "openai",
      key: KEY,
      occurredAt: "2026-07-13T02:00:00.000Z",
      turnId: "turn-1",
      itemId: "plan-1",
      text: "Ship safely",
      status: "inProgress",
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(taskWithEvents([{ ...plan, stepIndex: null }])))
      .mockResolvedValueOnce(json(taskWithEvents([{
        ...plan,
        stepIndex: Number.MAX_SAFE_INTEGER,
      }])))
      .mockResolvedValueOnce(json(taskWithEvents([{ ...plan, stepIndex: -1 }])))
      .mockResolvedValueOnce(json(taskWithEvents([{
        ...plan,
        stepIndex: Number.MAX_SAFE_INTEGER + 1,
      }])))
      .mockResolvedValueOnce(json(taskWithEvents([plan])));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerApi.read(KEY, true)).resolves.toMatchObject({ turns: [{ events: [{ stepIndex: null }] }] });
    await expect(providerApi.read(KEY, true)).resolves.toMatchObject({
      turns: [{ events: [{ stepIndex: Number.MAX_SAFE_INTEGER }] }],
    });
    for (let index = 0; index < 3; index += 1) {
      await expect(providerApi.read(KEY, true)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
  });

  it("rejects wrong-key resume, send, create, and fork responses as mutation uncertainty", async () => {
    const wrongTask = { ...TASK, key: { ...KEY, home: "/Users/other/.codex" } };
    const wrongRef = { taskKey: { ...KEY, nativeTaskId: "other-task" }, turnId: "turn-2" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(wrongTask))
      .mockResolvedValueOnce(json(wrongRef, 202))
      .mockResolvedValueOnce(json(wrongTask, 201))
      .mockResolvedValueOnce(json({
        outcome: "partial",
        code: "PARTIAL_FORK",
        provider: "openai",
        task: wrongTask,
      }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createProviderApiClient().resume(KEY)).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
    await expect(createProviderApiClient().send(KEY, { text: "once" })).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
    });
    await expect(createProviderApiClient().start("openai", { home: KEY.home, cwd: "/workspace" }))
      .rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
    await expect(createProviderApiClient().fork(KEY)).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
  });
});

describe("providerApi reconciliation-required mutation scopes", () => {
  it("blocks replay until an exact task read is explicitly reviewed", async () => {
    const client = createProviderApiClient();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("response dropped"))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ taskKey: KEY, turnId: "turn-after-read" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.send(KEY, { text: "send once" })).rejects.toBeInstanceOf(
      ProviderMutationUncertainError,
    );
    const blocked = client.send(KEY, { text: "must not dispatch" });
    await expect(blocked).rejects.toBeInstanceOf(ProviderReconciliationRequiredError);
    await expect(blocked).rejects.toSatisfy(isProviderReconciliationRequired);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(client.acknowledgeReconciliation({
      scope: "task",
      key: KEY,
      fingerprint: FINGERPRINT,
    })).rejects.toMatchObject({ canAcknowledge: false });

    await expect(client.read(KEY, true)).resolves.toEqual(TASK);
    await expect(client.send(KEY, { text: "read but not reviewed" })).rejects.toMatchObject({
      scope: "task",
      canAcknowledge: true,
    });
    await client.acknowledgeReconciliation({
      scope: "task",
      key: KEY,
      fingerprint: FINGERPRINT,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      `/api/providers/openai/tasks/task%2Fwith%20spaces/reconciliation`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ home: KEY.home, fingerprint: FINGERPRINT }),
      }),
    );
    await expect(client.send(KEY, { text: "safe after read" })).resolves.toEqual({
      taskKey: KEY,
      turnId: "turn-after-read",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retains exact reviewed evidence across a dropped acknowledgement response", async () => {
    const client = createProviderApiClient();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("send response dropped"))
      .mockResolvedValueOnce(json(TASK))
      .mockRejectedValueOnce(new Error("ack response dropped"))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ taskKey: KEY, turnId: "turn-after-ack-retry" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.send(KEY, { text: "send once" }))
      .rejects.toBeInstanceOf(ProviderMutationUncertainError);
    await client.read(KEY, true);
    const target = { scope: "task" as const, key: KEY, fingerprint: FINGERPRINT };
    await expect(client.acknowledgeReconciliation(target)).rejects.toMatchObject({
      name: "ProviderHttpError",
    });
    await expect(client.send(KEY, { text: "still frozen" })).rejects.toMatchObject({
      scope: "task",
      canAcknowledge: true,
    });
    await expect(client.acknowledgeReconciliation(target)).resolves.toBeUndefined();
    await expect(client.send(KEY, { text: "safe after exact retry" })).resolves.toMatchObject({
      turnId: "turn-after-ack-retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("blocks start replay until an authoritative home list is explicitly reviewed", async () => {
    const client = createProviderApiClient();
    const input = { home: KEY.home, cwd: "/workspace" };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("created response dropped"))
      .mockResolvedValueOnce(json({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(json(TASK, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.start("openai", input)).rejects.toBeInstanceOf(
      ProviderMutationUncertainError,
    );
    await expect(client.start("openai", input)).rejects.toBeInstanceOf(
      ProviderReconciliationRequiredError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(client.acknowledgeReconciliation({
      scope: "provider-home",
      provider: "openai",
      home: KEY.home,
    })).rejects.toMatchObject({ canAcknowledge: false });

    await client.list({ provider: "openai", home: KEY.home });
    await expect(client.start("openai", input)).rejects.toMatchObject({
      scope: "provider-home",
      canAcknowledge: true,
    });
    await client.acknowledgeReconciliation({
      scope: "provider-home",
      provider: "openai",
      home: KEY.home,
    });
    await expect(client.start("openai", input)).resolves.toEqual({
      outcome: "created",
      task: TASK,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not accept stale reads or lists as evidence for newer uncertainty", async () => {
    const taskClient = createProviderApiClient();
    const homeClient = createProviderApiClient();
    let resolveRead!: (response: Response) => void;
    let resolveList!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRead = resolve;
      }))
      .mockRejectedValueOnce(new Error("send response dropped"))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveList = resolve;
      }))
      .mockRejectedValueOnce(new Error("start response dropped"));
    vi.stubGlobal("fetch", fetchMock);

    const staleRead = taskClient.read(KEY, true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(taskClient.send(KEY, { text: "committed after read began" }))
      .rejects.toBeInstanceOf(ProviderMutationUncertainError);
    resolveRead(json(TASK));
    await staleRead;
    await expect(taskClient.acknowledgeReconciliation({
      scope: "task",
      key: KEY,
      fingerprint: FINGERPRINT,
    })).rejects.toMatchObject({ canAcknowledge: false });

    const staleList = homeClient.list({ provider: "openai", home: KEY.home });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await expect(homeClient.start("openai", { home: KEY.home, cwd: "/workspace" }))
      .rejects.toBeInstanceOf(ProviderMutationUncertainError);
    resolveList(json({ items: [], nextCursor: null }));
    await staleList;
    await expect(homeClient.acknowledgeReconciliation({
      scope: "provider-home",
      provider: "openai",
      home: KEY.home,
    })).rejects.toMatchObject({ canAcknowledge: false });
  });

  it("isolates uncertainty to the exact task or provider/home scope", async () => {
    const client = createProviderApiClient();
    const otherKey: NativeTaskKey = { ...KEY, nativeTaskId: "unrelated-task" };
    const otherTask: NativeTask = { ...TASK, key: otherKey };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("task response dropped"))
      .mockResolvedValueOnce(json({ taskKey: otherKey, turnId: "other-turn" }, 202))
      .mockRejectedValueOnce(new Error("start response dropped"))
      .mockResolvedValueOnce(json({ ...otherTask, key: { ...otherKey, home: "/Users/other/.codex" } }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.send(KEY, { text: "uncertain" })).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
    });
    await expect(client.send(otherKey, { text: "unrelated" })).resolves.toEqual({
      taskKey: otherKey,
      turnId: "other-turn",
    });
    await expect(client.start("openai", { home: KEY.home, cwd: "/workspace" }))
      .rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
    await expect(client.start("openai", { home: "/Users/other/.codex", cwd: "/workspace" }))
      .resolves.toMatchObject({ outcome: "created" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps older-page lists and shallow reads from clearing uncertainty", async () => {
    const startClient = createProviderApiClient();
    const taskClient = createProviderApiClient();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("start response dropped"))
      .mockResolvedValueOnce(json({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(json({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(json(TASK, 201))
      .mockRejectedValueOnce(new Error("send response dropped"))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ taskKey: KEY, turnId: "after-deep-read" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const startInput = { home: KEY.home, cwd: "/workspace" };
    await expect(startClient.start("openai", startInput)).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
    });
    await startClient.list({ provider: "openai", home: KEY.home, cursor: "older-page" });
    await expect(startClient.start("openai", startInput)).rejects.toBeInstanceOf(
      ProviderReconciliationRequiredError,
    );
    await startClient.list({ provider: "openai", home: KEY.home });
    await expect(startClient.start("openai", startInput)).rejects.toMatchObject({
      canAcknowledge: true,
    });
    await startClient.acknowledgeReconciliation({
      scope: "provider-home",
      provider: "openai",
      home: KEY.home,
    });
    await expect(startClient.start("openai", startInput)).resolves.toMatchObject({
      outcome: "created",
    });

    await expect(taskClient.send(KEY, { text: "uncertain" })).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
    });
    await taskClient.read(KEY, false);
    await expect(taskClient.send(KEY, { text: "still blocked" })).rejects.toBeInstanceOf(
      ProviderReconciliationRequiredError,
    );
    await taskClient.read(KEY, true);
    await expect(taskClient.send(KEY, { text: "must review" })).rejects.toMatchObject({
      canAcknowledge: true,
    });
    await taskClient.acknowledgeReconciliation({
      scope: "task",
      key: KEY,
      fingerprint: FINGERPRINT,
    });
    await expect(taskClient.send(KEY, { text: "reconciled" })).resolves.toMatchObject({
      turnId: "after-deep-read",
    });
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it("keeps partial-start tasks policy-frozen until a verified resume succeeds", async () => {
    const client = createProviderApiClient();
    const createdKey = { ...KEY, nativeTaskId: "partial-start-task" };
    const createdTask = { ...TASK, key: createdKey };
    const partial = {
      outcome: "partial",
      code: "PARTIAL_START",
      provider: "openai",
      task: createdTask,
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(partial, 201))
      .mockResolvedValueOnce(json(createdTask))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json(createdTask))
      .mockResolvedValueOnce(json({ taskKey: createdKey, turnId: "safe-turn" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.start("openai", { home: KEY.home, cwd: "/workspace" }))
      .resolves.toEqual(partial);
    await expect(client.send(createdKey, { text: "blocked" })).rejects.toBeInstanceOf(
      ProviderReconciliationRequiredError,
    );
    await client.read(createdKey, true);
    await expect(client.send(createdKey, { text: "read still needs explicit review" })).rejects
      .toMatchObject({ scope: "task", canAcknowledge: true });
    await client.acknowledgeReconciliation({
      scope: "task",
      key: createdKey,
      fingerprint: FINGERPRINT,
    });
    await expect(client.send(createdKey, { text: "review is not a policy probe" })).rejects
      .toMatchObject({ scope: "task-policy" });
    await client.resume(createdKey, { permissionMode: "read-only" });
    await expect(client.send(createdKey, { text: "safe" })).resolves.toMatchObject({
      turnId: "safe-turn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("keeps partial-fork tasks policy-frozen until a verified resume succeeds", async () => {
    const client = createProviderApiClient();
    const forkedKey = { ...KEY, nativeTaskId: "partial-fork-task" };
    const forkedTask = { ...TASK, key: forkedKey };
    const partial = {
      outcome: "partial",
      code: "PARTIAL_FORK",
      provider: "openai",
      task: forkedTask,
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(partial, 201))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json(forkedTask))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json(forkedTask))
      .mockResolvedValueOnce(json({ taskKey: forkedKey, turnId: "safe-fork-turn" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.fork(KEY)).resolves.toEqual(partial);
    await expect(client.send(KEY, { text: "source blocked" })).rejects.toMatchObject({
      scope: "task",
    });
    await client.read(KEY, true);
    await client.acknowledgeReconciliation({
      scope: "task",
      key: KEY,
      fingerprint: FINGERPRINT,
    });
    await expect(client.send(forkedKey, { text: "blocked" })).rejects.toBeInstanceOf(
      ProviderReconciliationRequiredError,
    );
    await client.read(forkedKey, true);
    await client.acknowledgeReconciliation({
      scope: "task",
      key: forkedKey,
      fingerprint: FINGERPRINT,
    });
    await expect(client.send(forkedKey, { text: "still policy-frozen" })).rejects
      .toMatchObject({ scope: "task-policy" });
    await client.resume(forkedKey, { permissionMode: "read-only" });
    await expect(client.send(forkedKey, { text: "safe" })).resolves.toMatchObject({
      turnId: "safe-fork-turn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("keeps policy-mismatch tasks frozen through reads until verified resume", async () => {
    const client = createProviderApiClient();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({
        error: "provider_policy_mismatch",
        code: "POLICY_MISMATCH",
        provider: "openai",
      }, 409))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(json({ taskKey: KEY, turnId: "after-policy-repair" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.resume(KEY)).rejects.toMatchObject({
      name: "ProviderHttpError",
      code: "POLICY_MISMATCH",
    });
    await expect(client.send(KEY, { text: "blocked" })).rejects.toMatchObject({
      scope: "task-policy",
    });
    await client.read(KEY, true);
    await expect(client.send(KEY, { text: "read cannot prove policy" })).rejects.toMatchObject({
      scope: "task-policy",
    });
    await expect(client.resume(KEY, { permissionMode: "read-only" })).resolves.toEqual(TASK);
    await expect(client.send(KEY, { text: "verified" })).resolves.toMatchObject({
      turnId: "after-policy-repair",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps uncertain resume policy-frozen after state reconciliation", async () => {
    const client = createProviderApiClient();
    const malformedResume = { ...TASK, key: { ...KEY, nativeTaskId: "wrong-task" } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(malformedResume))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(json({ taskKey: KEY, turnId: "after-resume-repair" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.resume(KEY)).rejects.toBeInstanceOf(ProviderMutationUncertainError);
    await client.read(KEY, true);
    await expect(client.send(KEY, { text: "state review required first" })).rejects.toMatchObject({
      scope: "task",
      canAcknowledge: true,
    });
    await client.acknowledgeReconciliation({
      scope: "task",
      key: KEY,
      fingerprint: FINGERPRINT,
    });
    await expect(client.send(KEY, { text: "policy still unverified" })).rejects.toMatchObject({
      scope: "task-policy",
    });
    await client.resume(KEY, { permissionMode: "read-only" });
    await expect(client.send(KEY, { text: "safe now" })).resolves.toMatchObject({
      turnId: "after-resume-repair",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("requires home reconciliation after an uncertain fork may create an unknown child", async () => {
    const client = createProviderApiClient();
    const forkedTask = { ...TASK, key: { ...KEY, nativeTaskId: "known-after-list" } };
    const forkedSummary = { ...TASK_SUMMARY, key: forkedTask.key };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("child may have been created"))
      .mockResolvedValueOnce(json(TASK))
      .mockResolvedValueOnce(json({ items: [forkedSummary], nextCursor: null }))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json(forkedTask, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.fork(KEY)).rejects.toBeInstanceOf(ProviderMutationUncertainError);
    await client.read(KEY, true);
    await expect(client.fork(KEY)).rejects.toMatchObject({ scope: "provider-home" });
    await client.list({ provider: "openai", home: KEY.home });
    await expect(client.fork(KEY)).rejects.toMatchObject({
      scope: "provider-home",
      canAcknowledge: true,
    });
    await client.acknowledgeReconciliation({
      scope: "provider-home",
      provider: "openai",
      home: KEY.home,
    });
    await expect(client.fork(KEY)).rejects.toMatchObject({
      scope: "task",
      canAcknowledge: true,
    });
    await client.acknowledgeReconciliation({
      scope: "task",
      key: KEY,
      fingerprint: FINGERPRINT,
    });
    await expect(client.fork(KEY)).resolves.toEqual({ outcome: "created", task: forkedTask });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("fails closed at uncertainty capacity without evicting the oldest task", async () => {
    const client = createProviderApiClient();
    const fetchMock = vi.fn().mockRejectedValue(new Error("response dropped"));
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index < 512; index += 1) {
      const key = { ...KEY, nativeTaskId: `uncertain-${index}` };
      await expect(client.send(key, { text: "once" })).rejects.toBeInstanceOf(
        ProviderMutationUncertainError,
      );
    }
    await expect(client.send(
      { ...KEY, nativeTaskId: "over-capacity" },
      { text: "must not dispatch" },
    )).rejects.toBeInstanceOf(ProviderReconciliationRequiredError);
    await expect(client.send(
      { ...KEY, nativeTaskId: "uncertain-0" },
      { text: "oldest stays blocked" },
    )).rejects.toBeInstanceOf(ProviderReconciliationRequiredError);
    expect(fetchMock).toHaveBeenCalledTimes(512);
  });
});

describe("providerApi bounded REST JSON", () => {
  const encoder = new TextEncoder();

  it("prechecks Content-Length and cancels oversized success bodies", async () => {
    const response = bytesResponse([encoder.encode("[]")], {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(300_000),
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response.response));

    await expect(providerApi.providers()).rejects.toMatchObject({
      name: "ProviderProtocolError",
      code: "RESPONSE_TOO_LARGE",
    });
    expect(response.cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds incrementally streamed success bodies without Content-Length", async () => {
    const response = bytesResponse([
      new Uint8Array(200_000).fill(0x20),
      new Uint8Array(100_000).fill(0x20),
    ], {
      status: 200,
      headers: { "content-type": "application/json" },
    }, false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response.response));

    await expect(providerApi.providers()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(response.cancel).toHaveBeenCalledTimes(1);
  });

  it("streams one-byte JSON chunks within the endpoint cap", async () => {
    const payload = JSON.stringify([{
      provider: "openai",
      home: KEY.home,
      status: "available",
      capabilities: CAPABILITIES,
    }]);
    const response = bytesResponse(
      [...encoder.encode(payload)].map((byte) => Uint8Array.of(byte)),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response.response));

    await expect(providerApi.providers()).resolves.toHaveLength(1);
  });

  it("bounds error JSON and never reflects its body or endpoint path", async () => {
    const response = bytesResponse([encoder.encode(JSON.stringify({
      code: "SK_LIVE_ARBITRARY_SECRET",
      error: `/Users/private/${"x".repeat(40_000)}`,
    }))], {
      status: 409,
      headers: {
        "content-type": "application/json",
        "content-length": String(50_000),
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response.response));

    const failure = providerApi.read(KEY);
    await expect(failure).rejects.toMatchObject({ code: null, status: 409 });
    await expect(failure).rejects.not.toThrow("/Users/private");
    await expect(failure).rejects.not.toThrow(KEY.home);
    expect(response.cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects media types that merely contain the JSON token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-type": "text/application/json-evil" },
    })));

    await expect(providerApi.providers()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("providerApi streamed SSE subscription", () => {
  const encoder = new TextEncoder();
  const event: ProviderEvent = {
    type: "message-delta",
    provider: "openai",
    key: KEY,
    occurredAt: "2026-07-13T02:00:00.000Z",
    role: "assistant",
    delta: "streamed text",
    turnId: "turn-2",
    itemId: "item-3",
  };

  it("rejects media types that merely contain the event-stream token", async () => {
    const response = bytesResponse([], {
      status: 200,
      headers: { "content-type": "application/text/event-stream-evil" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response.response));

    await expect(providerApi.subscribe(KEY, vi.fn())).rejects.toMatchObject({
      code: "SSE_CONTENT_TYPE",
    });
  });

  it("uses fetch Authorization and incrementally parses validated SSE frames", async () => {
    const stream = controlledStream();
    const fetchMock = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    const sink = vi.fn();

    const subscription = await providerApi.subscribe(KEY, sink);
    const raw = `: connected\r\n\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
    stream.controller.enqueue(encoder.encode(raw.slice(0, 19)));
    stream.controller.enqueue(encoder.encode(raw.slice(19, 73)));
    stream.controller.enqueue(encoder.encode(raw.slice(73)));
    await vi.waitFor(() => expect(sink).toHaveBeenCalledWith(event));

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(
      "/api/providers/openai/tasks/task%2Fwith%20spaces/events?home=%2FUsers%2Ftest%2F.codex+home",
    );
    expect(url).not.toContain("token=");
    expect(url).not.toContain(ACCESS_TOKEN);
    expect(init.headers).toEqual({
      accept: "text/event-stream",
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    expect(init.signal).toBe(subscription.signal);

    await subscription.unsubscribe();
    await subscription.unsubscribe();
    await expect(subscription.closed).resolves.toBeUndefined();
    expect(subscription.signal.aborted).toBe(true);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it("parses a complete event delivered deterministically one byte at a time", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const sink = vi.fn();
    const subscription = await providerApi.subscribe(KEY, sink);
    const raw = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

    for (const byte of raw) stream.controller.enqueue(Uint8Array.of(byte));
    stream.controller.close();

    await expect(subscription.closed).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("joins multi-line data fields without retaining per-line copies", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const sink = vi.fn();
    const subscription = await providerApi.subscribe(KEY, sink);
    const payload = JSON.stringify(event);
    const split = payload.indexOf(",") + 1;

    stream.controller.enqueue(encoder.encode(
      `data: ${payload.slice(0, split)}\ndata: ${payload.slice(split)}\n\n`,
    ));
    stream.controller.close();

    await expect(subscription.closed).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("caps dense frame work per turn while preserving deterministic order", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const seen: string[] = [];
    const subscription = await providerApi.subscribe(KEY, (next) => {
      if (next.type === "status" && next.nativeId) seen.push(next.nativeId);
    });
    const frames = Array.from({ length: 130 }, (_, index) => `data: ${JSON.stringify({
      type: "status",
      provider: "openai",
      key: KEY,
      occurredAt: "2026-07-13T02:00:00.000Z",
      scope: "item",
      status: "running",
      nativeId: `item-${index}`,
    })}\n\n`).join("");

    stream.controller.enqueue(encoder.encode(frames));
    stream.controller.close();

    await expect(subscription.closed).resolves.toBeUndefined();
    expect(seen).toEqual(Array.from({ length: 130 }, (_, index) => `item-${index}`));
    expect(timeout.mock.calls.filter(([, delay]) => delay === 0).length).toBeGreaterThanOrEqual(2);
  });

  it("yields for dense comment-only frames that contain no dispatchable events", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const sink = vi.fn();
    const subscription = await providerApi.subscribe(KEY, sink);
    const frames = `${": keepalive\n\n".repeat(130)}data: ${JSON.stringify(event)}\n\n`;

    stream.controller.enqueue(encoder.encode(frames));
    stream.controller.close();

    await expect(subscription.closed).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledOnce();
    expect(timeout.mock.calls.filter(([, delay]) => delay === 0).length).toBeGreaterThanOrEqual(2);
  });

  it("fails closed on malformed JSON or an event that does not own the subscribed task", async () => {
    for (const payload of [
      "{not-json",
      JSON.stringify({ ...event, key: { ...KEY, nativeTaskId: "another-task" } }),
      JSON.stringify({
        type: "status",
        provider: "openai",
        key: KEY,
        occurredAt: "2026-07-13T02:00:00.000Z",
        scope: "task",
        status: "active",
        nativeId: "another-task",
      }),
    ]) {
      const stream = controlledStream();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
      const sink = vi.fn();
      const onError = vi.fn();
      const subscription = await providerApi.subscribe(KEY, sink, { onError });
      const closed = expect(subscription.closed).rejects.toBeInstanceOf(ProviderStreamError);

      stream.controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      await closed;
      expect(sink).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(subscription.signal.aborted).toBe(true);
    }
  });

  it("bounds unterminated SSE data instead of retaining attacker-controlled input", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const subscription = await providerApi.subscribe(KEY, vi.fn());
    const closed = expect(subscription.closed).rejects.toMatchObject({
      code: "SSE_BUFFER_LIMIT",
    });

    stream.controller.enqueue(encoder.encode(`data: ${"x".repeat(600_000)}`));
    await closed;
    expect(subscription.signal.aborted).toBe(true);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it("treats an external abort as clean unsubscribe without surfacing an error", async () => {
    const stream = controlledStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const external = new AbortController();
    const addListener = vi.spyOn(external.signal, "addEventListener");
    const removeListener = vi.spyOn(external.signal, "removeEventListener");
    const onError = vi.fn();
    const subscription = await providerApi.subscribe(KEY, vi.fn(), {
      signal: external.signal,
      onError,
    });

    external.abort();
    await expect(subscription.closed).resolves.toBeUndefined();
    expect(subscription.signal.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    const abortCallbacks = addListener.mock.calls
      .filter(([type]) => type === "abort")
      .map(([, callback]) => callback);
    const removedAbortCallbacks = removeListener.mock.calls
      .filter(([type]) => type === "abort")
      .map(([, callback]) => callback);
    expect(abortCallbacks.length).toBeGreaterThan(0);
    expect(abortCallbacks.every((callback) => removedAbortCallbacks.includes(callback))).toBe(true);
  });

  it("classifies a pre-response network failure without leaking transport details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket secret detail")));

    await expect(providerApi.subscribe(KEY, vi.fn())).rejects.toMatchObject({
      name: "ProviderStreamError",
      code: "SSE_READ_FAILED",
      message: "Provider stream request failed",
    });
  });
});
