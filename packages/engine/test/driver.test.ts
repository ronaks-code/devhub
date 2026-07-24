import { describe, it, expect } from "vitest";
import { makeLineHandler, normalizeClaudeModel } from "../src/driver/cli.js";
import type { NormalizedMessage } from "../src/types.js";
import type { SessionInit, TurnHandlers, TurnResult } from "../src/driver/types.js";

// Unit tests for the CLI driver's stream-json LINE parser (makeLineHandler). We drive
// the parser DIRECTLY with captured stream-json line shapes (no real `claude` process,
// no network, no spawn) and assert how each frame routes through the handlers. This is
// the fiddly frame-dispatch logic in src/driver/cli.ts. Hermetic by construction.

interface Collected {
  sessions: Array<{ id: string; init: SessionInit }>;
  messages: NormalizedMessage[];
  deltas: string[];
  thinking: string[];
  statuses: Array<{ kind: string; data?: unknown }>;
  results: TurnResult[];
  errors: string[];
  state: { sessionId: string | null; seq: number; finalResult: TurnResult | null };
}

/** Feed a list of line objects (serialized like the CLI emits them) through the parser. */
const run = (lines: object[]): Collected => {
  const c: Collected = {
    sessions: [],
    messages: [],
    deltas: [],
    thinking: [],
    statuses: [],
    results: [],
    errors: [],
    state: { sessionId: null, seq: 0, finalResult: null },
  };
  const handlers: TurnHandlers = {
    onSession: (id, init) => c.sessions.push({ id, init }),
    onMessage: (m) => c.messages.push(m),
    onDelta: (t) => c.deltas.push(t),
    onThinkingDelta: (t) => c.thinking.push(t),
    onStatus: (s) => c.statuses.push(s),
    onResult: (r) => c.results.push(r),
    onError: (e) => c.errors.push(e),
  };
  const handle = makeLineHandler(handlers, c.state);
  for (const l of lines) handle(JSON.stringify(l));
  return c;
};

describe("driver line parser: system init", () => {
  it("a system:init line yields the session id + init metadata", () => {
    const c = run([
      {
        type: "system",
        subtype: "init",
        session_id: "sess-abc123",
        model: "claude-opus-4-8",
        cwd: "/home/dev/proj",
        tools: ["Bash", "Read"],
        permissionMode: "acceptEdits",
        slash_commands: ["/clear", "/help"],
      },
    ]);
    expect(c.state.sessionId).toBe("sess-abc123");
    expect(c.sessions).toHaveLength(1);
    expect(c.sessions[0]!.id).toBe("sess-abc123");
    expect(c.sessions[0]!.init).toMatchObject({
      sessionId: "sess-abc123",
      model: "claude-opus-4-8",
      cwd: "/home/dev/proj",
      tools: ["Bash", "Read"],
      permissionMode: "acceptEdits",
      slashCommands: ["/clear", "/help"],
    });
  });

  it("a non-init system line becomes an onStatus, not a session", () => {
    const c = run([{ type: "system", subtype: "compact" }]);
    expect(c.sessions).toEqual([]);
    expect(c.statuses).toEqual([{ kind: "compact" }]);
  });

  it("a system:init without a session_id does not emit onSession", () => {
    const c = run([{ type: "system", subtype: "init", model: "claude-opus-4-8" }]);
    expect(c.sessions).toEqual([]);
    expect(c.state.sessionId).toBeNull();
  });
});

describe("driver line parser: streamed text + thinking deltas", () => {
  it("content_block_delta text_delta accumulates into onDelta", () => {
    const c = run([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo " } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } },
    ]);
    expect(c.deltas).toEqual(["Hel", "lo ", "world"]);
    expect(c.deltas.join("")).toBe("Hello world");
    expect(c.thinking).toEqual([]);
  });

  it("thinking_delta routes to onThinkingDelta, kept separate from text", () => {
    const c = run([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reason " } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "more" } } },
    ]);
    expect(c.thinking).toEqual(["reason ", "more"]);
    expect(c.deltas).toEqual(["answer"]);
  });

  it("an unknown delta type (signature_delta) produces no callback", () => {
    const c = run([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "signature_delta", signature: "xyz" } } },
    ]);
    expect(c.deltas).toEqual([]);
    expect(c.thinking).toEqual([]);
  });
});

describe("driver line parser: assistant / user message frames", () => {
  it("an assistant frame is normalized and advances the seq", () => {
    const c = run([
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "the answer" }],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      },
    ]);
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.role).toBe("assistant");
    expect(c.messages[0]!.model).toBe("claude-opus-4-8");
    expect(c.state.seq).toBe(1);
  });

  it("tool_use and tool_result blocks parse on their respective frames", () => {
    const c = run([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt", is_error: false }],
        },
      },
    ]);
    expect(c.messages).toHaveLength(2);
    expect(c.messages[0]!.blocks[0]).toMatchObject({ type: "tool_use", id: "tu1", name: "Bash" });
    expect(c.messages[1]!.blocks[0]).toMatchObject({ type: "tool_result", toolUseId: "tu1", content: "file.txt" });
    expect(c.state.seq).toBe(2);
  });
});

describe("driver line parser: result frame", () => {
  it("a result line carries usage, cost, and permission_denials", () => {
    const c = run([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-xyz",
        total_cost_usd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
        permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf /" } }],
        result: "done",
      },
    ]);
    expect(c.results).toHaveLength(1);
    const r = c.results[0]!;
    expect(r.sessionId).toBe("sess-xyz");
    expect(r.subtype).toBe("success");
    expect(r.isError).toBe(false);
    expect(r.costUsd).toBeCloseTo(0.0123, 6);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheCreationTokens: 2 });
    expect(r.denials).toEqual([{ toolName: "Bash", toolInput: { command: "rm -rf /" } }]);
    expect(r.resultText).toBe("done");
    // The result is stashed on the shared state so the close handler can resolve it.
    expect(c.state.finalResult).toBe(r);
  });

  it("an error result frame sets isError and tolerates a missing usage/denials", () => {
    const c = run([{ type: "result", subtype: "error_max_turns", is_error: true }]);
    expect(c.results[0]!.isError).toBe(true);
    expect(c.results[0]!.subtype).toBe("error_max_turns");
    expect(c.results[0]!.usage).toBeUndefined();
    expect(c.results[0]!.denials).toEqual([]);
    expect(c.results[0]!.costUsd).toBe(0);
  });

  it("a result frame falls back to the resolved init session id", () => {
    const c = run([
      { type: "system", subtype: "init", session_id: "sess-init" },
      { type: "result", subtype: "success", is_error: false },
    ]);
    expect(c.results[0]!.sessionId).toBe("sess-init");
  });
});

describe("driver line parser: malformed / partial / unknown lines are tolerated", () => {
  it("a non-JSON line does not throw and emits nothing", () => {
    const c = run([]);
    const handle = makeLineHandler(
      {
        onMessage: (m) => c.messages.push(m),
        onResult: (r) => c.results.push(r),
        onError: (e) => c.errors.push(e),
      },
      c.state,
    );
    expect(() => handle("not json at all {")).not.toThrow();
    expect(() => handle("")).not.toThrow();
    expect(() => handle("   ")).not.toThrow();
    expect(c.messages).toEqual([]);
    expect(c.results).toEqual([]);
    expect(c.errors).toEqual([]);
  });

  it("an unknown frame type is ignored without throwing", () => {
    const c = run([
      { type: "x-future-frame", payload: { anything: true } },
      { type: "control_request", request_id: "r1" },
    ]);
    expect(c.messages).toEqual([]);
    expect(c.results).toEqual([]);
    expect(c.deltas).toEqual([]);
  });

  it("a partial stream_event missing its delta/event fields is ignored", () => {
    const c = run([
      { type: "stream_event" },
      { type: "stream_event", event: { type: "content_block_delta" } },
      { type: "stream_event", event: { type: "content_block_delta", delta: {} } },
      { type: "stream_event", event: { type: "message_start" } },
    ]);
    expect(c.deltas).toEqual([]);
    expect(c.thinking).toEqual([]);
    expect(c.statuses).toEqual([]);
  });

  it("an assistant frame with a non-object message is tolerated (no throw)", () => {
    const c = run([{ type: "assistant", message: "oops not an object" }]);
    // normalizeLine still returns a message (empty blocks); the point is it never throws.
    expect(() => c).not.toThrow();
    expect(c.messages.length).toBeLessThanOrEqual(1);
  });
});

describe("normalizeClaudeModel", () => {
  it("maps a retired model id to its successor", () => {
    expect(normalizeClaudeModel("claude-sonnet-4-6")).toBe("claude-sonnet-5");
  });

  it("passes current and unknown model ids through unchanged", () => {
    for (const id of [
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "claude-fable-5",
      "some-future-model",
    ]) {
      expect(normalizeClaudeModel(id)).toBe(id);
    }
  });
});
