import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONTROL_MAX_FRAME_BYTES,
  CLAUDE_CONTROL_MAX_JSON_ARRAY_ITEMS,
  CLAUDE_CONTROL_MAX_JSON_DEPTH,
  CLAUDE_CONTROL_MAX_JSON_OBJECT_KEYS,
  CLAUDE_CONTROL_MAX_PENDING_REQUESTS,
  CLAUDE_CONTROL_MAX_PERMISSION_SUGGESTIONS,
  ClaudeControlShapeError,
  buildClaudeControlErrorResponse,
  buildClaudeControlRequest,
  buildClaudeControlSuccessResponse,
  classifyClaudeControlEnvelope,
} from "../../src/providers/claude/protocol/control-shapes.js";

const exactCanUseTool = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "control_request",
  request_id: "request-allow-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "Write",
    input: {
      file_path: "/tmp/devhub-control-fixture.txt",
      content: "approved\n",
    },
    tool_use_id: "toolu_01controlfixture",
    permission_suggestions: [
      {
        type: "addRules",
        behavior: "allow",
        destination: "session",
        rules: [{ toolName: "Write", ruleContent: "/tmp/devhub-control-fixture.txt" }],
      },
    ],
  },
  ...overrides,
});

const exactUnknownRequest = (requestId = "request-future-1"): Record<string, unknown> => ({
  type: "control_request",
  request_id: requestId,
  request: {
    subtype: "future_dialog",
    callback_id: "callback-1",
    server_name: "future-server",
    future_payload: { values: [1, true, null] },
  },
});

describe("Claude control wire shapes", () => {
  it("parses the exact installed can_use_tool control request", () => {
    const parsed = classifyClaudeControlEnvelope(exactCanUseTool());

    expect(parsed.kind).toBe("control-request");
    if (parsed.kind !== "control-request") throw new Error("expected control request");
    expect(parsed.requestId).toBe("request-allow-1");
    expect(parsed.request.kind).toBe("can-use-tool");
    if (parsed.request.kind !== "can-use-tool") throw new Error("expected can_use_tool");
    expect(parsed.request).toMatchObject({
      subtype: "can_use_tool",
      toolName: "Write",
      toolUseId: "toolu_01controlfixture",
      input: {
        file_path: "/tmp/devhub-control-fixture.txt",
        content: "approved\n",
      },
    });
    expect(parsed.request.permissionSuggestions).toEqual([
      {
        type: "addRules",
        behavior: "allow",
        destination: "session",
        rules: [{ toolName: "Write", ruleContent: "/tmp/devhub-control-fixture.txt" }],
      },
    ]);
    expect(parsed.raw).toEqual(exactCanUseTool());
  });

  it("type-checks and retains the optional 0.3.207 can_use_tool fields", () => {
    const frame = exactCanUseTool();
    frame.request = {
      ...(frame.request as Record<string, unknown>),
      blocked_path: "/tmp/blocked.txt",
      decision_reason: "A human decision is required",
      decision_reason_type: "rule",
      classifier_approvable: false,
      title: "Write a fixture",
      display_name: "Write",
      description: "Creates the requested fixture",
      agent_id: "agent-1",
      requires_user_interaction: true,
      future_0_3_208_field: { retained: true },
    };

    const parsed = classifyClaudeControlEnvelope(frame);
    if (parsed.kind !== "control-request" || parsed.request.kind !== "can-use-tool") {
      throw new Error("expected can_use_tool");
    }

    expect(parsed.request).toMatchObject({
      blockedPath: "/tmp/blocked.txt",
      decisionReason: "A human decision is required",
      decisionReasonType: "rule",
      classifierApprovable: false,
      title: "Write a fixture",
      displayName: "Write",
      description: "Creates the requested fixture",
      agentId: "agent-1",
      requiresUserInteraction: true,
    });
    expect(parsed.request.raw.future_0_3_208_field).toEqual({ retained: true });
  });

  it("preserves future can_use_tool fields without imposing speculative schemas", () => {
    const frame = exactCanUseTool();
    frame.request = {
      ...(frame.request as Record<string, unknown>),
      server: { url: "https://future.example.test" },
      callback_id: { opaque: true },
    };

    const parsed = classifyClaudeControlEnvelope(frame);
    if (parsed.kind !== "control-request" || parsed.request.kind !== "can-use-tool") {
      throw new Error("expected can_use_tool");
    }

    expect(parsed.request.raw.server).toEqual({ url: "https://future.example.test" });
    expect(parsed.request.raw.callback_id).toEqual({ opaque: true });
  });

  it("classifies non-control envelopes without losing or aliasing their raw object", () => {
    const source = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    };
    const parsed = classifyClaudeControlEnvelope(source);
    source.message.content[0]!.text = "mutated";

    expect(parsed.kind).toBe("not-control");
    expect(parsed.raw).toEqual({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(Object.isFrozen(parsed.raw)).toBe(true);
    expect(Object.isFrozen(parsed.raw.message)).toBe(true);
  });

  it("keeps unknown inner subtypes explicitly unsupported and preserves their raw keys", () => {
    const parsed = classifyClaudeControlEnvelope(exactUnknownRequest());

    if (parsed.kind !== "control-request") throw new Error("expected control request");
    expect(parsed.request).toEqual({
      kind: "unknown",
      subtype: "future_dialog",
      raw: {
        subtype: "future_dialog",
        callback_id: "callback-1",
        server_name: "future-server",
        future_payload: { values: [1, true, null] },
      },
    });
  });

  it("treats unknown subtype fields as opaque bounded JSON", () => {
    const request = {
      subtype: "future_transport_request",
      server: { url: "https://future.example.test" },
      tool_name: { structured: true },
      callback_id: 42,
    };
    const parsed = classifyClaudeControlEnvelope({
      type: "control_request",
      request_id: "future-request-1",
      request,
    });

    if (parsed.kind !== "control-request") throw new Error("expected control request");
    expect(parsed.request).toEqual({
      kind: "unknown",
      subtype: "future_transport_request",
      raw: request,
    });
  });

  it("parses exact interrupt and cancel frames", () => {
    const interrupt = classifyClaudeControlEnvelope({
      type: "control_request",
      request_id: "interrupt-1",
      request: { subtype: "interrupt" },
    });
    const cancel = classifyClaudeControlEnvelope({
      type: "control_cancel_request",
      request_id: "cancel-1",
    });

    if (interrupt.kind !== "control-request") throw new Error("expected control request");
    expect(interrupt.request).toEqual({
      kind: "interrupt",
      subtype: "interrupt",
      raw: { subtype: "interrupt" },
    });
    expect(cancel).toMatchObject({ kind: "control-cancel-request", requestId: "cancel-1" });
    expect(cancel.raw).toEqual({ type: "control_cancel_request", request_id: "cancel-1" });
  });

  it("parses exact nested success and error response frames", () => {
    const success = classifyClaudeControlEnvelope({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-1",
        response: { behavior: "allow", updatedInput: { path: "/tmp/safe" } },
      },
    });
    const error = classifyClaudeControlEnvelope({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "request-2",
        error: "unsupported control request",
      },
    });

    if (success.kind !== "control-response" || error.kind !== "control-response") {
      throw new Error("expected control responses");
    }
    expect(success.response).toEqual({
      kind: "success",
      requestId: "request-1",
      response: { behavior: "allow", updatedInput: { path: "/tmp/safe" } },
    });
    expect(error.response).toEqual({
      kind: "error",
      requestId: "request-2",
      error: "unsupported control request",
    });
  });

  it("validates pending replay arrays recursively and preserves duplicates", () => {
    const replay = exactUnknownRequest("replayed-1");
    const parsed = classifyClaudeControlEnvelope({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-with-replay",
        pending_permission_requests: [replay, replay],
        pending_user_dialog_requests: [exactCanUseTool({ request_id: "dialog-1" })],
      },
    });

    if (parsed.kind !== "control-response" || parsed.response.kind !== "success") {
      throw new Error("expected success response");
    }
    expect(parsed.response.pendingPermissionRequests).toHaveLength(2);
    expect(parsed.response.pendingPermissionRequests?.map((request) => request.requestId))
      .toEqual(["replayed-1", "replayed-1"]);
    expect(parsed.response.pendingUserDialogRequests?.[0]?.request.kind).toBe("can-use-tool");
  });

  it("snapshots and freezes parsed control values against caller mutation", () => {
    const source = exactCanUseTool();
    const sourceRequest = source.request as Record<string, unknown>;
    const sourceInput = sourceRequest.input as Record<string, unknown>;
    const parsed = classifyClaudeControlEnvelope(source);

    source.request_id = "mutated-id";
    sourceRequest.tool_name = "Bash";
    sourceInput.file_path = "/tmp/mutated";

    if (parsed.kind !== "control-request" || parsed.request.kind !== "can-use-tool") {
      throw new Error("expected can_use_tool");
    }
    expect(parsed.requestId).toBe("request-allow-1");
    expect(parsed.request.toolName).toBe("Write");
    expect(parsed.request.input.file_path).toBe("/tmp/devhub-control-fixture.txt");
    expect(Object.isFrozen(parsed.raw)).toBe(true);
    expect(Object.isFrozen(parsed.request.input)).toBe(true);
    expect(Object.isFrozen(parsed.request.permissionSuggestions)).toBe(true);
  });

  it.each([
    "",
    " request-1",
    "request-1 ",
    "request\u0000-1",
    "x".repeat(513),
    42,
  ])("rejects invalid string-only request identifiers", (requestId) => {
    expect(() => classifyClaudeControlEnvelope({
      type: "control_cancel_request",
      request_id: requestId,
    })).toThrow(ClaudeControlShapeError);
  });

  it.each([
    { type: "control_request", request: { subtype: "interrupt" } },
    { type: "control_request", request_id: "request-1", request: [] },
    {
      type: "control_request",
      request_id: "request-1",
      request: { subtype: "interrupt", unexpected: true },
    },
    { type: "control_cancel_request", request_id: "request-1", extra: true },
    { type: "control_future", request_id: "request-1" },
  ])("fails closed for malformed control-like frames", (frame) => {
    expect(() => classifyClaudeControlEnvelope(frame)).toThrow(ClaudeControlShapeError);
  });

  it.each([
    {
      type: "control_response",
      subtype: "success",
      request_id: "request-1",
      response: { ok: true },
    },
    { type: "control_response", response: [] },
    {
      type: "control_response",
      response: { subtype: "success", request_id: "request-1", error: "wrong lane" },
    },
    {
      type: "control_response",
      response: { subtype: "error", request_id: "request-1", error: "no", response: {} },
    },
    {
      type: "control_response",
      response: { subtype: "future", request_id: "request-1" },
    },
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-1",
        pending_permission_requests: [{ type: "control_cancel_request", request_id: "x" }],
      },
    },
  ])("rejects invalid response nesting and replay shapes", (frame) => {
    expect(() => classifyClaudeControlEnvelope(frame)).toThrow(ClaudeControlShapeError);
  });

  it("strictly validates required and optional can_use_tool fields", () => {
    const invalidRequests = [
      { subtype: "can_use_tool", input: {}, tool_use_id: "toolu-1" },
      { subtype: "can_use_tool", tool_name: "Write", input: [], tool_use_id: "toolu-1" },
      { subtype: "can_use_tool", tool_name: "Write", input: {}, tool_use_id: 1 },
      {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: {},
        tool_use_id: "toolu-1",
        permission_suggestions: {},
      },
      {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: {},
        tool_use_id: "toolu-1",
        requires_user_interaction: "yes",
      },
      {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: {},
        tool_use_id: "toolu-1",
        classifier_approvable: 1,
      },
      {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: {},
        tool_use_id: "toolu-1",
        decision_reason_type: "not-an-official-reason",
      },
    ];

    for (const request of invalidRequests) {
      expect(() => classifyClaudeControlEnvelope({
        type: "control_request",
        request_id: "request-1",
        request,
      })).toThrow(ClaudeControlShapeError);
    }
  });

  it("bounds permission suggestions and pending replay counts", () => {
    const tooManySuggestions = Array.from(
      { length: CLAUDE_CONTROL_MAX_PERMISSION_SUGGESTIONS + 1 },
      () => ({}),
    );
    const tooManyPending = Array.from(
      { length: CLAUDE_CONTROL_MAX_PENDING_REQUESTS + 1 },
      (_, index) => exactUnknownRequest(`replay-${index}`),
    );

    expect(() => classifyClaudeControlEnvelope(exactCanUseTool({
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: {},
        tool_use_id: "toolu-1",
        permission_suggestions: tooManySuggestions,
      },
    }))).toThrow(ClaudeControlShapeError);
    expect(() => classifyClaudeControlEnvelope({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-1",
        pending_permission_requests: tooManyPending,
      },
    })).toThrow(ClaudeControlShapeError);
  });

  it("enforces JSON depth, array, and object-key bounds", () => {
    const deepRoot: Record<string, unknown> = {};
    let cursor = deepRoot;
    for (let depth = 0; depth < CLAUDE_CONTROL_MAX_JSON_DEPTH + 2; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const tooWide = Object.fromEntries(Array.from(
      { length: CLAUDE_CONTROL_MAX_JSON_OBJECT_KEYS + 1 },
      (_, index) => [`key-${index}`, index],
    ));

    expect(() => classifyClaudeControlEnvelope({ type: "assistant", deepRoot }))
      .toThrow(ClaudeControlShapeError);
    expect(() => classifyClaudeControlEnvelope({
      type: "assistant",
      values: Array.from({ length: CLAUDE_CONTROL_MAX_JSON_ARRAY_ITEMS + 1 }, () => null),
    })).toThrow(ClaudeControlShapeError);
    expect(() => classifyClaudeControlEnvelope({ type: "assistant", tooWide }))
      .toThrow(ClaudeControlShapeError);
  });

  it("rejects oversized object keys before traversing their bytes", () => {
    const oversizedKey = "k".repeat(CLAUDE_CONTROL_MAX_FRAME_BYTES + 1);
    const originalCharCodeAt = String.prototype.charCodeAt;
    const charCodeAtSpy = vi.spyOn(String.prototype, "charCodeAt").mockImplementation(
      function guardedCharCodeAt(this: string, index: number): number {
        const value = String(this);
        if (value.length > CLAUDE_CONTROL_MAX_FRAME_BYTES) {
          throw new Error("oversized-key-byte-scan-must-not-run");
        }
        return originalCharCodeAt.call(value, index);
      },
    );
    let thrown: unknown;
    try {
      classifyClaudeControlEnvelope({ [oversizedKey]: true, type: "assistant" });
    } catch (error) {
      thrown = error;
    } finally {
      charCodeAtSpy.mockRestore();
    }

    expect(thrown).toBeInstanceOf(ClaudeControlShapeError);
    expect((thrown as ClaudeControlShapeError).field).toBe("$frame.$size");
    expect(String(thrown)).not.toContain("oversized-key-byte-scan-must-not-run");
    expect(charCodeAtSpy).not.toHaveBeenCalled();
  });

  it("emits exact snake_case request, success, and error wire objects", () => {
    expect(buildClaudeControlRequest("interrupt-1", { subtype: "interrupt" })).toEqual({
      type: "control_request",
      request_id: "interrupt-1",
      request: { subtype: "interrupt" },
    });
    expect(buildClaudeControlSuccessResponse("request-1", {
      response: { behavior: "allow", updatedInput: { path: "/tmp/safe" } },
      pending_permission_requests: [exactUnknownRequest("pending-1")],
    })).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-1",
        response: { behavior: "allow", updatedInput: { path: "/tmp/safe" } },
        pending_permission_requests: [exactUnknownRequest("pending-1")],
      },
    });
    expect(buildClaudeControlErrorResponse("request-2", "unsupported control request")).toEqual({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "request-2",
        error: "unsupported control request",
      },
    });
  });

  it("treats explicit undefined builder options exactly like omitted options", () => {
    expect(buildClaudeControlSuccessResponse("request-success", undefined)).toEqual(
      buildClaudeControlSuccessResponse("request-success"),
    );
    expect(buildClaudeControlErrorResponse("request-error", "unsupported", undefined)).toEqual(
      buildClaudeControlErrorResponse("request-error", "unsupported"),
    );
  });

  it("snapshots and freezes builder inputs", () => {
    const request = { subtype: "future_request", payload: { value: 1 } };
    const built = buildClaudeControlRequest("request-1", request);
    request.payload.value = 2;

    expect(built.request).toEqual({ subtype: "future_request", payload: { value: 1 } });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.request)).toBe(true);
    expect(Object.isFrozen(built.request.payload)).toBe(true);
  });

  it("rejects malformed, undefined, non-finite, functional, bigint, and circular builder input", () => {
    const circular: Record<string, unknown> = { subtype: "future_request" };
    circular.self = circular;

    const invalidBuilds: Array<() => unknown> = [
      () => buildClaudeControlRequest("request-1", { subtype: "can_use_tool" }),
      () => buildClaudeControlRequest("request-1", {
        subtype: "future_request",
        payload: { value: undefined },
      }),
      () => buildClaudeControlRequest("request-1", {
        subtype: "future_request",
        payload: { value: Number.POSITIVE_INFINITY },
      }),
      () => buildClaudeControlRequest("request-1", {
        subtype: "future_request",
        payload: { value: () => undefined },
      }),
      () => buildClaudeControlRequest("request-1", {
        subtype: "future_request",
        payload: { value: BigInt(1) },
      }),
      () => buildClaudeControlRequest("request-1", circular),
      () => buildClaudeControlSuccessResponse("request-1", { response: undefined }),
      () => buildClaudeControlSuccessResponse("request-1", { response: [] }),
      () => buildClaudeControlErrorResponse("request-1", ""),
    ];

    for (const build of invalidBuilds) {
      expect(build).toThrow(ClaudeControlShapeError);
    }
  });

  it("uses typed value-free errors that do not reflect secrets or hostile keys", () => {
    const secret = "sk-ant-api03-super-secret-value";
    let thrown: unknown;
    try {
      classifyClaudeControlEnvelope({
        type: "control_request",
        request_id: secret,
        request: { subtype: "interrupt", [secret]: true },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaudeControlShapeError);
    expect((thrown as ClaudeControlShapeError).code).toBe("INVALID_CONTROL_SHAPE");
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(secret);
    expect((thrown as ClaudeControlShapeError).field).not.toContain(secret);
  });

  it("rejects exotic prototypes and accessors at the JSON boundary", () => {
    const exotic = Object.create({ inherited: true }) as Record<string, unknown>;
    exotic.type = "assistant";
    const accessor: Record<string, unknown> = { type: "assistant" };
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => "not evaluated",
    });

    expect(() => classifyClaudeControlEnvelope(exotic)).toThrow(ClaudeControlShapeError);
    expect(() => classifyClaudeControlEnvelope(accessor)).toThrow(ClaudeControlShapeError);
  });

  it("sanitizes foreign exceptions that impersonate a control shape error", () => {
    const secret = "sk-ant-api03-proxy-trap-secret";
    const hostile = new Proxy({ type: "assistant" }, {
      getPrototypeOf: () => {
        throw new ClaudeControlShapeError(secret);
      },
    });
    let thrown: unknown;
    try {
      classifyClaudeControlEnvelope(hostile);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaudeControlShapeError);
    expect(String(thrown)).not.toContain(secret);
    expect((thrown as ClaudeControlShapeError).field).not.toContain(secret);
  });

  it("sanitizes hostile thrown proxies without inspecting their prototype", () => {
    const secret = "secret-from-thrown-proxy-prototype";
    const hostileThrownValue = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error(secret);
      },
    });
    const hostileFrame = new Proxy({ type: "assistant" }, {
      getPrototypeOf: () => {
        throw hostileThrownValue;
      },
    });
    let thrown: unknown;
    try {
      classifyClaudeControlEnvelope(hostileFrame);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaudeControlShapeError);
    expect(String(thrown)).not.toContain(secret);
    expect((thrown as ClaudeControlShapeError).field).toBe("$frame.$json");
  });
});
