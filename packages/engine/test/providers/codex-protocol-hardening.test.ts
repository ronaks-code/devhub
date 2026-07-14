import { describe, expect, it, vi } from "vitest";
import {
  CODEX_DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  CODEX_DEFAULT_MAX_LINE_BYTES,
  CODEX_DEFAULT_NOTIFICATION_TIMEOUT_MS,
  BoundedCodexJsonlWriter,
  CodexProtocolFault,
  CodexRpcPeer,
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

const commandParams = (command = "echo safe") => ({
  command,
  itemId: "item-1",
  startedAtMs: 1,
  threadId: "thread-1",
  turnId: "turn-1",
});

const recordingTransport = () => {
  const writes: unknown[] = [];
  const write = vi.fn(async (chunk: Uint8Array) => {
    writes.push(JSON.parse(Buffer.from(chunk).toString("utf8")));
  });
  return { write, writes };
};

describe("Codex RPC peer fail-closed replay and EOF boundaries", () => {
  it("never evicts a settled server id and fails closed before a unique request exceeds the cap", async () => {
    const transport = recordingTransport();
    const onServerRequest = vi.fn(async () => ({ decision: "accept" }));
    const peer = new CodexRpcPeer({
      write: transport.write,
      maxSettledServerRequests: 2,
      onServerRequest,
    });

    for (const id of [1, "1"] as const) {
      await peer.receive(jsonLine({
        id,
        method: "item/commandExecution/requestApproval",
        params: commandParams(),
      }));
      await peer.idle();
    }

    await expect(peer.receive(jsonLine({
      id: 2,
      method: "item/commandExecution/requestApproval",
      params: commandParams(),
    }))).rejects.toMatchObject({ code: "REQUEST_LIMIT" });

    expect(peer.closed).toBe(true);
    expect(peer.settledServerRequests).toBe(2);
    expect(onServerRequest).toHaveBeenCalledTimes(2);
    expect(transport.writes).toHaveLength(2);
  });

  it("latches EOF synchronously so a blocked notification cannot admit a post-EOF mutation", async () => {
    const transport = recordingTransport();
    const notification = deferred();
    const peer = new CodexRpcPeer({
      write: transport.write,
      onNotification: () => notification.promise,
    });

    const receiving = peer.receive(jsonLine({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    }));
    await Promise.resolve();
    const finishing = peer.finishIngress();
    const lateCall = peer.call("turn/start", { input: [], threadId: "thread-1" });
    void lateCall.catch(() => undefined);
    const lateNotify = peer.notify("initialized");
    void lateNotify.catch(() => undefined);

    await Promise.resolve();
    expect(transport.write).not.toHaveBeenCalled();

    notification.resolve();
    await receiving;
    await finishing;
    await expect(lateCall).rejects.toMatchObject({ code: "PEER_CLOSED" });
    await expect(lateNotify).rejects.toMatchObject({ code: "PEER_CLOSED" });
  });

  it("drains every pre-EOF decoded notification and server request exactly once without writing", async () => {
    const transport = recordingTransport();
    const firstEntered = deferred();
    const notifications: Array<{ threadId: string; signal: AbortSignal }> = [];
    const requests: Array<{ id: string | number; signal: AbortSignal }> = [];
    const peer = new CodexRpcPeer({
      write: transport.write,
      onNotification: (notification, { signal }) => {
        const threadId = (notification.params as { threadId: string }).threadId;
        notifications.push({ threadId, signal });
        if (threadId === "thread-1") firstEntered.resolve();
        return new Promise(() => undefined);
      },
      onServerRequest: (request, { signal }) => {
        requests.push({ id: request.id, signal });
        return { decision: "accept" };
      },
    });

    const receiving = peer.receive(
      jsonLine({ method: "thread/archived", params: { threadId: "thread-1" } }) +
      jsonLine({ method: "thread/archived", params: { threadId: "thread-2" } }) +
      jsonLine({
        id: "approval-after-notifications",
        method: "item/commandExecution/requestApproval",
        params: commandParams(),
      }),
    );
    await firstEntered.promise;

    const finishing = peer.finishIngress();
    const lateCall = peer.call("turn/start", { input: [], threadId: "thread-1" });
    const lateNotify = peer.notify("initialized");
    void lateCall.catch(() => undefined);
    void lateNotify.catch(() => undefined);

    await expect(lateCall).rejects.toMatchObject({ code: "PEER_CLOSED" });
    await expect(lateNotify).rejects.toMatchObject({ code: "PEER_CLOSED" });
    await expect(peer.receive(jsonLine({ method: "future/notification" })))
      .rejects.toMatchObject({ code: "PEER_CLOSED" });
    await receiving;
    await finishing;

    expect(notifications.map(({ threadId }) => threadId)).toEqual(["thread-1", "thread-2"]);
    expect(notifications.every(({ signal }) => signal.aborted)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id: "approval-after-notifications" });
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(transport.write).not.toHaveBeenCalled();
    expect(peer.closed).toBe(true);
  });
});

describe("Codex outbound and retained ingress byte bounds", () => {
  it("accepts an encoded line exactly at its configured bound and rejects the next byte", async () => {
    const writes: Uint8Array[] = [];
    const maxLineBytes = 64;
    const writer = new BoundedCodexJsonlWriter(
      async (chunk) => {
        writes.push(chunk);
      },
      { maxItems: 2, maxBytes: 1024 },
      maxLineBytes,
    );
    const emptyLineBytes = Buffer.byteLength(JSON.stringify({ id: 1, result: "" }));
    const exactValue = "x".repeat(maxLineBytes - emptyLineBytes);

    await expect(writer.send({ id: 1, result: exactValue })).resolves.toBeUndefined();
    await expect(writer.send({ id: 2, result: `${exactValue}x` }))
      .rejects.toMatchObject({ code: "LINE_TOO_LARGE" });
    expect(Buffer.byteLength(Buffer.from(writes[0]!).toString("utf8").trimEnd())).toBe(
      maxLineBytes,
    );
    expect(writes).toHaveLength(1);
  });

  it("rejects a single encoded line beyond four MiB before writing", async () => {
    const write = vi.fn(async () => undefined);
    const writer = new BoundedCodexJsonlWriter(write, {
      maxItems: 2,
      maxBytes: 8 * 1024 * 1024,
    });

    await expect(writer.send({
      id: 1,
      result: { value: "x".repeat(CODEX_DEFAULT_MAX_LINE_BYTES) },
    })).rejects.toMatchObject({ code: "LINE_TOO_LARGE" });
    expect(write).not.toHaveBeenCalled();
    expect(writer.byteLength).toBe(0);
  });

  it("holds active server request frames against the ingress byte budget and releases on settlement", async () => {
    const transport = recordingTransport();
    const release = deferred<unknown>();
    const onServerRequest = vi.fn(() => release.promise);
    const first = {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: commandParams("x".repeat(512)),
    };
    const second = {
      id: 2,
      method: "item/commandExecution/requestApproval",
      params: commandParams("y".repeat(512)),
    };
    const oneFrameBudget = Buffer.byteLength(jsonLine(first));
    const peer = new CodexRpcPeer({
      write: transport.write,
      ingressLimits: {
        maxItems: 8,
        maxBytes: oneFrameBudget,
        pauseItems: 7,
        pauseBytes: oneFrameBudget,
        resumeItems: 4,
        resumeBytes: 0,
      },
      onServerRequest,
    });

    await peer.receive(jsonLine(first));
    await expect(peer.receive(jsonLine(second))).rejects.toMatchObject({ code: "QUEUE_OVERFLOW" });
    expect(onServerRequest).toHaveBeenCalledOnce();
    expect(peer.closed).toBe(true);

    release.resolve({ decision: "accept" });
    await peer.idle();
    expect(transport.writes).toHaveLength(0);
  });

  it("releases retained request bytes after a handler response so later work fits", async () => {
    const transport = recordingTransport();
    const releases = [deferred<unknown>(), deferred<unknown>()];
    let invocation = 0;
    const request = (id: number) => ({
      id,
      method: "item/commandExecution/requestApproval",
      params: commandParams("x".repeat(256)),
    });
    const budget = Buffer.byteLength(jsonLine(request(1)));
    const peer = new CodexRpcPeer({
      write: transport.write,
      ingressLimits: {
        maxItems: 4,
        maxBytes: budget,
        pauseItems: 3,
        pauseBytes: budget,
        resumeItems: 2,
        resumeBytes: 0,
      },
      onServerRequest: () => releases[invocation++]!.promise,
    });

    await peer.receive(jsonLine(request(1)));
    releases[0]!.resolve({ decision: "accept" });
    await peer.idle();
    await peer.receive(jsonLine(request(2)));
    releases[1]!.resolve({ decision: "decline" });
    await peer.idle();

    expect(invocation).toBe(2);
    expect(transport.writes).toEqual([
      { id: 1, result: { decision: "accept" } },
      { id: 2, result: { decision: "decline" } },
    ]);
  });
});

describe("Codex peer installed fallback guard integration", () => {
  it("rejects invalid known server request params before callback dispatch", async () => {
    const transport = recordingTransport();
    const onServerRequest = vi.fn(async () => ({ decision: "accept" }));
    const peer = new CodexRpcPeer({ write: transport.write, onServerRequest });

    await expect(peer.receive(jsonLine({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { itemId: "missing-identity" },
    }))).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
    expect(onServerRequest).not.toHaveBeenCalled();
    expect(transport.write).not.toHaveBeenCalled();
  });

  it("validates a server handler result before putting it on the wire", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({
      write: transport.write,
      onServerRequest: async () => ({ decision: "run-anything" }),
    });

    await peer.receive(jsonLine({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: commandParams(),
    }));
    await peer.idle();
    expect(transport.writes).toEqual([{
      id: 1,
      error: { code: -32_003, message: "Server request handler failed" },
    }]);
  });

  it("validates successful client results before resolving their pending call", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({ write: transport.write });
    const pending = peer.call("thread/list", {});
    void pending.catch(() => undefined);
    await peer.outboundIdle();

    await expect(peer.receive(jsonLine({ id: 1, result: { data: "not-an-array" } })))
      .rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
    await expect(pending).rejects.toMatchObject({ code: "PEER_CLOSED" });
  });

  it("rejects known client notification params before writing", async () => {
    const transport = recordingTransport();
    const peer = new CodexRpcPeer({ write: transport.write });

    await expect(peer.notify("initialized", { unexpected: true }))
      .rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
    expect(transport.write).not.toHaveBeenCalled();
  });
});

describe("Codex client call cancellation and deadlines", () => {
  it("publishes bounded default client and notification deadlines", () => {
    expect(CODEX_DEFAULT_CLIENT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(CODEX_DEFAULT_NOTIFICATION_TIMEOUT_MS).toBe(30_000);
  });

  it("does not write an already-aborted call", async () => {
    const transport = recordingTransport();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const setTimeoutFn = vi.fn();
    const peer = new CodexRpcPeer({ write: transport.write, setTimeoutFn });

    await expect(peer.call("thread/list", {}, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(transport.write).not.toHaveBeenCalled();
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(peer.closed).toBe(false);
  });

  it("honors a per-call deadline and removes timer and abort hooks after success", async () => {
    const transport = recordingTransport();
    let fireTimeout!: () => void;
    const timer = { call: "timer" };
    const clearTimeoutFn = vi.fn();
    const controller = new AbortController();
    const peer = new CodexRpcPeer({
      write: transport.write,
      setTimeoutFn: (callback, delayMs) => {
        expect(delayMs).toBe(250);
        fireTimeout = callback;
        return timer;
      },
      clearTimeoutFn,
    });
    const pending = peer.call("thread/list", {}, {
      signal: controller.signal,
      timeoutMs: 250,
    });
    await peer.outboundIdle();
    await peer.receive(jsonLine({ id: 1, result: { data: [] } }));

    await expect(pending).resolves.toEqual({ data: [] });
    expect(clearTimeoutFn).toHaveBeenCalledWith(timer);
    controller.abort(new Error("too late"));
    fireTimeout();
    expect(peer.closed).toBe(false);
  });

  it("rolls back a call without writing if its deadline cannot be scheduled", async () => {
    const transport = recordingTransport();
    const timerFailure = new Error("timer unavailable");
    const peer = new CodexRpcPeer({
      write: transport.write,
      setTimeoutFn: () => {
        throw timerFailure;
      },
    });

    await expect(peer.call("thread/list", {})).rejects.toBe(timerFailure);
    expect(peer.pendingClientRequests).toBe(0);
    expect(peer.closed).toBe(false);
    expect(transport.write).not.toHaveBeenCalled();
  });

  it("fails the peer closed when a sent mutation reaches its deadline and clears its timer", async () => {
    const transport = recordingTransport();
    let fireTimeout!: () => void;
    const timer = { timer: true };
    const clearTimeoutFn = vi.fn();
    const peer = new CodexRpcPeer({
      write: transport.write,
      clientRequestTimeoutMs: 1000,
      setTimeoutFn: (callback, delayMs) => {
        expect(delayMs).toBe(1000);
        fireTimeout = callback;
        return timer;
      },
      clearTimeoutFn,
    });
    const pending = peer.call("turn/start", { input: [], threadId: "thread-1" });
    void pending.catch(() => undefined);
    await peer.outboundIdle();

    fireTimeout();
    await expect(pending).rejects.toMatchObject({ code: "PEER_CLOSED" });
    expect(peer.closed).toBe(true);
    expect(clearTimeoutFn).toHaveBeenCalledWith(timer);
    expect(transport.writes).toHaveLength(1);
  });

  it("fails the peer closed when an enqueued call is aborted and a late response cannot revive it", async () => {
    const transport = recordingTransport();
    const controller = new AbortController();
    const peer = new CodexRpcPeer({ write: transport.write });
    const pending = peer.call("thread/list", {}, { signal: controller.signal });
    void pending.catch(() => undefined);
    await peer.outboundIdle();

    controller.abort(new Error("stop"));
    await expect(pending).rejects.toMatchObject({ code: "PEER_CLOSED" });
    expect(peer.closed).toBe(true);
    await expect(peer.receive(jsonLine({ id: 1, result: { data: [] } })))
      .rejects.toMatchObject({ code: "PEER_CLOSED" });
  });
});

describe("Codex notification callback shutdown", () => {
  it("preserves wire order by waiting for each completed callback before starting the next", async () => {
    const transport = recordingTransport();
    const first = deferred();
    const methods: string[] = [];
    const peer = new CodexRpcPeer({
      write: transport.write,
      onNotification: async (notification) => {
        methods.push(notification.method);
        if (methods.length === 1) await first.promise;
      },
    });

    const receiving = peer.receive(
      jsonLine({ method: "thread/archived", params: { threadId: "thread-1" } }) +
      jsonLine({ method: "thread/archived", params: { threadId: "thread-2" } }),
    );
    await Promise.resolve();
    expect(methods).toEqual(["thread/archived"]);
    first.resolve();
    await receiving;
    expect(methods).toEqual(["thread/archived", "thread/archived"]);
  });

  it("aborts a blocked callback and lets receive and idle settle on close", async () => {
    const transport = recordingTransport();
    let observedSignal: AbortSignal | undefined;
    const entered = deferred();
    const peer = new CodexRpcPeer({
      write: transport.write,
      onNotification: (_notification, { signal }) => {
        observedSignal = signal;
        entered.resolve();
        return new Promise(() => undefined);
      },
    });

    let receiveSettled = false;
    const receiving = peer.receive(jsonLine({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    })).then(() => {
      receiveSettled = true;
    });
    await entered.promise;
    peer.close();
    await receiving;

    expect(observedSignal?.aborted).toBe(true);
    expect(receiveSettled).toBe(true);
    await peer.idle();
  });

  it("times out a notification callback, aborts it, and faults the peer once", async () => {
    const transport = recordingTransport();
    let fireTimeout!: () => void;
    let signal: AbortSignal | undefined;
    const faults: CodexProtocolFault[] = [];
    const clearTimeoutFn = vi.fn();
    const peer = new CodexRpcPeer({
      write: transport.write,
      notificationTimeoutMs: 1000,
      setTimeoutFn: (callback, delayMs) => {
        expect(delayMs).toBe(1000);
        fireTimeout = callback;
        return callback;
      },
      clearTimeoutFn,
      onNotification: (_notification, context) => {
        signal = context.signal;
        return new Promise(() => undefined);
      },
      onProtocolFault: (fault) => faults.push(fault),
    });

    const receiving = peer.receive(jsonLine({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    }));
    await Promise.resolve();
    fireTimeout();

    await expect(receiving).rejects.toMatchObject({ code: "PEER_CLOSED" });
    expect(signal?.aborted).toBe(true);
    expect(peer.closed).toBe(true);
    expect(faults).toHaveLength(1);
    expect(clearTimeoutFn).toHaveBeenCalledOnce();
  });

  it("faults a throwing notification callback without exposing its error detail", async () => {
    const transport = recordingTransport();
    const faults: CodexProtocolFault[] = [];
    const peer = new CodexRpcPeer({
      write: transport.write,
      onNotification: async () => {
        throw new Error("private notification detail");
      },
      onProtocolFault: (fault) => faults.push(fault),
    });

    await expect(peer.receive(jsonLine({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    }))).rejects.toMatchObject({ code: "PEER_CLOSED" });
    expect(faults).toHaveLength(1);
    expect(faults[0]?.message).toBe("Codex notification handler failed");
    expect(faults[0]?.cause).toBeUndefined();
  });
});
