import { describe, expect, it } from "vitest";
import {
  MAX_DIAGNOSTIC_RAW_CHARS,
  normalizeProviderEventWithBackendDiagnostics,
} from "../../src/providers/backend-diagnostics.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";

const key = createNativeTaskKey("openai", "/tmp/codex-home", "task-1");
const context = { provider: "openai" as const, key, occurredAt: "2026-07-13T00:00:00.000Z" };

describe("backend provider diagnostics", () => {
  it("retains bounded raw diagnostics while redacting auth, token, and hidden reasoning values", () => {
    const secret = ["sk", "proj", "backendleak"].join("-");
    const raw: Record<string, unknown> = {
      type: "future-provider-event",
      method: "item/future/update",
      authorization: `Bearer ${secret}`,
      accessToken: "token-value-never-retain",
      hiddenReasoning: "private chain of thought",
      nested: { reasoning: "private nested thought", safe: "visible detail" },
      detail: "x".repeat(MAX_DIAGNOSTIC_RAW_CHARS * 2),
    };
    raw.circular = raw;

    const envelope = normalizeProviderEventWithBackendDiagnostics(raw, context);

    expect(envelope.event).toMatchObject({
      type: "diagnostic",
      method: "item/future/update",
    });
    expect(envelope.rawDiagnostic).not.toBeNull();
    expect(envelope.rawDiagnostic?.raw).toContain("[REDACTED]");
    expect(envelope.rawDiagnostic?.raw).toContain("visible detail");
    expect(envelope.rawDiagnostic?.raw).not.toContain(secret);
    expect(envelope.rawDiagnostic?.raw).not.toContain("token-value-never-retain");
    expect(envelope.rawDiagnostic?.raw).not.toContain("private chain of thought");
    expect(envelope.rawDiagnostic?.raw).not.toContain("private nested thought");
    expect(envelope.rawDiagnostic?.raw.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_RAW_CHARS);
    expect(envelope.rawDiagnostic?.truncated).toBe(true);
  });

  it("does not allocate a raw diagnostic envelope for a known safe event", () => {
    const envelope = normalizeProviderEventWithBackendDiagnostics({
      type: "message-delta",
      role: "assistant",
      delta: "safe",
      turnId: "turn-1",
      itemId: "item-1",
    }, context);

    expect(envelope.event.type).toBe("message-delta");
    expect(envelope.rawDiagnostic).toBeNull();
  });
});
