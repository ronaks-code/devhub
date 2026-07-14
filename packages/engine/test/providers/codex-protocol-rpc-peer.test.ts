import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_DEFAULT_MAX_CLIENT_REQUESTS,
  CODEX_DEFAULT_MAX_SERVER_REQUESTS,
  CODEX_MAX_SETTLED_SERVER_REQUESTS,
  CodexProtocolFault,
  CodexRpcPeer,
  type CodexRpcRequest,
} from "../../src/providers/codex/protocol/index.js";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

const requestIdentity = {
  itemId: "item-1",
  threadId: "thread-1",
  turnId: "turn-1",
};

const commandApprovalParams = () => ({ ...requestIdentity, startedAtMs: 1 });
const fileApprovalParams = () => ({ ...requestIdentity, startedAtMs: 1 });
const permissionsApprovalParams = () => ({
  ...requestIdentity,
  cwd: "/tmp",
  permissions: {},
  startedAtMs: 1,
});
const userInputParams = () => ({ ...requestIdentity, questions: [] });
const elicitationParams = () => ({
  message: "Choose",
  mode: "form",
  requestedSchema: { properties: {}, type: "object" },
  serverName: "example",
  threadId: "thread-1",
});

const recordingTransport = () => {
  const writes: unknown[] = [];
  const write = vi.fn(async (chunk: Uint8Array) => {
    writes.push(JSON.parse(Buffer.from(chunk).toString("utf8")));
  });
  return { write, writes };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex RPC peer client calls", () => {
  it("uses monotonic safe-integer ids and correlates notification-before-response in wire order", async () => {
    const transport = recordingTransport();
    const order: string[] = [];
    const peer = new CodexRpcPeer({
      write: transport.write,
      onNotification: (notification) => {
        order.push(notification.method);
      },
    });

    const first = peer.call("thread/list", {}).then((result) => {
      order.push("first-response");
      return result;
    });
    const second = peer.call("thread/archive", { threadId: "thread-1" });
    await peer.outboundIdle();
    expect(transport.writes).toEqual([
      { id: 1, method: "thread/list", params: {} },
      { id: 2, method: "thread/archive", params: { threadId: "thread-1" } },
    ]);

    await peer.receive(
      jsonLine({ method: "thread/archived", params: { threadId: "thread-1" } }) +
      jsonLine({ id: 1, result: { data: [] } }) +
      jsonLine({ id: 2, result: {} }),
    );
    await expect(first).resolves.toEqual({ data: [] });
    await expect(second).resolves.toEqual({});
    expect(order).toEqual(["thread/archived", "first-response"]);
  });

  it("keeps numeric and string response ids exact instead of coercing them", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({ write: transport.write });
    const pending = peer.call("thread/list", {});
    void pending.catch(() => undefined);
    await peer.outboundIdle();

    await expect(peer.receive(jsonLine({ id: "1", result: {} }))).rejects.toMatchObject({
      code: "UNKNOWN_RESPONSE",
    });
    await expect(pending).rejects.toBeInstanceOf(CodexProtocolFault);
  });

  it("treats duplicate and never-issued responses as distinct protocol faults", async () => {
    const firstTransport = recordingTransport();
    const duplicateFaults: CodexProtocolFault[] = [];
    const duplicatePeer = new CodexRpcPeer({
      write: firstTransport.write,
      onProtocolFault: (fault) => duplicateFaults.push(fault),
    });
    const call = duplicatePeer.call("thread/list", {});
    await duplicatePeer.outboundIdle();
    await duplicatePeer.receive(jsonLine({ id: 1, result: { data: [] } }));
    await call;

    await expect(duplicatePeer.receive(jsonLine({ id: 1, result: {} }))).rejects.toMatchObject({
      code: "DUPLICATE_RESPONSE",
    });
    expect(duplicateFaults).toHaveLength(1);

    const secondTransport = recordingTransport();
    const unknownPeer = new CodexRpcPeer({ write: secondTransport.write });
    await expect(unknownPeer.receive(jsonLine({ id: 99, result: {} }))).rejects.toMatchObject({
      code: "UNKNOWN_RESPONSE",
    });
  });

  it("bounds pending calls at 512 by default and rejects every pending call on close", async () => {
    expect(CODEX_DEFAULT_MAX_CLIENT_REQUESTS).toBe(512);
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({
      write: transport.write,
      maxPendingClientRequests: 1,
    });
    const accepted = peer.call("thread/list", {});
    void accepted.catch(() => undefined);

    await expect(peer.call("thread/read", { threadId: "thread-1" })).rejects.toMatchObject({
      code: "REQUEST_LIMIT",
    });
    peer.close();
    await expect(accepted).rejects.toMatchObject({ code: "PEER_CLOSED" });
  });

  it("reports unknown notifications through a diagnostic hook without hiding known notifications", async () => {
    const transport = recordingTransport();
    const known = vi.fn();
    const unknown = vi.fn();
    const peer = new CodexRpcPeer({
      write: transport.write,
      onNotification: known,
      onUnknownNotification: unknown,
    });

    await peer.receive(
      jsonLine({ method: "thread/archived", params: { threadId: "thread-1" } }) +
      jsonLine({ method: "future/notification", params: { ignored: true } }),
    );

    expect(known).toHaveBeenCalledOnce();
    expect(known.mock.calls[0]?.[0]).toEqual({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    });
    expect(unknown).toHaveBeenCalledOnce();
    expect(unknown.mock.calls[0]?.[0]).toEqual({
      method: "future/notification",
      params: { ignored: true },
    });
  });

  it("rejects id exhaustion rather than wrapping or reusing an uncertain id", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({
      write: transport.write,
      initialRequestId: Number.MAX_SAFE_INTEGER,
    });
    const finalCall = peer.call("thread/list", {});
    void finalCall.catch(() => undefined);
    await peer.outboundIdle();
    expect(transport.writes[0]).toMatchObject({ id: Number.MAX_SAFE_INTEGER });

    await expect(peer.call("thread/read", { threadId: "thread-1" })).rejects.toMatchObject({
      code: "ID_EXHAUSTED",
    });
    peer.close();
  });

  it("fails a locally invalid request without leaking a pending correlation", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({ write: transport.write });

    await expect(peer.call("", {})).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
    expect(peer.pendingClientRequests).toBe(0);
    expect(peer.closed).toBe(false);
    expect(transport.write).not.toHaveBeenCalled();
  });
});

describe("Codex RPC peer server requests", () => {
  it("dispatches numeric and string request ids independently and responds exactly once", async () => {
    const transport = recordingTransport();
    const responses = [deferred<unknown>(), deferred<unknown>()];
    const requests: CodexRpcRequest[] = [];
    const peer = new CodexRpcPeer({
      write: transport.write,
      onServerRequest: async (request) => {
        requests.push(request);
        return responses[requests.length - 1]!.promise;
      },
    });

    await peer.receive(
      jsonLine({
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: commandApprovalParams(),
      }) +
      jsonLine({
        id: "1",
        method: "item/fileChange/requestApproval",
        params: fileApprovalParams(),
      }),
    );
    expect(requests.map(({ id }) => id)).toEqual([1, "1"]);
    expect(peer.activeServerRequests).toBe(2);

    responses[0]!.resolve({ decision: "accept" });
    responses[1]!.resolve({ decision: "decline" });
    await peer.idle();
    expect(transport.writes).toEqual([
      { id: 1, result: { decision: "accept" } },
      { id: "1", result: { decision: "decline" } },
    ]);
    expect(peer.activeServerRequests).toBe(0);
  });

  it("times out a handler fail-closed and ignores its late result", async () => {
    const transport = recordingTransport();
    const handler = deferred<unknown>();
    let fireTimeout!: () => void;
    const timerToken = { type: "test-timer" };
    const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) => {
      expect(delayMs).toBe(1000);
      fireTimeout = callback;
      return timerToken;
    });
    const clearTimeoutFn = vi.fn();
    const peer = new CodexRpcPeer({
      write: transport.write,
      serverRequestTimeoutMs: 1000,
      onServerRequest: () => handler.promise,
      setTimeoutFn,
      clearTimeoutFn,
    });

    await peer.receive(jsonLine({
      id: "approval-1",
      method: "item/permissions/requestApproval",
      params: permissionsApprovalParams(),
    }));
    expect(setTimeoutFn).toHaveBeenCalledOnce();
    fireTimeout();
    await peer.idle();
    expect(transport.writes).toEqual([{
      id: "approval-1",
      error: { code: -32_001, message: "Server request timed out" },
    }]);

    handler.resolve({ decision: "accept" });
    await Promise.resolve();
    await peer.outboundIdle();
    expect(transport.writes).toHaveLength(1);
    expect(clearTimeoutFn).toHaveBeenCalledWith(timerToken);
  });

  it("aborts active handlers and clears their timers when the peer closes", async () => {
    const transport = recordingTransport();
    const timerToken = { type: "test-timer" };
    const clearTimeoutFn = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const peer = new CodexRpcPeer({
      write: transport.write,
      setTimeoutFn: () => timerToken,
      clearTimeoutFn,
      onServerRequest: (_request, { signal }) => {
        observedSignal = signal;
        return new Promise(() => undefined);
      },
    });

    await peer.receive(jsonLine({
      id: "approval-close",
      method: "item/permissions/requestApproval",
      params: permissionsApprovalParams(),
    }));
    expect(observedSignal?.aborted).toBe(false);

    peer.close();
    await peer.idle();
    expect(observedSignal?.aborted).toBe(true);
    expect(clearTimeoutFn).toHaveBeenCalledWith(timerToken);
    expect(transport.writes).toEqual([]);
  });

  it("clears an injected timer even when its opaque handle is undefined", async () => {
    const transport = recordingTransport();
    const clearTimeoutFn = vi.fn();
    const peer = new CodexRpcPeer({
      write: transport.write,
      setTimeoutFn: () => undefined,
      clearTimeoutFn,
      onServerRequest: () => new Promise(() => undefined),
    });

    await peer.receive(jsonLine({
      id: "undefined-timer",
      method: "item/fileChange/requestApproval",
      params: fileApprovalParams(),
    }));
    peer.close();
    await peer.idle();

    expect(clearTimeoutFn).toHaveBeenCalledWith(undefined);
  });

  it("caps concurrent server requests at 512 by default and fails excess work closed", async () => {
    expect(CODEX_DEFAULT_MAX_SERVER_REQUESTS).toBe(512);
    const transport = recordingTransport();
    const first = deferred<unknown>();
    const onServerRequest = vi.fn(() => first.promise);
    const peer = new CodexRpcPeer({
      write: transport.write,
      maxConcurrentServerRequests: 1,
      onServerRequest,
    });

    await peer.receive(
      jsonLine({ id: 1, method: "item/tool/requestUserInput", params: userInputParams() }) +
      jsonLine({ id: 2, method: "mcpServer/elicitation/request", params: elicitationParams() }),
    );
    await peer.outboundIdle();
    expect(onServerRequest).toHaveBeenCalledOnce();
    expect(transport.writes).toEqual([{
      id: 2,
      error: { code: -32_002, message: "Too many concurrent server requests" },
    }]);

    first.resolve({ answers: {} });
    await peer.idle();
    expect(transport.writes).toHaveLength(2);
  });

  it("fails handler errors closed without leaking backend error details", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({
      write: transport.write,
      onServerRequest: async () => {
        throw new Error("secret backend detail");
      },
    });

    await peer.receive(jsonLine({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: commandApprovalParams(),
    }));
    await peer.idle();
    expect(transport.writes).toEqual([{
      id: 1,
      error: { code: -32_003, message: "Server request handler failed" },
    }]);
    expect(JSON.stringify(transport.writes)).not.toContain("secret backend detail");
  });

  it.each([41, "41"])(
    "faults an identical %s server request id replay after a successful response",
    async (id) => {
      const transport = recordingTransport();
      const onServerRequest = vi.fn(async () => ({ decision: "accept" }));
      const peer = new CodexRpcPeer({ write: transport.write, onServerRequest });
      const request = {
        id,
        method: "item/commandExecution/requestApproval",
        params: commandApprovalParams(),
      };

      await peer.receive(jsonLine(request));
      await peer.idle();
      await expect(peer.receive(jsonLine(request))).rejects.toMatchObject({
        code: "DUPLICATE_SERVER_REQUEST",
      });

      expect(onServerRequest).toHaveBeenCalledOnce();
      expect(transport.writes).toEqual([{ id, result: { decision: "accept" } }]);
    },
  );

  it("keeps completed numeric and string server request ids distinct", async () => {
    const transport = recordingTransport();
    const onServerRequest = vi.fn(async () => ({ decision: "accept" }));
    const peer = new CodexRpcPeer({ write: transport.write, onServerRequest });

    await peer.receive(jsonLine({
      id: 7,
      method: "item/fileChange/requestApproval",
      params: fileApprovalParams(),
    }));
    await peer.idle();
    await peer.receive(jsonLine({
      id: "7",
      method: "item/fileChange/requestApproval",
      params: fileApprovalParams(),
    }));
    await peer.idle();

    expect(onServerRequest).toHaveBeenCalledTimes(2);
    expect(transport.writes.map((response) => (response as { id: unknown }).id)).toEqual([7, "7"]);
  });

  it("faults replay after a timeout response without scheduling a second handler", async () => {
    const transport = recordingTransport();
    const timers: Array<() => void> = [];
    const onServerRequest = vi.fn(() => new Promise(() => undefined));
    const peer = new CodexRpcPeer({
      write: transport.write,
      onServerRequest,
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeoutFn: () => undefined,
    });
    const request = {
      id: "timeout-replay",
      method: "item/permissions/requestApproval",
      params: permissionsApprovalParams(),
    };

    await peer.receive(jsonLine(request));
    timers[0]!();
    await peer.idle();
    await expect(peer.receive(jsonLine(request))).rejects.toMatchObject({
      code: "DUPLICATE_SERVER_REQUEST",
    });

    expect(onServerRequest).toHaveBeenCalledOnce();
    expect(timers).toHaveLength(1);
    expect(transport.writes).toHaveLength(1);
  });

  it("faults replay after a handler-rejection response", async () => {
    const transport = recordingTransport();
    const onServerRequest = vi.fn(async () => {
      throw new Error("denied");
    });
    const peer = new CodexRpcPeer({ write: transport.write, onServerRequest });
    const request = {
      id: "rejected-replay",
      method: "item/tool/requestUserInput",
      params: userInputParams(),
    };

    await peer.receive(jsonLine(request));
    await peer.idle();
    await expect(peer.receive(jsonLine(request))).rejects.toMatchObject({
      code: "DUPLICATE_SERVER_REQUEST",
    });

    expect(onServerRequest).toHaveBeenCalledOnce();
    expect(transport.writes).toHaveLength(1);
  });

  it("faults replay after an unsupported-method response", async () => {
    const transport = recordingTransport();
    const onServerRequest = vi.fn();
    const peer = new CodexRpcPeer({ write: transport.write, onServerRequest });
    const request = { id: 88, method: "experimental/tool/request", params: {} };

    await peer.receive(jsonLine(request));
    await peer.idle();
    await expect(peer.receive(jsonLine(request))).rejects.toMatchObject({
      code: "DUPLICATE_SERVER_REQUEST",
    });

    expect(onServerRequest).not.toHaveBeenCalled();
    expect(transport.writes).toHaveLength(1);
  });

  it("faults replay after a concurrent-limit response", async () => {
    const transport = recordingTransport();
    const active = deferred<unknown>();
    const onServerRequest = vi.fn(() => active.promise);
    const peer = new CodexRpcPeer({
      write: transport.write,
      maxConcurrentServerRequests: 1,
      onServerRequest,
    });
    const limitedRequest = {
      id: "limited-replay",
      method: "mcpServer/elicitation/request",
      params: elicitationParams(),
    };

    await peer.receive(jsonLine({
      id: "active",
      method: "item/tool/requestUserInput",
      params: userInputParams(),
    }) + jsonLine(limitedRequest));
    await peer.outboundIdle();
    await expect(peer.receive(jsonLine(limitedRequest))).rejects.toMatchObject({
      code: "DUPLICATE_SERVER_REQUEST",
    });
    await peer.idle();

    expect(onServerRequest).toHaveBeenCalledOnce();
    expect(transport.writes).toHaveLength(1);
  });

  it("fails closed at the completed server request history bound and only records decisive writes", async () => {
    expect(CODEX_MAX_SETTLED_SERVER_REQUESTS).toBe(4096);
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({
      write: transport.write,
      maxSettledServerRequests: 2,
    });
    for (const id of [1, 2]) {
      await peer.receive(jsonLine({ id, method: "unsupported/request", params: {} }));
      await peer.idle();
    }
    expect(peer.settledServerRequests).toBe(2);

    await expect(peer.receive(jsonLine({
      id: 3,
      method: "unsupported/request",
      params: {},
    }))).rejects.toMatchObject({ code: "REQUEST_LIMIT" });
    expect(peer.closed).toBe(true);
    expect(peer.settledServerRequests).toBe(2);
    expect(transport.writes).toHaveLength(2);

    const writeFailure = new Error("response pipe failed");
    const failedPeer = new CodexRpcPeer({
      write: async () => {
        throw writeFailure;
      },
      onServerRequest: async () => ({ decision: "accept" }),
    });
    await failedPeer.receive(jsonLine({
      id: "failed-write",
      method: "item/commandExecution/requestApproval",
      params: commandApprovalParams(),
    }));
    await failedPeer.idle();
    expect(failedPeer.closed).toBe(true);
    expect(failedPeer.settledServerRequests).toBe(0);
  });
});

describe("Codex RPC peer flow control and failure closure", () => {
  it("connects ingress pause/resume callbacks to the configured queue watermarks", async () => {
    const transport = recordingTransport();
    const releaseFirst = deferred();
    const events: string[] = [];
    let handled = 0;
    const peer = new CodexRpcPeer({
      write: transport.write,
      ingressLimits: {
        maxItems: 4,
        maxBytes: 10_000,
        pauseItems: 2,
        pauseBytes: 9000,
        resumeItems: 1,
        resumeBytes: 8000,
      },
      pauseIngress: () => events.push("pause"),
      resumeIngress: () => events.push("resume"),
      onNotification: async () => {
        handled += 1;
        if (handled === 1) await releaseFirst.promise;
      },
    });

    const receiving = peer.receive(
      jsonLine({ method: "thread/archived", params: { threadId: "thread-1" } }) +
      jsonLine({ method: "thread/archived", params: { threadId: "thread-2" } }) +
      jsonLine({ method: "thread/archived", params: { threadId: "thread-3" } }),
    );
    await Promise.resolve();
    expect(events).toEqual(["pause"]);

    releaseFirst.resolve();
    await receiving;
    expect(events).toEqual(["pause", "resume"]);
    expect(handled).toBe(3);
  });

  it("faults before dispatch when one chunk exceeds the bounded ingress queue", async () => {
    const transport = recordingTransport();
    const onNotification = vi.fn();
    const peer = new CodexRpcPeer({
      write: transport.write,
      ingressLimits: {
        maxItems: 2,
        maxBytes: 10_000,
        pauseItems: 2,
        pauseBytes: 9000,
        resumeItems: 1,
        resumeBytes: 8000,
      },
      onNotification,
    });

    await expect(peer.receive(
      jsonLine({ method: "thread/started" }) +
      jsonLine({ method: "turn/started" }) +
      jsonLine({ method: "item/started" }),
    )).rejects.toMatchObject({ code: "QUEUE_OVERFLOW" });
    expect(onNotification).not.toHaveBeenCalled();
    expect(peer.closed).toBe(true);
  });

  it("never retries a transport write whose outcome is uncertain", async () => {
    const failure = new Error("partial pipe write");
    const write = vi.fn(async () => {
      throw failure;
    });
    const peer = new CodexRpcPeer({ write });

    const turnStartParams = { input: [], threadId: "thread-1" };
    await expect(peer.call("turn/start", turnStartParams)).rejects.toBe(failure);
    await expect(peer.call("turn/start", turnStartParams)).rejects.toThrow(/closed/i);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("faults a truncated stdout frame at EOF and rejects pending calls", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({ write: transport.write });
    const pending = peer.call("thread/list", {});
    void pending.catch(() => undefined);
    await peer.outboundIdle();

    await peer.receive('{"id":1,"result":{"data":[]');
    await expect(peer.finishIngress()).rejects.toMatchObject({ code: "TRUNCATED_FRAME" });
    await expect(pending).rejects.toMatchObject({ code: "PEER_CLOSED" });
    expect(peer.closed).toBe(true);
    await expect(peer.finishIngress()).resolves.toBeUndefined();
  });

  it("cleanly finalizes stdout as a terminal boundary and rejects all later work", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({ write: transport.write });
    const pending = peer.call("thread/list", {});
    void pending.catch(() => undefined);
    await peer.outboundIdle();
    const writesAtEof = transport.writes.length;

    await peer.receive(jsonLine({ method: "future/notification", params: {} }));
    await expect(peer.finishIngress()).resolves.toBeUndefined();
    await expect(peer.finishIngress()).resolves.toBeUndefined();
    await expect(pending).rejects.toMatchObject({ code: "PEER_CLOSED" });
    expect(peer.closed).toBe(true);
    expect(peer.pendingClientRequests).toBe(0);

    await expect(peer.call("thread/list", {})).rejects.toMatchObject({ code: "PEER_CLOSED" });
    await expect(peer.notify("initialized")).rejects.toMatchObject({ code: "PEER_CLOSED" });
    await expect(peer.receive(jsonLine({ method: "future/notification" }))).rejects.toMatchObject({
      code: "PEER_CLOSED",
    });
    expect(transport.writes).toHaveLength(writesAtEof);
  });

  it("treats ingress finalization after an already-closed peer as an idempotent no-op", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({ write: transport.write });
    peer.close();

    await expect(peer.finishIngress()).resolves.toBeUndefined();
  });
});
