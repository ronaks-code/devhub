import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODEL_EVIDENCE_SOURCES,
  ClaudeModelEvidenceError,
  ClaudeModelEvidenceLedger,
  buildClaudeModelObservation,
  buildClaudeRequestedModelObservation,
} from "../../src/providers/claude/model-evidence.js";

const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TS = "2026-07-13T16:00:00.000Z";

const observation = (
  id: string,
  source: (typeof CLAUDE_MODEL_EVIDENCE_SOURCES)[number],
  model: string | null,
  overrides: Readonly<Record<string, unknown>> = {},
) => buildClaudeModelObservation({
  id,
  source,
  sourceEventId: `event-${id}`,
  sessionId: SESSION,
  generation: 3,
  turnId: "turn-1",
  occurredAt: TS,
  model,
  usage: null,
  ...overrides,
});

describe("ClaudeModelEvidenceLedger", () => {
  it("retains every provenance observation and exposes divergence without an effective model", () => {
    const requested = buildClaudeRequestedModelObservation({
      id: "requested-1",
      sourceEventId: "configuration-1",
      sessionId: SESSION,
      generation: 3,
      turnId: "turn-1",
      occurredAt: TS,
      model: "claude-haiku-4-5",
    });
    const observations = [
      requested,
      observation("init-1", "system-init", "claude-haiku-4-5"),
      observation("stream-1", "stream-message-start", "claude-sonnet-4-6"),
      observation("assistant-1", "assistant-message", "claude-sonnet-4-6"),
      observation("billed-1", "result-model-usage", "claude-sonnet-4-6", {
        usage: {
          kind: "billed",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          costUsd: 0.012,
        },
      }),
    ];
    const ledger = new ClaudeModelEvidenceLedger({ sessionId: SESSION, generation: 3 });

    expect(ledger.append(observations)).toBe(5);
    const snapshot = ledger.snapshot();
    expect(snapshot.observations).toEqual(observations);
    expect(snapshot.distinctModels).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
    expect(snapshot.hasDivergence).toBe(true);
    expect(snapshot.bySource.requested).toEqual([requested]);
    expect(snapshot.bySource["result-total-usage"]).toEqual([]);
    expect("effectiveModel" in snapshot).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.observations)).toBe(true);
    expect(Object.isFrozen(snapshot.bySource)).toBe(true);
    expect(Object.values(snapshot.bySource).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(snapshot.distinctModels)).toBe(true);
  });

  it("keeps same-model and per-model versus top-level billed observations distinct", () => {
    const sonnetA = observation("sonnet-a", "assistant-message", "claude-sonnet-4-6");
    const sonnetB = observation("sonnet-b", "assistant-message", "claude-sonnet-4-6");
    const billedSonnet = observation("usage-sonnet", "result-model-usage", "claude-sonnet-4-6", {
      usage: {
        kind: "billed",
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
      },
    });
    const billedHaiku = observation("usage-haiku", "result-model-usage", "claude-haiku-4-5", {
      usage: {
        kind: "billed",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
      },
    });
    const total = observation("usage-total", "result-total-usage", null, {
      usage: {
        kind: "billed",
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.011,
      },
    });
    const ledger = new ClaudeModelEvidenceLedger({ sessionId: SESSION, generation: 3 });
    ledger.append([sonnetA, sonnetB, billedSonnet, billedHaiku, total]);

    const snapshot = ledger.snapshot();
    expect(snapshot.observations).toHaveLength(5);
    expect(snapshot.bySource["assistant-message"]).toEqual([sonnetA, sonnetB]);
    expect(snapshot.bySource["result-model-usage"]).toEqual([billedSonnet, billedHaiku]);
    expect(snapshot.bySource["result-total-usage"]).toEqual([total]);
    expect(snapshot.distinctModels).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5"]);
  });

  it("treats exact normalized replays as duplicates and conflicting ids atomically", () => {
    const ledger = new ClaudeModelEvidenceLedger({ sessionId: SESSION, generation: 3 });
    const first = observation("stable-id", "system-init", "claude-haiku-4-5");
    expect(ledger.append([first, first])).toBe(1);
    expect(ledger.append([buildClaudeModelObservation({
      ...first,
      id: " stable-id ",
      sourceEventId: " event-stable-id ",
    })])).toBe(0);

    const conflicting = observation("stable-id", "system-init", "claude-sonnet-4-6");
    expect(() => ledger.append([
      observation("would-not-append", "assistant-message", "claude-sonnet-4-6"),
      conflicting,
    ])).toThrowError(expect.objectContaining({ code: "COLLISION" }));
    expect(ledger.snapshot().observations).toEqual([first]);
  });

  it("rejects foreign ownership and capacity overflow without partial append", () => {
    const ledger = new ClaudeModelEvidenceLedger({
      sessionId: SESSION,
      generation: 3,
      maxObservations: 2,
    });
    expect(() => ledger.append([
      observation("local", "system-init", "claude-haiku-4-5"),
      observation("foreign", "assistant-message", "claude-sonnet-4-6", {
        generation: 4,
      }),
    ])).toThrowError(expect.objectContaining({ code: "FOREIGN_SCOPE" }));
    expect(ledger.snapshot().observations).toEqual([]);

    const first = observation("capacity-1", "system-init", "claude-haiku-4-5");
    ledger.append([first]);
    expect(() => ledger.append([
      observation("capacity-2", "assistant-message", "claude-haiku-4-5"),
      observation("capacity-3", "assistant-message", "claude-haiku-4-5"),
    ])).toThrowError(expect.objectContaining({ code: "CAPACITY" }));
    expect(ledger.snapshot().observations).toEqual([first]);
  });

  it("rejects a hostile recursive append without committing either transaction", () => {
    const ledger = new ClaudeModelEvidenceLedger({ sessionId: SESSION, generation: 3 });
    const staged = observation("reentrant-id", "system-init", "claude-haiku-4-5");
    const conflict = observation("reentrant-id", "system-init", "claude-sonnet-4-6");
    const triggerTarget = observation("trigger-id", "assistant-message", "claude-sonnet-4-6");
    const trigger = new Proxy(triggerTarget, {
      getPrototypeOf: (target) => {
        ledger.append([conflict]);
        return Reflect.getPrototypeOf(target);
      },
    });

    expect(() => ledger.append([staged, trigger]))
      .toThrowError(expect.objectContaining({ code: "INVALID_BATCH" }));
    expect(ledger.snapshot().observations).toEqual([]);
  });

  it("strictly snapshots builders and rejects hostile structures without leaking values", () => {
    const secret = "sk-ant-secret-model-value";
    const base = {
      id: "safe-id",
      source: "assistant-message",
      sourceEventId: "safe-event",
      sessionId: SESSION,
      generation: 3,
      turnId: null,
      occurredAt: TS,
      model: "claude-haiku-4-5",
      usage: null,
    };
    const built = buildClaudeModelObservation(base);
    expect(built).not.toBe(base);
    expect(Object.isFrozen(built)).toBe(true);
    expect(built.turnId).toBeNull();

    const accessor = Object.defineProperty({ ...base }, "model", {
      enumerable: true,
      get: () => secret,
    });
    const proxy = new Proxy(base, {
      ownKeys: () => {
        throw new Error(secret);
      },
    });
    const cyclicUsage: Record<string, unknown> = {
      kind: "reported",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
    };
    cyclicUsage.inputTokens = cyclicUsage;

    for (const hostile of [
      { ...base, model: secret },
      accessor,
      proxy,
      { ...base, usage: cyclicUsage },
      { ...base, extra: secret },
    ]) {
      try {
        buildClaudeModelObservation(hostile);
        throw new Error("expected hostile observation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ClaudeModelEvidenceError);
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  it("does not trust a captured internal error after mutation attempts", () => {
    const secret = "poisoned-internal-error-secret";
    let captured: unknown;
    try {
      buildClaudeModelObservation({});
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(ClaudeModelEvidenceError);
    expect(Reflect.set(captured as object, "message", secret)).toBe(false);
    expect(Reflect.set(captured as object, "code", secret)).toBe(false);

    const base = observation("poison-proxy", "assistant-message", "claude-haiku-4-5");
    const hostile = new Proxy(base, {
      getPrototypeOf: () => {
        throw captured;
      },
    });
    try {
      buildClaudeModelObservation(hostile);
      throw new Error("expected poisoned error path to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_OBSERVATION" });
      expect(String(error)).not.toContain(secret);
    }
  });

  it("sanitizes a throwing maxObservations accessor", () => {
    const secret = "max-observations-accessor-secret";
    const options = Object.defineProperty({
      sessionId: SESSION,
      generation: 3,
    }, "maxObservations", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    try {
      new ClaudeModelEvidenceLedger(options);
      throw new Error("expected hostile options to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each([
    ["fractional count", { inputTokens: 0.5 }],
    ["negative count", { outputTokens: -1 }],
    ["overflow count", { cacheReadTokens: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative cost", { costUsd: -0.01 }],
    ["infinite cost", { costUsd: Number.POSITIVE_INFINITY }],
  ])("rejects %s in usage", (_label, usageOverride) => {
    expect(() => observation("invalid-usage", "result-model-usage", null, {
      usage: {
        kind: "reported",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        ...usageOverride,
      },
    })).toThrowError(expect.objectContaining({ code: "INVALID_OBSERVATION" }));
  });

  it("rejects non-canonical timestamps, invalid ownership, invalid batches, and bad limits", () => {
    expect(() => observation("timestamp", "system-init", null, {
      occurredAt: "2026-07-13T16:00:00Z",
    })).toThrowError(expect.objectContaining({ code: "INVALID_OBSERVATION" }));
    expect(() => observation("session", "system-init", null, {
      sessionId: "not-a-session-uuid",
    })).toThrowError(expect.objectContaining({ code: "INVALID_OBSERVATION" }));
    expect(() => observation("generation", "system-init", null, {
      generation: 0,
    })).toThrowError(expect.objectContaining({ code: "INVALID_OBSERVATION" }));
    expect(() => new ClaudeModelEvidenceLedger({
      sessionId: SESSION,
      generation: 3,
      maxObservations: 4_097,
    })).toThrow(/maxObservations/i);
    const ledger = new ClaudeModelEvidenceLedger({ sessionId: SESSION, generation: 3 });
    expect(() => ledger.append("not-an-array" as never))
      .toThrowError(expect.objectContaining({ code: "INVALID_BATCH" }));
    expect(ledger.snapshot().observations).toEqual([]);
  });

  it("publishes the exact closed source set and a strict requested observation", () => {
    expect(CLAUDE_MODEL_EVIDENCE_SOURCES).toEqual([
      "requested",
      "system-init",
      "stream-message-start",
      "assistant-message",
      "result-model-usage",
      "result-total-usage",
    ]);
    const requested = buildClaudeRequestedModelObservation({
      id: "requested-strict",
      sourceEventId: "configuration-strict",
      sessionId: SESSION,
      generation: 3,
      turnId: null,
      occurredAt: TS,
      model: "claude-haiku-4-5",
    });
    expect(requested).toMatchObject({ source: "requested", usage: null, model: "claude-haiku-4-5" });
    expect(Object.isFrozen(requested)).toBe(true);
  });
});
