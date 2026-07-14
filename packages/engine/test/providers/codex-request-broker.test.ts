import { describe, expect, it, vi } from "vitest";
import { createProviderRequestIdentity } from "../../src/providers/request-identity.js";
import type {
  ProviderEvent,
  ProviderRequest,
} from "../../src/providers/events.js";
import type {
  ProviderRequestIdentity,
  ProviderRequestResponse,
} from "../../src/providers/types.js";
import {
  CodexRequestBroker,
  CodexRequestBrokerError,
} from "../../src/providers/codex/request-broker.js";

class ManualTimers {
  private nextId = 1;
  readonly callbacks = new Map<number, () => void>();
  readonly delays = new Map<number, number>();

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.delays.set(id, delayMs);
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.callbacks.delete(handle as number);
    this.delays.delete(handle as number);
  };

  fire(handle: number): void {
    const callback = this.callbacks.get(handle);
    this.callbacks.delete(handle);
    this.delays.delete(handle);
    callback?.();
  }

  fireFirst(): void {
    const handle = this.callbacks.keys().next().value as number | undefined;
    if (handle !== undefined) this.fire(handle);
  }
}

const controller = () => new AbortController();
const context = (generation = 7, signal = controller().signal) => Object.freeze({
  home: "/tmp/devhub-codex-broker-home",
  generation,
  occurredAt: "2026-07-13T10:00:00.000Z",
  signal,
});

const itemParams = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  startedAtMs: 1,
  ...overrides,
});

const commandRequest = (id: string | number = 1) => ({
  id,
  method: "item/commandExecution/requestApproval",
  params: itemParams({ approvalId: "approval-1" }),
});

const requestEvent = (events: readonly ProviderEvent[], index = 0): Extract<ProviderEvent, { type: "request" }> => {
  const event = events.filter((candidate): candidate is Extract<ProviderEvent, { type: "request" }> =>
    candidate.type === "request")[index];
  if (!event) throw new Error("expected request event");
  return event;
};

const response = (
  request: ProviderRequest,
  overrides: Partial<ProviderRequestResponse> = {},
): ProviderRequestResponse => {
  if (request.kind === "permission") {
    return { kind: "permission", identity: request.identity, permissions: [], ...overrides } as ProviderRequestResponse;
  }
  if (request.kind === "user-input") {
    return { kind: "user-input", identity: request.identity, answers: {}, ...overrides } as ProviderRequestResponse;
  }
  return { kind: request.kind, identity: request.identity, decision: "cancel", ...overrides } as ProviderRequestResponse;
};

function setup(options: {
  maxPendingRequests?: number;
  maxTombstones?: number;
  requestTimeoutMs?: number;
  timers?: ManualTimers;
} = {}) {
  const events: ProviderEvent[] = [];
  const timers = options.timers ?? new ManualTimers();
  const broker = new CodexRequestBroker({
    emit: (event) => events.push(event),
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    ...(options.maxPendingRequests === undefined ? {} : { maxPendingRequests: options.maxPendingRequests }),
    ...(options.maxTombstones === undefined ? {} : { maxTombstones: options.maxTombstones }),
  });
  return { broker, events, timers };
}

describe("CodexRequestBroker", () => {
  it("emits a request, maps allow exactly, and resolves the wire handler once", async () => {
    const { broker, events } = setup();
    const handling = broker.handle(commandRequest(), context());
    const request = requestEvent(events).request;

    await expect(broker.respond(response(request, { decision: "allow" }))).resolves.toBe("dispatched");
    await expect(handling).resolves.toEqual({ decision: "accept" });
    expect(events.filter((event) => event.type === "request-resolved")).toMatchObject([{
      type: "request-resolved",
      identity: request.identity,
    }]);
    expect(broker.pendingCount).toBe(0);
  });

  it("keeps numeric 1 and string 1 as distinct pending requests", async () => {
    const { broker, events } = setup();
    const numericHandling = broker.handle(commandRequest(1), context());
    const stringHandling = broker.handle(commandRequest("1"), context());
    const numeric = requestEvent(events, 0).request;
    const string = requestEvent(events, 1).request;

    await broker.respond(response(string, { decision: "deny" }));
    await expect(stringHandling).resolves.toEqual({ decision: "decline" });
    expect(broker.pendingCount).toBe(1);

    await broker.respond(response(numeric, { decision: "cancel" }));
    await expect(numericHandling).resolves.toEqual({ decision: "cancel" });
  });

  it("maps file, MCP, user-input, and empty permission responses to installed shapes", async () => {
    const { broker, events } = setup();
    const fileHandling = broker.handle({
      id: "file",
      method: "item/fileChange/requestApproval",
      params: itemParams(),
    }, context());
    const mcpHandling = broker.handle({
      id: "mcp",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "server",
        mode: "url",
        elicitationId: "elicit-1",
        message: "Continue?",
        url: "https://example.invalid",
      },
    }, context());
    const inputHandling = broker.handle({
      id: "input",
      method: "item/tool/requestUserInput",
      params: itemParams({
        autoResolutionMs: 60_000,
        questions: [{ id: "q1", header: "H", question: "Q" }],
      }),
    }, context());
    const permissionHandling = broker.handle({
      id: "permission",
      method: "item/permissions/requestApproval",
      params: itemParams({ cwd: "/tmp/work", permissions: {} }),
    }, context());
    const requests = events.filter((event): event is Extract<ProviderEvent, { type: "request" }> =>
      event.type === "request").map((event) => event.request);

    await broker.respond(response(requests[0]!, { decision: "allow" }));
    await broker.respond(response(requests[1]!, { decision: "deny" }));
    await broker.respond(response(requests[2]!, { answers: { q1: "yes" } }));
    await broker.respond(response(requests[3]!));

    await expect(fileHandling).resolves.toEqual({ decision: "accept" });
    await expect(mcpHandling).resolves.toEqual({ action: "decline" });
    await expect(inputHandling).resolves.toEqual({
      answers: { q1: { answers: ["yes"] } },
    });
    await expect(permissionHandling).resolves.toEqual({ permissions: {} });
  });

  it("keeps a pending request intact after wrong-kind, wrong-owner, or wrong-generation responses", async () => {
    const { broker, events } = setup();
    const handling = broker.handle(commandRequest(), context());
    const pending = requestEvent(events).request;

    await expect(broker.respond({
      kind: "file-change-approval",
      identity: pending.identity,
      decision: "allow",
    })).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" });

    const wrongGeneration = createProviderRequestIdentity({
      ...pending.identity,
      generation: 8,
    });
    await expect(broker.respond({
      kind: "command-approval",
      identity: wrongGeneration,
      decision: "allow",
    })).resolves.toBe("stale");

    const wrongOwner = createProviderRequestIdentity({
      ...pending.identity,
      key: { ...pending.identity.key, nativeTaskId: "thread-2" },
    });
    await expect(broker.respond({
      kind: "command-approval",
      identity: wrongOwner,
      decision: "allow",
    })).resolves.toBe("stale");
    expect(broker.pendingCount).toBe(1);

    await broker.respond(response(pending, { decision: "cancel" }));
    await expect(handling).resolves.toEqual({ decision: "cancel" });
  });

  it("rejects duplicate live requests and enforces bounded pending capacity", async () => {
    const { broker, events } = setup({ maxPendingRequests: 1 });
    const first = broker.handle(commandRequest(1), context());
    await expect(broker.handle(commandRequest(1), context())).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(broker.handle(commandRequest(2), context())).rejects.toMatchObject({ code: "CAPACITY" });

    const pending = requestEvent(events).request;
    await broker.respond(response(pending));
    await first;
  });

  it("uses fail-closed timeout responses only where the provider declares them safe", async () => {
    const safe = setup();
    const commandHandling = safe.broker.handle(commandRequest(), context());
    safe.timers.fireFirst();
    await expect(commandHandling).resolves.toEqual({ decision: "cancel" });

    const auto = setup();
    const autoHandling = auto.broker.handle({
      id: "input-auto",
      method: "item/tool/requestUserInput",
      params: itemParams({
        autoResolutionMs: 60_000,
        questions: [{ id: "q1", header: "H", question: "Q" }],
      }),
    }, context());
    expect([...auto.timers.delays.values()]).toEqual([1_000]);
    auto.timers.fireFirst();
    await expect(autoHandling).resolves.toEqual({ answers: {} });

    const unsafe = setup();
    const unsafeHandling = unsafe.broker.handle({
      id: "input-manual",
      method: "item/tool/requestUserInput",
      params: itemParams({
        autoResolutionMs: null,
        questions: [{ id: "q1", header: "H", question: "Q" }],
      }),
    }, context());
    unsafe.timers.fireFirst();
    await expect(unsafeHandling).rejects.toMatchObject({ code: "UNSAFE_TIMEOUT" });
  });

  it("validates answer ownership and rejects non-empty permission grants", async () => {
    const { broker, events } = setup();
    const inputHandling = broker.handle({
      id: "input",
      method: "item/tool/requestUserInput",
      params: itemParams({
        questions: [{ id: "q1", header: "H", question: "Q" }],
      }),
    }, context());
    const input = requestEvent(events, 0).request;
    await expect(broker.respond(response(input, { answers: { unknown: "secret-answer" } })))
      .rejects.toMatchObject({ code: "RESPONSE_MISMATCH" });

    const permissionHandling = broker.handle({
      id: "permission",
      method: "item/permissions/requestApproval",
      params: itemParams({ cwd: "/tmp/work", permissions: {} }),
    }, context());
    const permission = requestEvent(events, 1).request;
    await expect(broker.respond({
      kind: "permission",
      identity: permission.identity,
      permissions: ["workspace-write"],
    })).rejects.toMatchObject({ code: "UNSUPPORTED_PERMISSION_GRANT" });

    expect(broker.pendingCount).toBe(2);
    await broker.respond(response(input, { answers: { q1: "safe" } }));
    await broker.respond(response(permission));
    await Promise.all([inputHandling, permissionHandling]);
  });

  it("correlates serverRequest/resolved by generation, thread, and typed RPC id exactly once", async () => {
    const { broker, events } = setup();
    const handling = broker.handle(commandRequest(1), context());
    const resolved = broker.observeResolved({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 1 },
    }, context());

    expect(resolved).toMatchObject({ type: "request-resolved", identity: { requestId: 1 } });
    await expect(handling).rejects.toMatchObject({ code: "EXTERNAL_RESOLUTION" });
    expect(broker.observeResolved({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 1 },
    }, context())).toBeNull();
    expect(broker.observeResolved({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "1" },
    }, context())).toBeNull();
    expect(events.filter((event) => event.type === "request-resolved")).toHaveLength(1);
  });

  it("treats a provider resolution after local dispatch as an idempotent no-op", async () => {
    const { broker, events } = setup();
    const handling = broker.handle(commandRequest(), context());
    const pending = requestEvent(events).request;
    await broker.respond(response(pending));
    await handling;

    expect(broker.observeResolved({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 1 },
    }, context())).toBeNull();
    expect(events.filter((event) => event.type === "request-resolved")).toHaveLength(1);
  });

  it("bounds tombstones while keeping recent late responses stale", async () => {
    const { broker, events } = setup({ maxTombstones: 2 });
    for (let id = 1; id <= 3; id += 1) {
      const handling = broker.handle(commandRequest(id), context());
      const pending = requestEvent(events, id - 1).request;
      await broker.respond(response(pending));
      await handling;
    }
    expect(broker.tombstoneCount).toBe(2);
    const newest = requestEvent(events, 2).request;
    await expect(broker.respond(response(newest))).resolves.toBe("stale");
  });

  it("cancels only the selected generation and removes abort listeners", async () => {
    const { broker, events } = setup();
    const firstController = controller();
    const first = broker.handle(commandRequest(1), context(7, firstController.signal));
    const second = broker.handle(commandRequest(2), context(8));

    expect(broker.cancelGeneration("/tmp/devhub-codex-broker-home", 7)).toBe(1);
    await expect(first).rejects.toMatchObject({ code: "GENERATION_CANCELLED" });
    expect(broker.pendingCount).toBe(1);

    const remaining = requestEvent(events, 1).request;
    await broker.respond(response(remaining));
    await second;
    firstController.abort(new Error("late abort must be inert"));
    expect(broker.pendingCount).toBe(0);
  });

  it("cancels only the completed turn in the exact generation", async () => {
    const { broker, events } = setup();
    const first = broker.handle(commandRequest(1), context(7));
    const second = broker.handle({
      ...commandRequest(2),
      params: itemParams({ turnId: "turn-2", approvalId: "approval-2" }),
    }, context(7));
    const firstRequest = requestEvent(events, 0).request;
    const secondRequest = requestEvent(events, 1).request;

    expect(broker.cancelTurn(firstRequest.identity.key, "turn-1", 8)).toBe(0);
    expect(broker.cancelTurn(firstRequest.identity.key, "turn-1", 7)).toBe(1);
    await expect(first).rejects.toMatchObject({ code: "TURN_CANCELLED" });
    expect(broker.pendingCount).toBe(1);

    await broker.respond(response(secondRequest));
    await second;
  });

  it("fails closed and rolls back when timer scheduling or event delivery throws", async () => {
    const timerFailure = new CodexRequestBroker({
      emit: vi.fn(),
      setTimeoutFn: () => { throw new Error("timer-secret"); },
      clearTimeoutFn: vi.fn(),
      requestTimeoutMs: 1_000,
    });
    await expect(timerFailure.handle(commandRequest(), context())).rejects.toMatchObject({
      code: "TIMER_FAILURE",
    });
    expect(timerFailure.pendingCount).toBe(0);

    const emitFailure = new CodexRequestBroker({
      emit: () => { throw new Error("sink-secret"); },
      setTimeoutFn: vi.fn(() => 1),
      clearTimeoutFn: vi.fn(),
      requestTimeoutMs: 1_000,
    });
    await expect(emitFailure.handle(commandRequest(), context())).rejects.toMatchObject({
      code: "EVENT_DELIVERY_FAILED",
    });
    expect(emitFailure.pendingCount).toBe(0);
  });

  it("emits request resolution when the owner aborts synchronously during request delivery", async () => {
    const abortController = controller();
    const events: ProviderEvent[] = [];
    const timers = new ManualTimers();
    const broker = new CodexRequestBroker({
      emit: (event) => {
        events.push(event);
        if (event.type === "request") abortController.abort();
      },
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      requestTimeoutMs: 1_000,
    });

    await expect(broker.handle(commandRequest(), context(7, abortController.signal)))
      .rejects.toMatchObject({ code: "ABORTED" });
    expect(events.map((event) => event.type)).toEqual(["request", "request-resolved"]);
    expect(broker.pendingCount).toBe(0);
  });

  it("contains hostile response accessors and leaves the original request answerable", async () => {
    const { broker, events } = setup();
    const handling = broker.handle(commandRequest(), context());
    const pending = requestEvent(events).request;
    const hostile = {
      kind: "command-approval",
      identity: pending.identity,
      get decision(): never {
        throw new Error("response-accessor-secret");
      },
    } as unknown as ProviderRequestResponse;

    await expect(broker.respond(hostile)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: expect.not.stringContaining("response-accessor-secret"),
    });
    expect(broker.pendingCount).toBe(1);

    await broker.respond(response(pending));
    await handling;
  });

  it("handles a synchronously firing timeout without publishing a phantom request", async () => {
    const events: ProviderEvent[] = [];
    const broker = new CodexRequestBroker({
      emit: (event) => events.push(event),
      setTimeoutFn: (callback) => {
        callback();
        return 1;
      },
      clearTimeoutFn: vi.fn(),
      requestTimeoutMs: 1_000,
    });

    await expect(broker.handle(commandRequest(), context())).resolves.toEqual({ decision: "cancel" });
    expect(events).toEqual([]);
    expect(broker.pendingCount).toBe(0);
    expect(broker.observeResolved({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 1 },
    }, context())).toBeNull();
    expect(events).toEqual([]);
  });

  it("rejects malformed response identities without exposing pending ownership", async () => {
    const { broker, events } = setup();
    const handling = broker.handle(commandRequest(), context());
    const pending = requestEvent(events).request;
    const malformed = {
      ...pending.identity,
      generation: Number.NaN,
    } as unknown as ProviderRequestIdentity;

    await expect(broker.respond({
      kind: "command-approval",
      identity: malformed,
      decision: "allow",
    })).rejects.toBeInstanceOf(CodexRequestBrokerError);
    expect(broker.pendingCount).toBe(1);

    await broker.respond(response(pending));
    await handling;
  });
});
