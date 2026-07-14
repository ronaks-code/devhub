import { describe, expect, it } from "vitest";
import {
  AUTO_RESOLUTION_MAX_MS,
  AUTO_RESOLUTION_MIN_MS,
  MAX_PROVIDER_USAGE_COUNT,
  normalizeProviderEvent,
  timeoutResponseForRequest,
  type ProviderRequest,
} from "../../src/providers/events.js";
import { createProviderRequestIdentity } from "../../src/providers/request-identity.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";

const key = createNativeTaskKey("openai", "/tmp/codex-home", "task-1");
const context = { provider: "openai" as const, key, occurredAt: "2026-07-13T00:00:00.000Z" };
const identity = createProviderRequestIdentity({
  key,
  generation: 7,
  turnId: "turn-1",
  requestId: "request-1",
  itemId: "item-1",
  approvalId: "approval-1",
});

describe("provider event normalization", () => {
  it("normalizes a known message into the safe provider-neutral union", () => {
    const event = normalizeProviderEvent(
      {
        type: "message",
        role: "assistant",
        text: "done",
        turnId: "turn-1",
        itemId: "item-1",
      },
      context,
    );

    expect(event).toEqual({
      type: "message",
      provider: "openai",
      key,
      occurredAt: "2026-07-13T00:00:00.000Z",
      role: "assistant",
      text: "done",
      turnId: "turn-1",
      itemId: "item-1",
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.key)).toBe(true);
  });

  it("preserves a null item id for legacy complete messages", () => {
    expect(normalizeProviderEvent({
      type: "message",
      role: "assistant",
      text: "legacy",
      turnId: "legacy-history",
      itemId: null,
    }, context)).toMatchObject({
      type: "message",
      turnId: "legacy-history",
      itemId: null,
    });
  });

  it("diagnoses an invalid complete-message item id", () => {
    expect(normalizeProviderEvent({
      type: "message",
      role: "assistant",
      text: "unsafe",
      turnId: "turn-1",
      itemId: "   ",
    }, context)).toMatchObject({
      type: "diagnostic",
      code: "INVALID_PROVIDER_EVENT",
    });
  });

  it("normalizes browser-safe message deltas without copying extra payload fields", () => {
    const event = normalizeProviderEvent({
      type: "message-delta",
      role: "assistant",
      delta: "hello",
      turnId: "turn-1",
      itemId: "item-1",
      authorization: "Bearer never-browser",
    }, context);

    expect(event).toEqual({
      type: "message-delta",
      provider: "openai",
      key,
      occurredAt: context.occurredAt,
      role: "assistant",
      delta: "hello",
      turnId: "turn-1",
      itemId: "item-1",
    });
  });

  it("suppresses a delta explicitly marked as hidden reasoning", () => {
    const event = normalizeProviderEvent({
      type: "message-delta",
      role: "assistant",
      delta: "private chain of thought",
      turnId: "turn-1",
      itemId: "item-1",
      channel: "hidden_reasoning",
      authorization: "Bearer never-browser",
    }, context);

    expect(event).toMatchObject({
      type: "diagnostic",
      code: "HIDDEN_PROVIDER_CONTENT_SUPPRESSED",
    });
    expect(JSON.stringify(event)).not.toContain("private chain of thought");
    expect(JSON.stringify(event)).not.toContain("never-browser");
  });

  it("normalizes provider plans", () => {
    expect(normalizeProviderEvent({
      type: "plan",
      turnId: "turn-1",
      itemId: "item-1",
      stepIndex: null,
      text: "1. Define the seam",
      status: "streaming",
    }, context)).toMatchObject({
      type: "plan",
      turnId: "turn-1",
      itemId: "item-1",
      stepIndex: null,
      text: "1. Define the seam",
      status: "streaming",
    });
  });

  it("normalizes provider activity", () => {
    expect(normalizeProviderEvent({
      type: "activity",
      turnId: "turn-1",
      itemId: "item-1",
      activity: "command",
      status: "started",
      message: "pnpm test",
    }, context)).toMatchObject({
      type: "activity",
      turnId: "turn-1",
      itemId: "item-1",
      activity: "command",
      status: "started",
      message: "pnpm test",
    });
  });

  it("normalizes a bounded diff summary without exposing raw patch content", () => {
    const event = normalizeProviderEvent({
      type: "diff-summary",
      turnId: "turn-1",
      changedFiles: 3,
      additions: 42,
      deletions: 7,
      patch: "- secret old line\n+ secret new line",
    }, context);

    expect(event).toMatchObject({
      type: "diff-summary",
      turnId: "turn-1",
      changedFiles: 3,
      additions: 42,
      deletions: 7,
    });
    expect(event).not.toHaveProperty("patch");
    expect(JSON.stringify(event)).not.toContain("secret old line");
  });

  it.each([
    { changedFiles: Infinity, additions: 0, deletions: 0 },
    { changedFiles: 0, additions: -1, deletions: 0 },
    { changedFiles: 0, additions: 0, deletions: MAX_PROVIDER_USAGE_COUNT + 1 },
  ])("diagnoses unsafe diff counts %#", (counts) => {
    expect(normalizeProviderEvent({
      type: "diff-summary",
      turnId: "turn-1",
      ...counts,
    }, context)).toMatchObject({
      type: "diagnostic",
      code: "INVALID_PROVIDER_EVENT",
    });
  });

  it("normalizes bounded provider usage counts", () => {
    expect(normalizeProviderEvent({
      type: "usage",
      turnId: "turn-1",
      inputTokens: 12,
      outputTokens: 7,
      cachedInputTokens: 3,
      totalTokens: 19,
    }, context)).toMatchObject({
      type: "usage",
      turnId: "turn-1",
      inputTokens: 12,
      outputTokens: 7,
      cachedInputTokens: 3,
      totalTokens: 19,
    });
  });

  it.each([NaN, Infinity, -1, MAX_PROVIDER_USAGE_COUNT + 1])(
    "diagnoses an unsafe usage count %s",
    (inputTokens) => {
      expect(normalizeProviderEvent({
        type: "usage",
        turnId: "turn-1",
        inputTokens,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      }, context)).toMatchObject({
        type: "diagnostic",
        code: "INVALID_PROVIDER_EVENT",
      });
    },
  );

  it("normalizes request resolution with the full immutable identity", () => {
    const event = normalizeProviderEvent({ type: "request-resolved", identity }, context);

    expect(event).toMatchObject({ type: "request-resolved", identity });
    if (event.type !== "request-resolved") throw new Error("expected request resolution");
    expect(Object.isFrozen(event.identity)).toBe(true);
  });

  it("normalizes provider requests with the full immutable identity", () => {
    const event = normalizeProviderEvent({
      type: "request",
      request: { kind: "command-approval", identity },
    }, context);

    expect(event).toMatchObject({
      type: "request",
      request: { kind: "command-approval", identity },
    });
  });

  it("rejects a request identity owned by another native task", () => {
    const mismatched = createProviderRequestIdentity({
      ...identity,
      key: createNativeTaskKey("openai", "/tmp/codex-home", "task-2"),
    });

    expect(normalizeProviderEvent({
      type: "request-resolved",
      identity: mismatched,
    }, context)).toMatchObject({
      type: "diagnostic",
      code: "PROVIDER_REQUEST_CONTEXT_MISMATCH",
    });
  });

  it("exposes only safe diagnostic metadata to browser consumers", () => {
    const secret = ["sk", "proj", "browserleak"].join("-");
    const event = normalizeProviderEvent({
      type: "provider/future",
      method: "item/future/update",
      authorization: `Bearer ${secret}`,
      hiddenReasoning: "private chain of thought",
      detail: "safe shape, unsafe value",
    }, context);

    expect(event).toMatchObject({
      type: "diagnostic",
      code: "HIDDEN_PROVIDER_CONTENT_SUPPRESSED",
      method: "item/future/update",
      shapeKeys: ["authorization", "detail", "hiddenReasoning", "method", "type"],
    });
    expect(event).not.toHaveProperty("raw");
    expect(event).not.toHaveProperty("truncated");
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(JSON.stringify(event)).not.toContain("private chain of thought");
    expect(JSON.stringify(event)).not.toContain("unsafe value");
  });

  it("diagnoses a context whose provider disagrees with its immutable task key", () => {
    const event = normalizeProviderEvent(
      { type: "message", role: "assistant", text: "unsafe mismatch" },
      { ...context, provider: "anthropic" },
    );

    expect(event).toMatchObject({
      type: "diagnostic",
      provider: "openai",
      key,
      code: "PROVIDER_EVENT_CONTEXT_MISMATCH",
    });
  });
});

describe("provider request timeout responses", () => {
  const request = (kind: ProviderRequest["kind"]): ProviderRequest =>
    ({ kind, identity }) as ProviderRequest;

  it.each(["command-approval", "file-change-approval", "mcp-elicitation"] as const)(
    "cancels %s while preserving its exact native identity",
    (kind) => {
      const response = timeoutResponseForRequest(request(kind));
      expect(response).toEqual({ kind, identity, decision: "cancel" });
      expect(response?.identity).toBe(identity);
    },
  );

  it("grants no permissions on timeout while preserving identity", () => {
    expect(timeoutResponseForRequest(request("permission"))).toEqual({
      kind: "permission",
      identity,
      permissions: [],
    });
  });

  it.each([undefined, NaN, Infinity, AUTO_RESOLUTION_MIN_MS - 1, AUTO_RESOLUTION_MAX_MS + 1])(
    "does not auto-resolve user input with unsafe timeout %s",
    (autoResolutionMs) => {
      expect(timeoutResponseForRequest({
        kind: "user-input",
        identity,
        autoResolutionMs,
      } as ProviderRequest)).toBeNull();
    },
  );

  it("auto-resolves user input only inside the documented bounded range", () => {
    const requestWithTimeout: ProviderRequest = {
      kind: "user-input",
      identity,
      autoResolutionMs: AUTO_RESOLUTION_MIN_MS,
    };
    const response = timeoutResponseForRequest(requestWithTimeout);

    expect(response).toEqual({ kind: "user-input", identity, answers: {} });
    expect(response?.identity).toBe(identity);
  });
});
