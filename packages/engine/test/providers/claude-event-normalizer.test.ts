import { describe, expect, it } from "vitest";
import {
  ClaudeEventNormalizer,
  ClaudeEventNormalizerError,
} from "../../src/providers/claude/event-normalizer.js";
import {
  ClaudeModelEvidenceLedger,
  buildClaudeModelObservation,
} from "../../src/providers/claude/model-evidence.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../src/providers/capabilities.js";
import { DEFAULT_DEVHUB_FEATURE_FLAGS } from "../../src/providers/feature-flags.js";

const HOME = "/canonical/claude-home";
const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TURN = "turn-1";
const TS = "2026-07-13T16:00:00.000Z";
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const UUIDS = [
  "119f5b78-18c0-7b60-8f0c-6afc120ecd7d",
  "219f5b78-18c0-7b60-8f0c-6afc120ecd7d",
  "319f5b78-18c0-7b60-8f0c-6afc120ecd7d",
  "419f5b78-18c0-7b60-8f0c-6afc120ecd7d",
] as const;

const normalizer = () => new ClaudeEventNormalizer({
  home: HOME,
  sessionId: SESSION,
  generation: 3,
  canonicalizeHome: (home) => home,
});

const ctx = { turnId: TURN, occurredAt: TS };

describe("ClaudeEventNormalizer", () => {
  it("retains requested/init/stream/assistant/billed model divergence as separate evidence", () => {
    const normalize = normalizer();
    const init = normalize.normalize({
      type: "system",
      subtype: "init",
      uuid: UUIDS[0],
      session_id: SESSION,
      model: HAIKU,
      capabilities: ["interrupt_receipt_v1", "not-browser-visible"],
      tools: ["not-browser-visible"],
    }, ctx);
    expect(init.runtimeCapabilities).toEqual([
      "interrupt_receipt_v1",
      "not-browser-visible",
    ]);
    const stream = normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[1],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: {
          id: "message-1",
          model: SONNET,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      },
    }, ctx);
    const assistant = normalize.normalize({
      type: "assistant",
      uuid: UUIDS[2],
      session_id: SESSION,
      message: {
        id: "message-1",
        role: "assistant",
        model: SONNET,
        usage: { input_tokens: 10, output_tokens: 4 },
        content: [{ type: "text", text: "safe answer" }],
      },
    }, ctx);
    const result = normalize.normalize({
      type: "result",
      subtype: "success",
      uuid: UUIDS[3],
      session_id: SESSION,
      usage: { input_tokens: 10, output_tokens: 4 },
      total_cost_usd: 0.01,
      modelUsage: {
        [SONNET]: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
        },
      },
    }, ctx);
    const requested = buildClaudeModelObservation({
      id: "requested-1",
      source: "requested",
      sourceEventId: "configuration-1",
      sessionId: SESSION,
      generation: 3,
      turnId: TURN,
      occurredAt: TS,
      model: HAIKU,
      usage: null,
    });
    const ledger = new ClaudeModelEvidenceLedger({ sessionId: SESSION, generation: 3 });
    ledger.append([
      requested,
      ...init.modelObservations,
      ...stream.modelObservations,
      ...assistant.modelObservations,
      ...result.modelObservations,
    ]);

    const snapshot = ledger.snapshot();
    expect(snapshot.bySource.requested).toHaveLength(1);
    expect(snapshot.bySource["system-init"]).toHaveLength(1);
    expect(snapshot.bySource["stream-message-start"]).toHaveLength(1);
    expect(snapshot.bySource["assistant-message"]).toHaveLength(1);
    expect(snapshot.bySource["result-model-usage"]).toHaveLength(1);
    expect(snapshot.bySource["result-total-usage"]).toHaveLength(1);
    expect(snapshot.distinctModels).toEqual([HAIKU, SONNET]);
    expect(snapshot.hasDivergence).toBe(true);
    expect(result.modelObservations.at(-1)).toMatchObject({
      source: "result-total-usage",
      model: null,
    });
    expect(Object.isFrozen(init)).toBe(true);
    expect(Object.isFrozen(init.events)).toBe(true);
    expect(Object.isFrozen(init.modelObservations)).toBe(true);
  });

  it("retains one message id across start, text delta, and final assistant replay", () => {
    const normalize = normalizer();
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[0],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: { id: "message-stable", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    const deltaFrame = {
      type: "stream_event",
      uuid: UUIDS[1],
      session_id: SESSION,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello " },
      },
    };
    const delta = normalize.normalize(deltaFrame, ctx);
    const finalFrame = {
      type: "assistant",
      uuid: UUIDS[2],
      session_id: SESSION,
      message: {
        id: "message-stable",
        role: "assistant",
        model: SONNET,
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [{ type: "text", text: "hello world" }],
      },
    };
    const final = normalize.normalize(finalFrame, ctx);
    const replay = normalize.normalize(finalFrame, ctx);

    expect(delta.events[0]?.event).toMatchObject({
      type: "message-delta",
      role: "assistant",
      itemId: "message-stable",
      delta: "hello ",
    });
    expect(final.events[0]?.event).toMatchObject({
      type: "message",
      role: "assistant",
      itemId: "message-stable",
      text: "hello world",
    });
    expect(delta.events[0]?.eventId).toBe(`${UUIDS[1]}:event:0`);
    expect(final.events[0]?.eventId).toBe(`${UUIDS[2]}:event:0`);
    expect(final.modelObservations[0]?.id)
      .toBe(`${UUIDS[2]}:model:assistant-message:0`);
    expect(replay).toEqual(final);
    expect(replay.replayKey).toBe(UUIDS[2]);
    expect(replay.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("does not let an invalid message start poison the active message correlation", () => {
    const normalize = normalizer();
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[0],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: { id: "message-valid", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    const invalid = normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[1],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: { id: "message-poison", model: SONNET, usage: { input_tokens: -1 } },
      },
    }, ctx);
    const delta = normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[2],
      session_id: SESSION,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "still valid" },
      },
    }, ctx);

    expect(invalid.events[0]?.event.type).toBe("diagnostic");
    expect(delta.events[0]?.event).toMatchObject({
      type: "message-delta",
      itemId: "message-valid",
    });
  });

  it("does not let replay of an older start overwrite newer message correlation", () => {
    const normalize = normalizer();
    const older = {
      type: "stream_event",
      uuid: UUIDS[0],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: { id: "message-older", model: SONNET, usage: { input_tokens: 1 } },
      },
    };
    normalize.normalize(older, ctx);
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[1],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: { id: "message-newer", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    expect(normalize.normalize(older, ctx).replayKey).toBe(UUIDS[0]);
    const delta = normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[2],
      session_id: SESSION,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "belongs to newer" },
      },
    }, ctx);

    expect(delta.events[0]?.event).toMatchObject({
      type: "message-delta",
      itemId: "message-newer",
    });
  });

  it("keeps parent and subagent stream correlation isolated within one turn", () => {
    const normalize = normalizer();
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[0],
      session_id: SESSION,
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: { id: "message-parent", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[1],
      session_id: SESSION,
      parent_tool_use_id: "parent-tool-1",
      event: {
        type: "message_start",
        message: { id: "message-subagent", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    const parentDelta = normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[2],
      session_id: SESSION,
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "parent text" },
      },
    }, ctx);
    const subagentDelta = normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[3],
      session_id: SESSION,
      parent_tool_use_id: "parent-tool-1",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "subagent text" },
      },
    }, ctx);

    expect(parentDelta.events[0]?.event).toMatchObject({ itemId: "message-parent" });
    expect(subagentDelta.events[0]?.event).toMatchObject({ itemId: "message-subagent" });
  });

  it("keeps a missing-start delta diagnostic on identical replay after a later start", () => {
    const normalize = normalizer();
    const deltaFrame = {
      type: "stream_event",
      uuid: UUIDS[0],
      session_id: SESSION,
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "orphan text" },
      },
    };
    const first = normalize.normalize(deltaFrame, ctx);
    expect(first.events[0]?.event.type).toBe("diagnostic");
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[1],
      session_id: SESSION,
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: { id: "message-later", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    expect(normalize.normalize(deltaFrame, ctx)).toEqual(first);
  });

  it("replays an older delta with its originally correlated message id", () => {
    const normalize = normalizer();
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[0],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: { id: "message-first", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    const deltaFrame = {
      type: "stream_event",
      uuid: UUIDS[1],
      session_id: SESSION,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "first text" },
      },
    };
    const first = normalize.normalize(deltaFrame, ctx);
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[2],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: { id: "message-second", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    const replay = normalize.normalize(deltaFrame, ctx);

    expect(first.events[0]?.event).toMatchObject({ itemId: "message-first" });
    expect(replay).toEqual(first);
  });

  it("sorts billed per-model evidence and keeps raw result subtype and total usage separate", () => {
    const batch = normalizer().normalize({
      type: "result",
      subtype: "error_during_execution",
      uuid: UUIDS[0],
      session_id: SESSION,
      result: "private result text",
      permission_denials: [{ tool_input: { token: "private" } }],
      usage: {
        input_tokens: 9,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
      total_cost_usd: 0.02,
      modelUsage: {
        "claude-z-model": {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 0,
          costUSD: 0.015,
        },
        "claude-a-model": {
          inputTokens: 4,
          outputTokens: 2,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
          costUSD: 0.005,
        },
      },
    }, ctx);

    expect(batch.events.map(({ event }) => event.type)).toEqual(["status", "usage"]);
    expect(batch.events[0]?.event).toMatchObject({
      type: "status",
      status: "error_during_execution",
    });
    expect(JSON.stringify(batch.events)).not.toContain("private result text");
    expect(JSON.stringify(batch.events)).not.toContain("permission_denials");
    expect(batch.modelObservations.map(({ model }) => model)).toEqual([
      "claude-a-model",
      "claude-z-model",
      null,
    ]);
    expect(batch.modelObservations.map(({ source }) => source)).toEqual([
      "result-model-usage",
      "result-model-usage",
      "result-total-usage",
    ]);
    expect(batch.modelObservations.at(-1)?.usage).toMatchObject({
      kind: "billed",
      inputTokens: 9,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
      costUsd: 0.02,
    });
  });

  it("projects hook metadata while suppressing hook IO and payloads", () => {
    const normalize = normalizer();
    const started = normalize.normalize({
      type: "system",
      subtype: "hook_started",
      uuid: UUIDS[0],
      session_id: SESSION,
      hook_id: "hook-1",
      hook_name: "lint-check",
      hook_event: "PostToolUse",
      input: { credential: "Bearer abcdefghijklmnop" },
      stdout: "private stdout",
      stderr: "private stderr",
    }, ctx);
    const completed = normalize.normalize({
      type: "system",
      subtype: "hook_response",
      uuid: UUIDS[1],
      session_id: SESSION,
      hook_id: "hook-1",
      hook_name: "lint-check",
      hook_event: "PostToolUse",
      exit_code: 0,
      output: "private output",
    }, ctx);

    expect(started.events[0]?.event).toMatchObject({
      type: "activity",
      itemId: "hook-1",
      activity: "hook:PostToolUse",
      status: "running",
      message: "lint-check",
    });
    expect(completed.events[0]?.event).toMatchObject({ status: "completed" });
    for (const batch of [started, completed]) {
      const publicJson = JSON.stringify(batch.events);
      expect(publicJson).not.toContain("private");
      expect(publicJson).not.toContain("Bearer");
      expect(batch.events.every(({ rawDiagnostic }) => rawDiagnostic === null)).toBe(true);
    }
  });

  it("suppresses thinking, signatures, tool input, tool results, and credential text", () => {
    const normalize = normalizer();
    normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[0],
      session_id: SESSION,
      event: {
        type: "message_start",
        message: { id: "message-safe", model: SONNET, usage: { input_tokens: 1 } },
      },
    }, ctx);
    for (const [index, delta] of [
      { type: "thinking_delta", thinking: "private chain of thought" },
      { type: "signature_delta", signature: "private signature" },
      { type: "input_json_delta", partial_json: "private tool input" },
    ].entries()) {
      const ignored = normalize.normalize({
        type: "stream_event",
        uuid: UUIDS[index + 1],
        session_id: SESSION,
        event: { type: "content_block_delta", delta },
      }, ctx);
      expect(ignored.events).toEqual([]);
    }

    const assistant = normalize.normalize({
      type: "assistant",
      uuid: UUIDS[3],
      session_id: SESSION,
      hidden_reasoning: "private hidden reasoning",
      message: {
        id: "message-safe",
        model: SONNET,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: "thinking", thinking: "private reasoning" },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Write",
            input: { path: "/private/path", token: "sk-1234567890abcdefghijkl" },
          },
          { type: "text", text: "Bearer abcdefghijklmnop" },
        ],
      },
    }, ctx);
    const user = normalize.normalize({
      type: "user",
      uuid: UUIDS[2],
      session_id: SESSION,
      message: {
        id: "user-1",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "private result" }],
      },
    }, ctx);

    const publicJson = JSON.stringify(assistant.events);
    expect(publicJson).toContain("tool-use");
    expect(publicJson).toContain("[REDACTED]");
    expect(publicJson).not.toContain("private reasoning");
    expect(publicJson).not.toContain("/private/path");
    expect(publicJson).not.toContain("sk-1234567890abcdefghijkl");
    expect(user.events).toEqual([]);
  });

  it("degrades unknown, missing-id, and foreign-session frames to bounded safe diagnostics", () => {
    const normalize = normalizer();
    const secret = "sk-1234567890abcdefghijkl";
    const unknown = normalize.normalize({
      type: "future_private_event",
      uuid: UUIDS[0],
      payload: { credential: secret, text: "x".repeat(4_000) },
    }, ctx);
    const missing = normalize.normalize({
      type: "system",
      subtype: "status",
      session_id: SESSION,
      status: "running",
    }, ctx);
    const foreign = normalize.normalize({
      type: "system",
      subtype: "status",
      uuid: UUIDS[1],
      session_id: "519f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      status: "running",
    }, ctx);

    expect(unknown.nativeEventId).toBeNull();
    expect(unknown.replayKey).toBe(`diagnostic:${unknown.fingerprint}`);
    expect(unknown.events[0]?.event.type).toBe("diagnostic");
    expect(unknown.events[0]?.rawDiagnostic?.raw.length).toBeLessThanOrEqual(2_048);
    expect(unknown.events[0]?.rawDiagnostic?.raw).not.toContain(secret);
    expect(missing.nativeEventId).toBeNull();
    expect(missing.events[0]?.event.type).toBe("diagnostic");
    expect(foreign.nativeEventId).toBe(UUIDS[1]);
    expect(foreign.events[0]?.event.type).toBe("diagnostic");
    expect(JSON.stringify([unknown.events[0]?.event, missing.events[0]?.event, foreign.events[0]?.event]))
      .not.toContain(secret);
  });

  it("treats the pinned SDK null task status as an empty status transition", () => {
    const batch = normalizer().normalize({
      type: "system",
      subtype: "status",
      uuid: UUIDS[2],
      session_id: SESSION,
      status: null,
    }, ctx);

    expect(batch.events).toEqual([]);
    expect(batch.modelObservations).toEqual([]);
  });

  it("contains excessive and hostile decoded objects as frozen diagnostics", () => {
    const normalize = normalizer();
    const excessive = normalize.normalize({
      type: "assistant",
      uuid: UUIDS[0],
      session_id: SESSION,
      message: {
        id: "message-many",
        model: SONNET,
        content: Array.from({ length: 257 }, () => ({ type: "text", text: "x" })),
      },
    }, ctx);
    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("provider-secret");
      },
    });
    const hostileBatch = normalize.normalize(hostile, ctx);
    const malformedKnown = normalize.normalize({
      type: "stream_event",
      uuid: UUIDS[1],
      session_id: SESSION,
      event: "not-an-object",
    }, ctx);

    for (const batch of [excessive, hostileBatch, malformedKnown]) {
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.event.type).toBe("diagnostic");
      expect(Object.isFrozen(batch)).toBe(true);
      expect(Object.isFrozen(batch.events[0])).toBe(true);
      expect(JSON.stringify(batch.events[0]?.event)).not.toContain("provider-secret");
    }
  });

  it("leaves provider defaults and the persistent Claude feature claim disabled", () => {
    expect(DEFAULT_PROVIDER_CAPABILITIES.hooks).toBe(false);
    expect(DEFAULT_PROVIDER_CAPABILITIES.mcp).toBe(false);
    expect(DEFAULT_DEVHUB_FEATURE_FLAGS.persistentClaude).toBe(false);
  });

  it("contains hostile constructor and context objects in value-free typed errors", () => {
    const secret = "constructor-context-secret";
    const hostileOptions = new Proxy({}, {
      get: () => {
        throw new Error(secret);
      },
    });
    for (const invoke of [
      () => new ClaudeEventNormalizer(hostileOptions as never),
      () => normalizer().normalize({ type: "future" }, new Proxy({}, {
        get: () => {
          throw new Error(secret);
        },
      }) as never),
    ]) {
      try {
        invoke();
        throw new Error("expected hostile boundary to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ClaudeEventNormalizerError);
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});
