import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONTROL_DEFAULT_MAX_PENDING,
  CLAUDE_CONTROL_DEFAULT_INBOUND_TIMEOUT_MS,
  CLAUDE_CONTROL_DEFAULT_OUTBOUND_TIMEOUT_MS,
  CLAUDE_CONTROL_HARD_MAX_PENDING,
  CLAUDE_CONTROL_INBOUND_DENIED_MESSAGE,
  CLAUDE_CONTROL_INBOUND_FAILED_MESSAGE,
  CLAUDE_CONTROL_INBOUND_TIMEOUT_MESSAGE,
  CLAUDE_CONTROL_INBOUND_UNSUPPORTED_MESSAGE,
  CLAUDE_CONTROL_MAX_INTERRUPT_RECEIPT_ITEMS,
  CLAUDE_CONTROL_MAX_INBOUND_TIMEOUT_MS,
  CLAUDE_CONTROL_MAX_TOMBSTONES,
  ClaudeControlPeer,
  ClaudeControlPeerError,
  type ClaudeControlDiagnostic,
  type ClaudeControlPeerOptions,
} from "../../src/providers/claude/control-peer.js";

const HOME = "/canonical/claude-home";
const SESSION_A = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const SESSION_B = "129f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const QUEUED_A = "229f5b78-18c0-7b60-8f0c-6afc120ecd7d";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class ManualTimers {
  readonly tasks: Array<{
    readonly callback: () => void;
    readonly delayMs: number;
    cleared: boolean;
  }> = [];

  set = (callback: () => void, delayMs: number): object => {
    const task = { callback, delayMs, cleared: false };
    this.tasks.push(task);
    return task;
  };

  clear = (handle: unknown): void => {
    const task = handle as (typeof this.tasks)[number] | undefined;
    if (task) task.cleared = true;
  };

  fire(index = 0): void {
    const task = this.tasks[index];
    if (!task || task.cleared) throw new Error("missing active timer");
    task.callback();
  }
}

const success = (
  requestId: string,
  response?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: requestId,
    ...(response === undefined ? {} : { response }),
  },
});

const remoteError = (requestId: string, error: string): Readonly<Record<string, unknown>> => ({
  type: "control_response",
  response: { subtype: "error", request_id: requestId, error },
});

const inboundRequest = (
  requestId: string,
  request: Readonly<Record<string, unknown>> = {
    subtype: "can_use_tool",
    tool_name: "Read",
    input: { file_path: "/safe/file.ts" },
    tool_use_id: "tool-use-1",
  },
): Readonly<Record<string, unknown>> => ({
  type: "control_request",
  request_id: requestId,
  request,
});

const inboundCancel = (requestId: string): Readonly<Record<string, unknown>> => ({
  type: "control_cancel_request",
  request_id: requestId,
});

const flushMicrotasks = async (turns = 8): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};

interface HarnessOptions extends Partial<Omit<ClaudeControlPeerOptions,
  "configHome" | "sessionId" | "generation" | "sendEnvelope" | "requestIdFactory"
>> {
  readonly ids?: readonly string[];
  readonly sendEnvelope?: (value: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly generation?: number;
  readonly sessionId?: string;
}

const harness = (options: HarnessOptions = {}) => {
  const timers = new ManualTimers();
  const sent: Readonly<Record<string, unknown>>[] = [];
  const diagnostics: ClaudeControlDiagnostic[] = [];
  const faults: ClaudeControlPeerError[] = [];
  const ids = [...(options.ids ?? ["request-1", "request-2", "request-3"] )];
  const sendEnvelope = options.sendEnvelope ?? vi.fn(async (value) => {
    sent.push(value);
  });
  const peer = new ClaudeControlPeer({
    configHome: HOME,
    sessionId: options.sessionId ?? SESSION_A,
    generation: options.generation ?? 7,
    canonicalizeHome: (home) => home,
    sendEnvelope,
    requestIdFactory: () => ids.shift() ?? "request-fallback",
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onFault: (fault) => faults.push(fault),
    ...(options.maxPendingControls === undefined
      ? {}
      : { maxPendingControls: options.maxPendingControls }),
    ...(options.maxTombstones === undefined
      ? {}
      : { maxTombstones: options.maxTombstones }),
    ...(options.outboundTimeoutMs === undefined
      ? {}
      : { outboundTimeoutMs: options.outboundTimeoutMs }),
  });
  return { diagnostics, faults, peer, sendEnvelope, sent, timers };
};

describe("ClaudeControlPeer outbound correlation", () => {
  it("validates and exposes immutable canonical generation identity and bounded configuration", () => {
    const { peer } = harness();
    expect(peer.configHome).toBe(HOME);
    expect(peer.sessionId).toBe(SESSION_A);
    expect(peer.generation).toBe(7);
    expect(Reflect.set(peer, "configHome", "/other")).toBe(false);
    expect(peer.configHome).toBe(HOME);
    expect(CLAUDE_CONTROL_DEFAULT_MAX_PENDING).toBe(256);
    expect(CLAUDE_CONTROL_HARD_MAX_PENDING).toBe(4_096);
    expect(CLAUDE_CONTROL_DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(30_000);
    expect(CLAUDE_CONTROL_DEFAULT_INBOUND_TIMEOUT_MS).toBe(300_000);
    expect(CLAUDE_CONTROL_MAX_INBOUND_TIMEOUT_MS).toBe(600_000);
    expect(CLAUDE_CONTROL_MAX_TOMBSTONES).toBe(4_096);

    const base = {
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home: string) => home,
      sendEnvelope: async () => undefined,
      requestIdFactory: () => "request-1",
    };
    expect(() => new ClaudeControlPeer({ ...base, configHome: "relative" }))
      .toThrow(/canonical config home/i);
    expect(() => new ClaudeControlPeer({
      ...base,
      configHome: "/not-canonical",
      canonicalizeHome: () => HOME,
    })).toThrow(/canonical config home/i);
    expect(() => new ClaudeControlPeer({ ...base, sessionId: "not-a-uuid" }))
      .toThrow(/session UUID/i);
    expect(() => new ClaudeControlPeer({ ...base, generation: 0 }))
      .toThrow(/generation/i);
    expect(() => new ClaudeControlPeer({
      ...base,
      maxPendingControls: CLAUDE_CONTROL_HARD_MAX_PENDING + 1,
    })).toThrow(/maxPendingControls/i);
    expect(() => new ClaudeControlPeer({ ...base, maxTombstones: 0 }))
      .toThrow(/maxTombstones/i);
    expect(() => new ClaudeControlPeer({ ...base, outboundTimeoutMs: Number.NaN }))
      .toThrow(/outboundTimeoutMs/i);
    expect(() => new ClaudeControlPeer({ ...base, inboundTimeoutMs: 0 }))
      .toThrow(/inboundTimeoutMs/i);
    expect(() => new ClaudeControlPeer({
      ...base,
      inboundTimeoutMs: CLAUDE_CONTROL_MAX_INBOUND_TIMEOUT_MS + 1,
    })).toThrow(/inboundTimeoutMs/i);
  });

  it("builds the exact request and installs correlation and deadline before sending", async () => {
    let peer!: ClaudeControlPeer;
    let pendingDuringSend = 0;
    const wire: Readonly<Record<string, unknown>>[] = [];
    const timers = new ManualTimers();
    peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 3,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "initialize-1",
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      sendEnvelope: async (value) => {
        pendingDuringSend = peer.pendingRequestCount;
        expect(timers.tasks).toHaveLength(1);
        wire.push(value);
      },
    });

    const pending = peer.request({ subtype: "initialize", hooks: [] });
    expect(pendingDuringSend).toBe(1);
    expect(wire).toEqual([{
      type: "control_request",
      request_id: "initialize-1",
      request: { subtype: "initialize", hooks: [] },
    }]);
    expect(Object.isFrozen(wire[0])).toBe(true);
    expect(timers.tasks[0]?.delayMs).toBe(30_000);

    expect(peer.receive(success("initialize-1", { ready: true }))).toBe(true);
    const result = await pending;
    expect(result).toEqual({
      kind: "success",
      requestId: "initialize-1",
      response: { ready: true },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(peer.pendingRequestCount).toBe(0);
    expect(timers.tasks[0]?.cleared).toBe(true);
    expect(peer.receive({ type: "assistant", message: "normal" })).toBe(false);
  });

  it("stages a reentrant response until the send is confirmed", async () => {
    const sendGate = deferred<void>();
    let peer!: ClaudeControlPeer;
    peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "reentrant-1",
      sendEnvelope: (value) => {
        expect(value).toMatchObject({ request_id: "reentrant-1" });
        expect(peer.receive(success("reentrant-1", { acknowledged: true }))).toBe(true);
        return sendGate.promise;
      },
    });

    let settled = false;
    const pending = peer.request({ subtype: "initialize" }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    sendGate.resolve();
    await expect(pending).resolves.toMatchObject({ kind: "success" });
  });

  it("rejects a staged reentrant success when the later send fails", async () => {
    const secret = "send-secret-after-reentrant-response";
    let peer!: ClaudeControlPeer;
    peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "reentrant-failure",
      sendEnvelope: () => {
        peer.receive(success("reentrant-failure", { acknowledged: true }));
        return Promise.reject(new Error(secret));
      },
    });

    const pending = peer.request({ subtype: "interrupt" });
    await expect(pending).rejects.toMatchObject({
      code: "SEND_FAILED",
      message: expect.not.stringContaining(secret),
    });
    expect(peer.closed).toBe(true);
  });

  it("rejects remote errors without reflecting provider-controlled text", async () => {
    const secret = "provider-error-sk-ant-secret";
    const { peer } = harness({ ids: ["remote-error-1"] });
    const pending = peer.request({ subtype: "initialize" });
    peer.receive(remoteError("remote-error-1", secret));

    await expect(pending).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      message: expect.not.stringContaining(secret),
    });
    expect(peer.closed).toBe(false);
  });

  it("diagnoses unknown, late, and duplicate responses as sanitized no-ops", async () => {
    const { diagnostics, peer, timers } = harness({ ids: ["late-1", "done-1"] });
    expect(peer.receive(success("never-issued", { secret: "do-not-reflect" }))).toBe(true);

    const late = peer.request({ subtype: "initialize" }, { timeoutMs: 25 });
    timers.fire(0);
    await expect(late).rejects.toMatchObject({ code: "TIMEOUT" });
    peer.receive(success("late-1"));

    const done = peer.request({ subtype: "initialize" });
    peer.receive(success("done-1"));
    await done;
    peer.receive(success("done-1"));

    expect(diagnostics.map(({ code }) => code)).toEqual([
      "UNKNOWN_OUTBOUND_RESPONSE",
      "LATE_OUTBOUND_RESPONSE",
      "DUPLICATE_OUTBOUND_RESPONSE",
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("do-not-reflect");
    expect(JSON.stringify(diagnostics)).not.toContain("never-issued");
  });

  it("honors pre-send and in-flight AbortSignal without accepting a late response", async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("abort-secret-before-send"));
    const first = harness({ ids: ["never-sent"] });
    await expect(first.peer.request(
      { subtype: "initialize" },
      { signal: preAborted.signal },
    )).rejects.toMatchObject({ code: "ABORTED" });
    expect(first.sendEnvelope).not.toHaveBeenCalled();
    expect(first.timers.tasks).toHaveLength(0);

    const controller = new AbortController();
    const second = harness({ ids: ["aborted-live"] });
    const pending = second.peer.request(
      { subtype: "initialize" },
      { signal: controller.signal },
    );
    controller.abort(new Error("abort-secret-live"));
    await expect(pending).rejects.toMatchObject({
      code: "ABORTED",
      message: expect.not.stringContaining("abort-secret-live"),
    });
    second.peer.receive(success("aborted-live"));
    expect(second.diagnostics.map(({ code }) => code)).toEqual(["LATE_OUTBOUND_RESPONSE"]);
  });

  it("enforces bounded pending capacity and unique string request ids", async () => {
    const capacity = harness({ ids: ["only-1", "excess-2"], maxPendingControls: 1 });
    const accepted = capacity.peer.request({ subtype: "initialize" });
    await expect(capacity.peer.request({ subtype: "interrupt" })).rejects.toMatchObject({
      code: "CAPACITY",
    });
    expect(capacity.sendEnvelope).toHaveBeenCalledOnce();
    capacity.peer.receive(success("only-1"));
    await accepted;

    const collision = harness({ ids: ["same-id", "same-id"] });
    const first = collision.peer.request({ subtype: "initialize" });
    await expect(collision.peer.request({ subtype: "interrupt" })).rejects.toMatchObject({
      code: "ID_COLLISION",
    });
    expect(collision.sendEnvelope).toHaveBeenCalledOnce();
    collision.peer.receive(success("same-id"));
    await first;

    const invalid = harness({ ids: [" invalid-id "] });
    await expect(invalid.peer.request({ subtype: "initialize" })).rejects.toMatchObject({
      code: "INVALID_REQUEST_ID",
    });
    expect(invalid.sendEnvelope).not.toHaveBeenCalled();
  });

  it("faults on one send failure, rejects every pending request, and never retries", async () => {
    const sends = [deferred<void>(), deferred<void>()];
    let sendIndex = 0;
    const sendEnvelope = vi.fn(() => sends[sendIndex++]!.promise);
    const { faults, peer } = harness({
      ids: ["uncertain-1", "uncertain-2"],
      sendEnvelope,
    });
    const first = peer.request({ subtype: "initialize" });
    const second = peer.request({ subtype: "interrupt" });
    sends[0]!.reject(new Error("transport-write-secret"));

    await expect(first).rejects.toMatchObject({ code: "SEND_FAILED" });
    await expect(second).rejects.toMatchObject({ code: "SEND_FAILED" });
    expect(peer.closed).toBe(true);
    expect(sendEnvelope).toHaveBeenCalledTimes(2);
    expect(faults).toHaveLength(1);
    expect(String(faults[0])).not.toContain("transport-write-secret");
    sends[1]!.resolve();
    await Promise.resolve();
    expect(sendEnvelope).toHaveBeenCalledTimes(2);
  });

  it("commits a send fault before invoking a reentrant fault hook", async () => {
    let peer!: ClaudeControlPeer;
    const observed: ClaudeControlPeerError[] = [];
    peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "fault-hook-reentrant",
      sendEnvelope: async () => {
        throw new Error("send-secret");
      },
      onFault: (fault) => {
        observed.push(fault);
        peer.close();
      },
    });

    await expect(peer.request({ subtype: "interrupt" })).rejects.toMatchObject({
      code: "SEND_FAILED",
    });
    expect(observed).toHaveLength(1);
    expect(peer.closed).toBe(true);
  });

  it("bounds lifetime id reservations and exhausts the generation before eviction", async () => {
    const { peer, sendEnvelope } = harness({
      ids: ["tomb-1", "tomb-2", "tomb-3"],
      maxTombstones: 2,
    });
    for (const id of ["tomb-1", "tomb-2"]) {
      const pending = peer.request({ subtype: "initialize" });
      peer.receive(success(id));
      await pending;
    }

    const exhausted = peer.request({ subtype: "initialize" });
    peer.receive(success("tomb-3"));
    const [outcome] = await Promise.allSettled([exhausted]);

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "ID_EXHAUSTED" },
    });
    expect(sendEnvelope).toHaveBeenCalledTimes(2);
    expect(peer.outboundTombstoneCount).toBe(2);
  });

  it("never lets a late old response settle an attempted same-generation id reuse", async () => {
    const { diagnostics, peer, sendEnvelope } = harness({
      ids: ["old-id", "second-id", "overflow-id", "old-id"],
      maxTombstones: 2,
    });
    for (const id of ["old-id", "second-id"]) {
      const pending = peer.request({ subtype: "initialize" });
      peer.receive(success(id));
      await pending;
    }

    const overflow = peer.request({ subtype: "initialize" });
    peer.receive(success("overflow-id", { stale: true }));
    const [overflowOutcome] = await Promise.allSettled([overflow]);

    const reuse = peer.request({ subtype: "interrupt" });
    peer.receive(success("old-id", { stale: true }));
    const [reuseOutcome] = await Promise.allSettled([reuse]);

    expect(overflowOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "ID_EXHAUSTED" },
    });
    expect(reuseOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "ID_EXHAUSTED" },
    });
    expect(sendEnvelope).toHaveBeenCalledTimes(2);
    expect(peer.pendingRequestCount).toBe(0);
    expect(peer.outboundTombstoneCount).toBe(2);
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "UNKNOWN_OUTBOUND_RESPONSE",
      "DUPLICATE_OUTBOUND_RESPONSE",
    ]);
  });

  it("reserves the terminal id before a timer cleanup hook can reenter", async () => {
    let peer!: ClaudeControlPeer;
    let reentrant: Promise<unknown> | undefined;
    let clearCalls = 0;
    const sendEnvelope = vi.fn(async () => undefined);
    peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "cleanup-reentrant-id",
      sendEnvelope,
      setTimeoutFn: () => ({ timer: true }),
      clearTimeoutFn: () => {
        clearCalls += 1;
        if (clearCalls === 1) reentrant = peer.request({ subtype: "interrupt" });
      },
    });

    const first = peer.request({ subtype: "initialize" });
    peer.receive(success("cleanup-reentrant-id"));
    await first;
    peer.receive(success("cleanup-reentrant-id", { stale: true }));

    expect(reentrant).toBeDefined();
    const [outcome] = await Promise.allSettled([reentrant!]);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "ID_COLLISION" },
    });
    expect(sendEnvelope).toHaveBeenCalledOnce();
    expect(peer.pendingRequestCount).toBe(0);
    expect(peer.outboundTombstoneCount).toBe(1);
  });

  it("keeps identical wire ids isolated across peer instances and generations", async () => {
    const first = harness({ ids: ["shared-id"], generation: 11, sessionId: SESSION_A });
    const second = harness({ ids: ["shared-id"], generation: 12, sessionId: SESSION_B });
    const firstPending = first.peer.request({ subtype: "initialize" });
    const secondPending = second.peer.request({ subtype: "initialize" });
    let secondSettled = false;
    void secondPending.finally(() => {
      secondSettled = true;
    }).catch(() => undefined);

    first.peer.receive(success("shared-id", { generation: 11 }));
    await expect(firstPending).resolves.toMatchObject({ response: { generation: 11 } });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(second.peer.pendingRequestCount).toBe(1);

    second.peer.close();
    await expect(secondPending).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("closes idempotently, clears deadlines, and prevents later settlement", async () => {
    const { faults, peer, sendEnvelope, timers } = harness({ ids: ["close-1"] });
    const pending = peer.request({ subtype: "initialize" });
    peer.close();
    peer.close();

    await expect(pending).rejects.toMatchObject({ code: "CLOSED" });
    expect(peer.closed).toBe(true);
    expect(peer.pendingRequestCount).toBe(0);
    expect(peer.outboundTombstoneCount).toBe(0);
    expect(timers.tasks[0]?.cleared).toBe(true);
    expect(faults).toHaveLength(0);
    expect(peer.receive(success("close-1"))).toBe(true);
    expect(sendEnvelope).toHaveBeenCalledOnce();
  });

  it("contains throwing and synchronously firing timer implementations", async () => {
    const timerSecret = "timer-construction-secret";
    const sendEnvelope = vi.fn(async () => undefined);
    const throwing = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "timer-throw",
      sendEnvelope,
      setTimeoutFn: () => {
        throw new Error(timerSecret);
      },
    });
    await expect(throwing.request({ subtype: "initialize" })).rejects.toMatchObject({
      code: "TIMER_FAILURE",
      message: expect.not.stringContaining(timerSecret),
    });
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(throwing.pendingRequestCount).toBe(0);

    const clearTimeoutFn = vi.fn(() => {
      throw new Error("clear-timer-secret");
    });
    const synchronousSend = vi.fn(async () => undefined);
    const synchronous = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "timer-sync",
      sendEnvelope: synchronousSend,
      setTimeoutFn: (callback) => {
        callback();
        return { timer: true };
      },
      clearTimeoutFn,
    });
    await expect(synchronous.request({ subtype: "initialize" })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(synchronousSend).not.toHaveBeenCalled();
    expect(clearTimeoutFn).toHaveBeenCalledOnce();
  });

  it("contains throwing request-id and diagnostic hooks without leaking values", async () => {
    const secret = "request-id-factory-secret";
    const sendEnvelope = vi.fn(async () => undefined);
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => {
        throw new Error(secret);
      },
      sendEnvelope,
      onDiagnostic: () => {
        throw new Error("diagnostic-hook-secret");
      },
      onFault: () => {
        throw new Error("fault-hook-secret");
      },
    });

    await expect(peer.request({ subtype: "initialize" })).rejects.toMatchObject({
      code: "INVALID_REQUEST_ID",
      message: expect.not.stringContaining(secret),
    });
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(() => peer.receive(success("hostile-unknown", { value: secret }))).not.toThrow();
  });
});

describe("ClaudeControlPeer inbound lifecycle", () => {
  it("returns promptly after installing the inbound request and settles it asynchronously", async () => {
    const resultGate = deferred<{
      readonly kind: "success";
      readonly response: Readonly<Record<string, unknown>>;
    }>();
    const sent: Readonly<Record<string, unknown>>[] = [];
    const handler = vi.fn((_request: unknown, _context: unknown) => resultGate.promise);
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 9,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      sendEnvelope: async (value) => {
        sent.push(value);
      },
      handleInboundControl: handler,
    } as ClaudeControlPeerOptions);

    expect(peer.receive(inboundRequest("inbound-prompt"))).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    await flushMicrotasks();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      requestId: "inbound-prompt",
      request: { kind: "can-use-tool", toolName: "Read", toolUseId: "tool-use-1" },
    });
    expect(handler.mock.calls[0]?.[1]).toMatchObject({
      home: HOME,
      sessionId: SESSION_A,
      generation: 9,
      signal: expect.any(AbortSignal),
    });
    expect(sent).toHaveLength(0);

    resultGate.resolve({ kind: "success", response: { accepted: false } });
    await flushMicrotasks();
    expect(sent).toEqual([{
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "inbound-prompt",
        response: { accepted: false },
      },
    }]);
  });

  it("caches the frozen terminal response before sending and retransmits its identity", async () => {
    const request = inboundRequest("dedup-1");
    const sent: Readonly<Record<string, unknown>>[] = [];
    const handler = vi.fn(async () => ({
      kind: "error" as const,
      error: "DENIED" as const,
    }));
    let peer!: ClaudeControlPeer;
    peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: handler,
      sendEnvelope: async (value) => {
        sent.push(value);
        if (sent.length === 1) expect(peer.receive(request)).toBe(true);
      },
    } as ClaudeControlPeerOptions);

    expect(peer.receive(request)).toBe(true);
    expect(peer.receive(request)).toBe(true);
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(Object.isFrozen(sent[0])).toBe(true);
    expect(sent[0]).toEqual({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "dedup-1",
        error: CLAUDE_CONTROL_INBOUND_DENIED_MESSAGE,
      },
    });
  });

  it("cancels one pending handler without responding or accepting its late settlement", async () => {
    const resultGate = deferred<{
      readonly kind: "success";
      readonly response: Readonly<Record<string, unknown>>;
    }>();
    const diagnostics: ClaudeControlDiagnostic[] = [];
    const cancellations: unknown[] = [];
    const sent: Readonly<Record<string, unknown>>[] = [];
    let handlerSignal: AbortSignal | undefined;
    const handler = vi.fn((_request: unknown, context: { readonly signal: AbortSignal }) => {
      handlerSignal = context.signal;
      return resultGate.promise;
    });
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: handler,
      onInboundCancellation: (request: unknown) => cancellations.push(request),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sendEnvelope: async (value) => {
        sent.push(value);
      },
    } as ClaudeControlPeerOptions);

    peer.receive(inboundRequest("cancel-1"));
    await flushMicrotasks();
    expect(handlerSignal?.aborted).toBe(false);

    expect(peer.receive(inboundCancel("cancel-1"))).toBe(true);
    expect(handlerSignal?.aborted).toBe(true);
    expect(cancellations).toHaveLength(1);
    expect(diagnostics.map(({ code }) => code)).toEqual(["INBOUND_CONTROL_CANCELLED"]);
    expect(sent).toHaveLength(0);

    resultGate.resolve({ kind: "success", response: { unsafe: true } });
    await flushMicrotasks();
    expect(sent).toHaveLength(0);
    expect(cancellations).toHaveLength(1);
  });

  it("replays pending initialize requests through the same nonblocking handler path", async () => {
    const handlerGate = deferred<{
      readonly kind: "error";
      readonly error: "DENIED";
    }>();
    const sent: Readonly<Record<string, unknown>>[] = [];
    const handler = vi.fn(() => handlerGate.promise);
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "initialize-replay",
      handleInboundControl: handler,
      sendEnvelope: async (value) => {
        sent.push(value);
      },
    } as ClaudeControlPeerOptions);

    const initialize = peer.request({ subtype: "initialize" });
    expect(peer.receive({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "initialize-replay",
        response: { ready: true },
        pending_permission_requests: [inboundRequest("replayed-permission")],
        pending_user_dialog_requests: [],
      },
    })).toBe(true);

    expect(handler).not.toHaveBeenCalled();
    await expect(initialize).resolves.toMatchObject({ response: { ready: true } });
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ requestId: "replayed-permission" });

    handlerGate.resolve({ kind: "error", error: "DENIED" });
    await flushMicrotasks();
    expect(sent.at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "replayed-permission",
        error: CLAUDE_CONTROL_INBOUND_DENIED_MESSAGE,
      },
    });
  });

  it("fails closed with the exact unsupported response when no handler is installed", async () => {
    const { peer, sent, timers } = harness();
    expect(peer.receive(inboundRequest("unsupported-1"))).toBe(true);
    expect(sent).toHaveLength(0);
    await flushMicrotasks();

    expect(sent).toEqual([{
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "unsupported-1",
        error: CLAUDE_CONTROL_INBOUND_UNSUPPORTED_MESSAGE,
      },
    }]);
    expect(timers.tasks[0]?.delayMs).toBe(CLAUDE_CONTROL_DEFAULT_INBOUND_TIMEOUT_MS);
  });

  it("uses the timeout response and never invokes the handler when timer creation fails", () => {
    const secret = "timer-construction-secret";
    const sent: Readonly<Record<string, unknown>>[] = [];
    const handler = vi.fn(async () => ({ kind: "success" as const }));
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: handler,
      setTimeoutFn: () => {
        throw new Error(secret);
      },
      sendEnvelope: async (value) => {
        sent.push(value);
      },
    });

    expect(peer.receive(inboundRequest("timer-failure"))).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual([{
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "timer-failure",
        error: CLAUDE_CONTROL_INBOUND_TIMEOUT_MESSAGE,
      },
    }]);
    expect(JSON.stringify(sent)).not.toContain(secret);
  });

  it("aborts a live handler and sends one exact fail-closed response at its deadline", async () => {
    const timers = new ManualTimers();
    const resultGate = deferred<{ readonly kind: "success" }>();
    const sent: Readonly<Record<string, unknown>>[] = [];
    let signal: AbortSignal | undefined;
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      inboundTimeoutMs: 123,
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      handleInboundControl: (_request, context) => {
        signal = context.signal;
        return resultGate.promise;
      },
      sendEnvelope: async (value) => {
        sent.push(value);
      },
    });

    peer.receive(inboundRequest("deadline-1"));
    await flushMicrotasks();
    expect(signal?.aborted).toBe(false);
    expect(timers.tasks[0]?.delayMs).toBe(123);
    timers.fire();
    expect(signal?.aborted).toBe(true);
    expect(sent).toEqual([{
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "deadline-1",
        error: CLAUDE_CONTROL_INBOUND_TIMEOUT_MESSAGE,
      },
    }]);

    resultGate.resolve({ kind: "success" });
    await flushMicrotasks();
    expect(sent).toHaveLength(1);
  });

  it("treats unknown and repeated cancels as sanitized no-ops", () => {
    const diagnostics: ClaudeControlDiagnostic[] = [];
    const cancellations: unknown[] = [];
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: () => new Promise(() => undefined),
      sendEnvelope: async () => undefined,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onInboundCancellation: (request) => cancellations.push(request),
    });

    expect(peer.receive(inboundCancel("unknown"))).toBe(true);
    peer.receive(inboundRequest("cancel-repeat"));
    expect(peer.receive(inboundCancel("cancel-repeat"))).toBe(true);
    expect(peer.receive(inboundCancel("cancel-repeat"))).toBe(true);

    expect(cancellations).toHaveLength(1);
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "STALE_INBOUND_CANCEL",
      "INBOUND_CONTROL_CANCELLED",
      "STALE_INBOUND_CANCEL",
    ]);
  });

  it("faults byte-distinct request reuse without exposing either payload", () => {
    const secret = "second-payload-secret";
    const faults: ClaudeControlPeerError[] = [];
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: () => new Promise(() => undefined),
      sendEnvelope: async () => undefined,
      onFault: (fault) => faults.push(fault),
    });

    peer.receive(inboundRequest("wire-reuse", {
      subtype: "can_use_tool",
      tool_name: "Read",
      input: { file_path: "/safe/a.ts" },
      tool_use_id: "tool-use-1",
    }));
    expect(() => peer.receive(inboundRequest("wire-reuse", {
      tool_use_id: "tool-use-1",
      input: { file_path: secret },
      tool_name: "Read",
      subtype: "can_use_tool",
    }))).toThrowError(expect.objectContaining({
      code: "PROTOCOL_FAULT",
      message: expect.not.stringContaining(secret),
    }));
    expect(peer.closed).toBe(true);
    expect(faults).toHaveLength(1);
  });

  it("fails closed when inbound lifetime reservations are exhausted", async () => {
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      maxTombstones: 1,
      handleInboundControl: async () => ({ kind: "error", error: "DENIED" }),
      sendEnvelope: async () => undefined,
    });

    peer.receive(inboundRequest("lifetime-1"));
    await flushMicrotasks();
    expect(peer.inboundTerminalCount).toBe(1);
    expect(() => peer.receive(inboundRequest("lifetime-2")))
      .toThrowError(expect.objectContaining({ code: "ID_EXHAUSTED" }));
    expect(peer.closed).toBe(true);
  });

  it("applies the aggregate pending cap across inbound and outbound directions", async () => {
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-after-inbound",
      maxPendingControls: 1,
      handleInboundControl: () => new Promise(() => undefined),
      sendEnvelope: async () => undefined,
    });

    peer.receive(inboundRequest("inbound-capacity"));
    expect(peer.pendingInboundRequestCount).toBe(1);
    await expect(peer.request({ subtype: "interrupt" })).rejects.toMatchObject({
      code: "CAPACITY",
    });
  });

  it("settles initialize before a separately scheduled replay batch fails closed", async () => {
    const handler = vi.fn(() => new Promise(() => undefined));
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "initialize-overflow",
      maxPendingControls: 1,
      handleInboundControl: handler,
      sendEnvelope: async () => undefined,
    });
    const initialize = peer.request({ subtype: "initialize" });
    await flushMicrotasks();

    expect(peer.receive({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "initialize-overflow",
        pending_permission_requests: [
          inboundRequest("replay-1"),
          inboundRequest("replay-2"),
        ],
        pending_user_dialog_requests: [],
      },
    })).toBe(true);
    expect(peer.closed).toBe(false);
    await expect(initialize).resolves.toMatchObject({ kind: "success" });
    await flushMicrotasks();
    expect(peer.closed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("closes by aborting inbound work and suppressing late response sends", async () => {
    const resultGate = deferred<{ readonly kind: "success" }>();
    const sent: Readonly<Record<string, unknown>>[] = [];
    let signal: AbortSignal | undefined;
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: (_request, context) => {
        signal = context.signal;
        return resultGate.promise;
      },
      sendEnvelope: async (value) => {
        sent.push(value);
      },
    });

    peer.receive(inboundRequest("close-inbound"));
    await flushMicrotasks();
    peer.close();
    expect(signal?.aborted).toBe(true);
    expect(peer.pendingInboundRequestCount).toBe(0);
    expect(peer.inboundTerminalCount).toBe(0);
    resultGate.resolve({ kind: "success" });
    await flushMicrotasks();
    expect(sent).toHaveLength(0);
  });

  it("sanitizes handler and result-factory failures before writing the wire", async () => {
    const secret = "handler-or-factory-secret";
    const sent: Readonly<Record<string, unknown>>[] = [];
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: async () => {
        throw new Error(secret);
      },
      createInboundErrorResult: () => {
        throw new Error(secret);
      },
      sendEnvelope: async (value) => {
        sent.push(value);
      },
    });

    peer.receive(inboundRequest("sanitized-handler"));
    await flushMicrotasks();
    expect(sent).toEqual([{
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "sanitized-handler",
        error: CLAUDE_CONTROL_INBOUND_FAILED_MESSAGE,
      },
    }]);
    expect(JSON.stringify(sent)).not.toContain(secret);
  });

  it("faults and never retries when an inbound response send fails", async () => {
    const secret = "inbound-send-secret";
    const faults: ClaudeControlPeerError[] = [];
    const sendEnvelope = vi.fn(async () => {
      throw new Error(secret);
    });
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION_A,
      generation: 1,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: async () => ({ kind: "error", error: "DENIED" }),
      sendEnvelope,
      onFault: (fault) => faults.push(fault),
    });

    peer.receive(inboundRequest("send-failure"));
    await flushMicrotasks();
    expect(peer.closed).toBe(true);
    expect(sendEnvelope).toHaveBeenCalledOnce();
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      code: "SEND_FAILED",
      message: expect.not.stringContaining(secret),
    });
  });
});

describe("ClaudeControlPeer interrupt receipts", () => {
  it("sends the exact interrupt request and returns a strict frozen receipt", async () => {
    const { peer, sent } = harness({ ids: ["interrupt-1"] });
    const pending = peer.interrupt({ receiptRequired: true });
    expect(sent).toEqual([{
      type: "control_request",
      request_id: "interrupt-1",
      request: { subtype: "interrupt" },
    }]);

    peer.receive(success("interrupt-1", { still_queued: ["opaque-queue-item"] }));
    const receipt = await pending;
    expect(receipt).toEqual(["opaque-queue-item"]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(CLAUDE_CONTROL_MAX_INTERRUPT_RECEIPT_ITEMS).toBe(256);
  });

  it.each([
    ["missing", undefined],
    ["extra key", { still_queued: [QUEUED_A], extra: true }],
    ["non-array", { still_queued: "wrong" }],
    ["empty identifier", { still_queued: [""] }],
    ["control character", { still_queued: ["queue\nitem"] }],
    ["oversized identifier", { still_queued: ["q".repeat(513)] }],
    [
      "oversized",
      { still_queued: Array.from({ length: 257 }, () => QUEUED_A) },
    ],
  ])("faults a required interrupt receipt with %s", async (_label, response) => {
    const { faults, peer } = harness({ ids: ["interrupt-invalid"] });
    const pending = peer.interrupt({ receiptRequired: true });
    peer.receive(success("interrupt-invalid", response));

    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_FAULT" });
    expect(peer.closed).toBe(true);
    expect(faults).toHaveLength(1);
  });

  it("allows absent, empty, or valid strict success when a receipt is optional", async () => {
    const absent = harness({ ids: ["interrupt-absent"] });
    const absentPending = absent.peer.interrupt({ receiptRequired: false });
    absent.peer.receive(success("interrupt-absent"));
    await expect(absentPending).resolves.toBeUndefined();

    const empty = harness({ ids: ["interrupt-empty"] });
    const emptyPending = empty.peer.interrupt({ receiptRequired: false });
    empty.peer.receive(success("interrupt-empty", {}));
    await expect(emptyPending).resolves.toBeUndefined();

    const present = harness({ ids: ["interrupt-present"] });
    const presentPending = present.peer.interrupt({ receiptRequired: false });
    present.peer.receive(success("interrupt-present", { still_queued: [QUEUED_A] }));
    const receipt = await presentPending;
    expect(receipt).toEqual([QUEUED_A]);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it.each([
    ["extra key", { still_queued: [QUEUED_A], extra: true }],
    ["non-array", { still_queued: "wrong" }],
    ["empty identifier", { still_queued: [""] }],
    ["control character", { still_queued: ["queue\nitem"] }],
    ["oversized identifier", { still_queued: ["q".repeat(513)] }],
    [
      "oversized",
      { still_queued: Array.from({ length: 257 }, () => QUEUED_A) },
    ],
  ])("faults a malformed present optional interrupt receipt with %s", async (_label, response) => {
    const { faults, peer } = harness({ ids: ["interrupt-optional-invalid"] });
    const pending = peer.interrupt({ receiptRequired: false });
    peer.receive(success("interrupt-optional-invalid", response));

    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_FAULT" });
    expect(peer.closed).toBe(true);
    expect(faults).toHaveLength(1);
  });
});
