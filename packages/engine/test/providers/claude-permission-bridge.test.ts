import { describe, expect, it, vi } from "vitest";
import { normalizeProviderEvent } from "../../src/providers/events.js";
import {
  CLAUDE_PERMISSION_DENY_MESSAGE,
  ClaudePermissionBridge,
  ClaudePermissionBridgeError,
  type ClaudePermissionDiagnostic,
} from "../../src/providers/claude/permission-bridge.js";
import {
  ClaudeControlPeer,
  type ClaudeInboundControlContext,
} from "../../src/providers/claude/control-peer.js";
import {
  classifyClaudeControlEnvelope,
  type ClaudeParsedControlRequest,
} from "../../src/providers/claude/protocol/control-shapes.js";

const HOME = "/canonical/claude-home";
const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TURN = "turn-1";
const OCCURRED_AT = "2026-07-13T16:00:00.000Z";

const flushMicrotasks = async (turns = 8): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};

const context = (signal = new AbortController().signal): ClaudeInboundControlContext =>
  Object.freeze({ signal, home: HOME, sessionId: SESSION, generation: 4 });

const parsedRequest = (
  requestId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): ClaudeParsedControlRequest => {
  const classified = classifyClaudeControlEnvelope({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      input: { file_path: "/private/project/file.ts", content: "secret source" },
      tool_use_id: `tool-${requestId}`,
      ...overrides,
    },
  });
  if (classified.kind !== "control-request") throw new Error("expected control request");
  return classified;
};

const parsedInner = (
  requestId: string,
  request: Readonly<Record<string, unknown>>,
): ClaudeParsedControlRequest => {
  const classified = classifyClaudeControlEnvelope({
    type: "control_request",
    request_id: requestId,
    request,
  });
  if (classified.kind !== "control-request") throw new Error("expected control request");
  return classified;
};

const exactDeny = (toolUseID?: string) => ({
  kind: "success",
  response: {
    behavior: "deny",
    message: CLAUDE_PERMISSION_DENY_MESSAGE,
    interrupt: false,
    ...(toolUseID === undefined ? {} : { toolUseID }),
  },
});

describe("ClaudePermissionBridge", () => {
  it("emits only a frozen identity request and echoes the retained input identity on allow", async () => {
    const events: unknown[] = [];
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
      now: () => OCCURRED_AT,
    });
    const request = parsedRequest("permission-1");
    if (request.request.kind !== "can-use-tool") throw new Error("expected can-use-tool");
    const originalInput = request.request.input;

    const pending = bridge.handleControl(request, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "request",
      provider: "anthropic",
      key: { provider: "anthropic", home: HOME, nativeTaskId: SESSION },
      occurredAt: OCCURRED_AT,
      request: {
        kind: "file-change-approval",
        identity: {
          key: { provider: "anthropic", home: HOME, nativeTaskId: SESSION },
          generation: 4,
          turnId: TURN,
          requestId: "permission-1",
          itemId: "tool-permission-1",
          approvalId: null,
        },
      },
    });
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(JSON.stringify(events[0])).not.toContain("file.ts");
    expect(JSON.stringify(events[0])).not.toContain("secret source");

    const identity = (events[0] as {
      request: { identity: Readonly<Record<string, unknown>> };
    }).request.identity;
    await expect(bridge.respond({
      kind: "file-change-approval",
      identity,
      decision: "allow",
    })).resolves.toBe("dispatched");
    const result = await pending;
    expect(result).toEqual({
      kind: "success",
      response: { behavior: "allow", updatedInput: originalInput },
    });
    if (result.kind !== "success" || !result.response) throw new Error("expected success");
    expect(result.response.updatedInput).toBe(originalInput);
    expect(Object.keys(result.response)).toEqual(["behavior", "updatedInput"]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "request-resolved", identity });
  });

  it("exports a fixed denial message", () => {
    expect(CLAUDE_PERMISSION_DENY_MESSAGE).toBe("Claude tool request denied by DevHub");
  });

  it.each([
    ["other tool", parsedRequest("deny-tool", { tool_name: "Read" }), "tool-deny-tool"],
    [
      "explicit user interaction",
      parsedRequest("deny-interaction", { requires_user_interaction: true }),
      "tool-deny-interaction",
    ],
    ["unknown subtype", parsedInner("deny-unknown", { subtype: "future_control" }), undefined],
    ["interrupt", parsedInner("deny-interrupt", { subtype: "interrupt" }), undefined],
  ])("immediately denies %s without emitting browser-visible provider data", async (
    _label,
    request,
    toolUseID,
  ) => {
    const emit = vi.fn();
    const bridge = new ClaudePermissionBridge({ emit, activeTurnId: () => TURN });
    const result = await bridge.handleControl(request, context());
    expect(result).toEqual(exactDeny(toolUseID));
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.kind === "success" && Object.isFrozen(result.response)).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("denies missing turn, capacity, terminal exhaustion, close, and event failure", async () => {
    const missing = new ClaudePermissionBridge({ emit: vi.fn(), activeTurnId: () => null });
    expect(await missing.handleControl(parsedRequest("missing-turn"), context()))
      .toEqual(exactDeny("tool-missing-turn"));

    const firstEvents: unknown[] = [];
    const bounded = new ClaudePermissionBridge({
      emit: (event) => firstEvents.push(event),
      activeTurnId: () => TURN,
      maxPendingRequests: 1,
      maxTombstones: 1,
    });
    const first = bounded.handleControl(parsedRequest("bounded-1"), context());
    expect(await bounded.handleControl(parsedRequest("bounded-2"), context()))
      .toEqual(exactDeny("tool-bounded-2"));
    const identity = (firstEvents[0] as { request: { identity: unknown } }).request.identity;
    await expect(bounded.respond({
      kind: "file-change-approval",
      identity,
      decision: "deny",
    })).resolves.toBe("dispatched");
    await first;
    expect(await bounded.handleControl(parsedRequest("bounded-3"), context()))
      .toEqual(exactDeny("tool-bounded-3"));

    bounded.close();
    expect(await bounded.handleControl(parsedRequest("closed"), context()))
      .toEqual(exactDeny("tool-closed"));

    const secret = "event-sink-secret";
    const failed = new ClaudePermissionBridge({
      emit: () => {
        throw new Error(secret);
      },
      activeTurnId: () => TURN,
    });
    expect(await failed.handleControl(parsedRequest("emit-failed"), context()))
      .toEqual(exactDeny("tool-emit-failed"));
    expect(failed.pendingCount).toBe(0);
  });

  it.each(["deny", "cancel"] as const)(
    "maps a browser %s decision to the exact denial and emits one resolution",
    async (decision) => {
      const events: unknown[] = [];
      const bridge = new ClaudePermissionBridge({
        emit: (event) => events.push(event),
        activeTurnId: () => TURN,
      });
      const pending = bridge.handleControl(parsedRequest(`browser-${decision}`), context());
      const identity = (events[0] as { request: { identity: unknown } }).request.identity;
      await expect(bridge.respond({
        kind: "file-change-approval",
        identity,
        decision,
      })).resolves.toBe("dispatched");
      await expect(pending).resolves.toEqual(exactDeny(`tool-browser-${decision}`));
      expect(events.filter((event) =>
        (event as { type?: unknown }).type === "request-resolved")).toHaveLength(1);
      await expect(bridge.respond({
        kind: "file-change-approval",
        identity,
        decision,
      })).resolves.toBe("stale");
      expect(events).toHaveLength(2);
    },
  );

  it("rejects hostile or overpowered browser responses while leaving the request pending", async () => {
    const events: unknown[] = [];
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
    });
    const pending = bridge.handleControl(parsedRequest("validate-response"), context());
    const identity = (events[0] as { request: { identity: Record<string, unknown> } }).request.identity;
    const valid = {
      kind: "file-change-approval",
      identity,
      decision: "deny",
    };
    const foreignIdentity = {
      ...identity,
      key: { ...(identity.key as Record<string, unknown>), nativeTaskId: "other-session" },
    };
    const accessor = Object.defineProperty({}, "kind", {
      enumerable: true,
      get: () => "file-change-approval",
    });
    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("proxy-secret");
      },
    });
    for (const response of [
      { ...valid, scope: "always" },
      { ...valid, message: "override" },
      { ...valid, updatedInput: {} },
      { ...valid, updatedPermissions: [] },
      { ...valid, identity: foreignIdentity },
      Object.assign(Object.create({}), valid),
      accessor,
      hostile,
    ]) {
      await expect(bridge.respond(response)).rejects.toBeInstanceOf(ClaudePermissionBridgeError);
      expect(bridge.pendingCount).toBe(1);
    }
    await expect(bridge.respond(valid)).resolves.toBe("dispatched");
    await expect(pending).resolves.toEqual(exactDeny("tool-validate-response"));
  });

  it("rejects a normalizing identity alias instead of approving its canonical match", async () => {
    const events: unknown[] = [];
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
    });
    const pending = bridge.handleControl(parsedRequest("exact-identity"), context());
    const identity = (events[0] as {
      request: { identity: Record<string, unknown> };
    }).request.identity;

    await expect(bridge.respond({
      kind: "file-change-approval",
      identity: { ...identity, turnId: ` ${String(identity.turnId)}` },
      decision: "allow",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(bridge.pendingCount).toBe(1);

    await expect(bridge.respond({
      kind: "file-change-approval",
      identity,
      decision: "deny",
    })).resolves.toBe("dispatched");
    await expect(pending).resolves.toEqual(exactDeny("tool-exact-identity"));
  });

  it("does not emit an orphan resolution when initial request delivery throws", async () => {
    const eventTypes: string[] = [];
    const bridge = new ClaudePermissionBridge({
      emit: (event) => {
        eventTypes.push(event.type);
        throw new Error("fail-first-sink-secret");
      },
      activeTurnId: () => TURN,
    });

    await expect(bridge.handleControl(parsedRequest("fail-first"), context()))
      .resolves.toEqual(exactDeny("tool-fail-first"));
    expect(eventTypes).toEqual(["request"]);
    expect(bridge.pendingCount).toBe(0);
  });

  it("overrides a reentrant allow when request delivery subsequently throws", async () => {
    let bridge!: ClaudePermissionBridge;
    let browserDispatch: Promise<unknown> | undefined;
    bridge = new ClaudePermissionBridge({
      emit: (event) => {
        if (event.type !== "request") return;
        browserDispatch = bridge.respond({
          kind: "file-change-approval",
          identity: event.request.identity,
          decision: "allow",
        });
        throw new Error("allow-then-throw-secret");
      },
      activeTurnId: () => TURN,
    });

    await expect(bridge.handleControl(parsedRequest("reentrant-allow"), context()))
      .resolves.toEqual(exactDeny("tool-reentrant-allow"));
    await expect(browserDispatch).resolves.toBe("dispatched");
    expect(bridge.pendingCount).toBe(0);
  });

  it("settles fail-closed when resolution normalization throws", async () => {
    const secret = "resolution-normalizer-secret";
    const events: unknown[] = [];
    const diagnostics: ClaudePermissionDiagnostic[] = [];
    let normalizationCalls = 0;
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      normalizeEvent: (input, eventContext) => {
        normalizationCalls += 1;
        if (normalizationCalls === 2) throw new Error(secret);
        return normalizeProviderEvent(input, eventContext);
      },
    });
    const pending = bridge.handleControl(parsedRequest("resolution-normalizer"), context());
    const identity = (events[0] as { request: { identity: unknown } }).request.identity;

    await expect(bridge.respond({
      kind: "file-change-approval",
      identity,
      decision: "deny",
    })).resolves.toBe("dispatched");
    await expect(pending).resolves.toEqual(exactDeny("tool-resolution-normalizer"));
    expect(normalizationCalls).toBe(2);
    expect(events.map((event) => (event as { type: string }).type)).toEqual(["request"]);
    expect(diagnostics.map(({ code }) => code)).toContain("EVENT_DELIVERY_FAILED");
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it("keeps all ledgers empty when close reenters request delivery", async () => {
    let bridge!: ClaudePermissionBridge;
    bridge = new ClaudePermissionBridge({
      emit: (event) => {
        if (event.type === "request") bridge.close();
      },
      activeTurnId: () => TURN,
    });

    await expect(bridge.handleControl(parsedRequest("reentrant-close"), context()))
      .resolves.toEqual(exactDeny("tool-reentrant-close"));
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.tombstoneCount).toBe(0);
  });

  it("supports exact-case Edit and closes a pending request fail-closed", async () => {
    const events: unknown[] = [];
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
    });
    const pending = bridge.handleControl(parsedRequest("edit-close", {
      tool_name: "Edit",
    }), context());
    expect(events[0]).toMatchObject({
      type: "request",
      request: { kind: "file-change-approval" },
    });

    bridge.close();
    await expect(pending).resolves.toEqual(exactDeny("tool-edit-close"));
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.tombstoneCount).toBe(0);
    expect(await bridge.handleControl(parsedRequest("post-close", {
      tool_name: "edit",
    }), context())).toEqual(exactDeny("tool-post-close"));
  });

  it("composes with peer cancellation without writing any control response", async () => {
    const events: unknown[] = [];
    const sent: unknown[] = [];
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
    });
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION,
      generation: 4,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: bridge.handleControl,
      createInboundTimeoutResult: bridge.createTimeoutResult,
      sendEnvelope: async (envelope) => {
        sent.push(envelope);
      },
    });

    const request = parsedRequest("peer-cancel-wire");
    peer.receive(request.raw);
    await flushMicrotasks();
    expect(bridge.pendingCount).toBe(1);
    expect(peer.receive({
      type: "control_cancel_request",
      request_id: "peer-cancel-wire",
    })).toBe(true);
    await flushMicrotasks();

    expect(sent).toHaveLength(0);
    expect(bridge.pendingCount).toBe(0);
    expect(events.map((event) => (event as { type: string }).type))
      .toEqual(["request", "request-resolved"]);
  });

  it("composes with the peer deadline to write one exact denial", async () => {
    const events: unknown[] = [];
    const sent: unknown[] = [];
    let deadline: (() => void) | undefined;
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
    });
    const peer = new ClaudeControlPeer({
      configHome: HOME,
      sessionId: SESSION,
      generation: 4,
      canonicalizeHome: (home) => home,
      requestIdFactory: () => "outbound-unused",
      handleInboundControl: bridge.handleControl,
      createInboundTimeoutResult: bridge.createTimeoutResult,
      setTimeoutFn: (callback) => {
        deadline = callback;
        return Object.freeze({});
      },
      clearTimeoutFn: () => undefined,
      sendEnvelope: async (envelope) => {
        sent.push(envelope);
      },
    });

    peer.receive(parsedRequest("peer-timeout-wire").raw);
    await flushMicrotasks();
    expect(bridge.pendingCount).toBe(1);
    deadline?.();
    await flushMicrotasks();

    expect(sent).toEqual([{
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "peer-timeout-wire",
        response: exactDeny("tool-peer-timeout-wire").response,
      },
    }]);
    expect(bridge.pendingCount).toBe(0);
    expect(events.map((event) => (event as { type: string }).type))
      .toEqual(["request", "request-resolved"]);
  });

  it("lets peer abort own cancellation and makes the late browser response stale", async () => {
    const controller = new AbortController();
    const events: unknown[] = [];
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
    });
    const pending = bridge.handleControl(parsedRequest("provider-cancel"), context(controller.signal));
    const identity = (events[0] as { request: { identity: unknown } }).request.identity;
    controller.abort();

    await expect(pending).resolves.toEqual(exactDeny("tool-provider-cancel"));
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.tombstoneCount).toBe(1);
    expect(events.filter((event) =>
      (event as { type?: unknown }).type === "request-resolved")).toHaveLength(1);
    await expect(bridge.respond({
      kind: "file-change-approval",
      identity,
      decision: "allow",
    })).resolves.toBe("stale");
  });

  it("uses the synchronous peer-timeout factory to tombstone pending state", async () => {
    const events: unknown[] = [];
    const diagnostics: ClaudePermissionDiagnostic[] = [];
    const bridge = new ClaudePermissionBridge({
      emit: (event) => events.push(event),
      activeTurnId: () => TURN,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const request = parsedRequest("peer-timeout");
    const peerContext = context();
    const pending = bridge.handleControl(request, peerContext);
    const identity = (events[0] as { request: { identity: unknown } }).request.identity;

    const timeoutResult = bridge.createTimeoutResult(request, peerContext);
    expect(timeoutResult).toEqual(exactDeny("tool-peer-timeout"));
    await expect(pending).resolves.toEqual(exactDeny("tool-peer-timeout"));
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.tombstoneCount).toBe(1);
    await expect(bridge.respond({
      kind: "file-change-approval",
      identity,
      decision: "allow",
    })).resolves.toBe("stale");
    expect(diagnostics.every((diagnostic) => Object.isFrozen(diagnostic))).toBe(true);
  });
});
