import { describe, expect, it } from "vitest";
import {
  CODEX_STREAM_MAX_NO_PROGRESS_INSPECTION_CHARS,
  StreamingSecretGate,
  type StreamingSecretKey,
} from "../../src/providers/codex/streaming-secret-gate.js";

const key = (itemId = "item-1", generation = 1): StreamingSecretKey => ({
  generation,
  threadId: "thread-1",
  turnId: "turn-1",
  itemId,
  kind: "message",
});

const cases = [
  ["OpenAI", "sk-proj-0123456789abcdefghijklmnop", "sk-proj-0123456789abcdefghijklmnop"],
  ["GitHub", `ghp_${"a".repeat(36)}`, `ghp_${"a".repeat(36)}`],
  ["Slack", "xoxb-123456789012-abcdefghijkl", "xoxb-123456789012-abcdefghijkl"],
  ["Google", `AIza${"b".repeat(35)}`, `AIza${"b".repeat(35)}`],
  ["AWS", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ["Bearer", "Bearer abcDEF1234567890", "abcDEF1234567890"],
  ["Bearer assignment", "auth: Bearer abcDEF1234567890", "abcDEF1234567890"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl", "cGF5bG9hZA"],
  ["database URL", "postgres://admin:s3cr3tPass@db.host:5432/app", "s3cr3tPass"],
  ["assignment", "API_TOKEN = supersecretvalue123", "supersecretvalue123"],
  ["spaced closed double-quoted assignment", "API_TOKEN = \" supersecretvalue123\"", "supersecretvalue123"],
  ["spaced closed single-quoted assignment", "API_TOKEN = ' supersecretvalue123'", "supersecretvalue123"],
  ["multiword double-quoted assignment", "API_TOKEN=\"secret first second\"", "secret first second"],
  ["multiword single-quoted assignment", "PASSWORD='correct horse battery staple'", "correct horse battery staple"],
  [
    "JSON multiword assignment",
    "{\"client_secret\": \"secret first second\", \"name\": \"safe\"}",
    "secret first second",
  ],
] as const;

const unclosedQuotedCases = [
  ["double", "API_TOKEN=\"secret first second", "secret first second"],
  ["single", "PASSWORD='correct horse battery staple", "correct horse battery staple"],
  ["spaced double", "API_TOKEN = \" secret first second", "secret first second"],
  ["spaced single", "PASSWORD = ' correct horse battery staple", "correct horse battery staple"],
] as const;

describe("StreamingSecretGate", () => {
  it.each(cases)("redacts %s secrets split at every byte boundary", (_name, value, secret) => {
    const source = `before ${value} after `;
    for (let split = 1; split < source.length; split += 1) {
      const gate = new StreamingSecretGate();
      const visible = [
        ...gate.feed(key(), source.slice(0, split)).chunks,
        ...gate.feed(key(), source.slice(split)).chunks,
      ].join("");
      expect(visible).not.toContain(secret);
      expect(visible).toContain("[REDACTED]");
    }
  });

  it.each(unclosedQuotedCases)(
    "withholds an unclosed %s-quoted assignment at every byte boundary",
    (_name, value, secret) => {
      const source = `before ${value} trailing words `;
      for (let split = 1; split < source.length; split += 1) {
        const gate = new StreamingSecretGate();
        const visible = [
          ...gate.feed(key(), source.slice(0, split)).chunks,
          ...gate.feed(key(), source.slice(split)).chunks,
        ].join("");
        expect(visible).not.toContain(secret);
        expect(visible).not.toContain("trailing words");
        expect(gate.bufferedCharacters).toBeGreaterThan(0);
      }
    },
  );

  it("redacts one-character-at-a-time input and preserves ordinary streaming text", () => {
    const gate = new StreamingSecretGate();
    const source = "hello sk-proj-0123456789abcdefghijklmnop world ";
    const visible = [...source].flatMap((character) => gate.feed(key(), character).chunks).join("");
    expect(visible).toBe("hello [REDACTED] world ");
  });

  it("retains unclosed quoted values and conservatively masks mismatched key quotes", () => {
    for (const source of [
      "API_TOKEN=\"supersecretvalue123 ",
      "API_TOKEN='supersecretvalue123 ",
      "API_TOKEN = \" supersecretvalue123 ",
    ]) {
      const gate = new StreamingSecretGate();
      expect(gate.feed(key(), source).chunks).toEqual([]);
      expect(gate.bufferedCharacters).toBe(source.length);
    }

    const mismatched = new StreamingSecretGate()
      .feed(key(), "\"password': hunter2hunter2 ").chunks.join("");
    expect(mismatched).toContain("[REDACTED]");
    expect(mismatched).not.toContain("hunter2hunter2");
  });

  it("keeps interleaved item buffers isolated", () => {
    const gate = new StreamingSecretGate();
    expect(gate.feed(key("a"), "alpha ").chunks.join("")).toBe("alpha ");
    expect(gate.feed(key("a"), "Bearer ").chunks).toEqual([]);
    expect(gate.feed(key("b"), "bravo safe ").chunks.join("")).toBe("bravo safe ");
    expect(gate.feed(key("a"), "secret-token-value ").chunks.join(""))
      .toBe("Bearer [REDACTED] ");
  });

  it("suppresses an oversized unterminated token without evicting or flushing it", () => {
    const gate = new StreamingSecretGate({ maxItemBufferChars: 64, maxTotalBufferChars: 128 });
    const first = gate.feed(key(), `sk-proj-${"a".repeat(80)}`);
    expect(first).toEqual({ chunks: [], suppressed: true });
    expect(gate.feed(key(), "continued-secret ")).toEqual({ chunks: [], suppressed: false });
    expect(gate.bufferedCharacters).toBe(0);
  });

  it("pre-caps authorization and assignment whitespace floods before lexical scanning", () => {
    const gate = new StreamingSecretGate({
      maxItemBufferChars: 64 * 1_024,
      maxTotalBufferChars: 128 * 1_024,
    });
    expect(gate.feed(key("auth-flood"), `Bearer ${" ".repeat(128 * 1_024)}`))
      .toEqual({ chunks: [], suppressed: true });
    expect(gate.feed(key("assignment-flood"), `API_TOKEN = ${" ".repeat(128 * 1_024)}`))
      .toEqual({ chunks: [], suppressed: true });
    expect(gate.bufferedCharacters).toBe(0);
  });

  it("bounds deterministic work for char-fragmented plain and whitespace floods", () => {
    for (const source of [
      "x".repeat(64 * 1_024),
      `Bearer ${" ".repeat(64 * 1_024)}`,
      `API_TOKEN = ${" ".repeat(64 * 1_024)}`,
    ]) {
      const gate = new StreamingSecretGate();
      let suppressionCount = 0;
      for (const character of source) {
        if (gate.feed(key(), character).suppressed) suppressionCount += 1;
      }
      expect(suppressionCount).toBe(1);
      expect(gate.inspectedCharacters)
        .toBeLessThanOrEqual(CODEX_STREAM_MAX_NO_PROGRESS_INSPECTION_CHARS);
      expect(gate.bufferedCharacters).toBe(0);
    }
  });

  it("handles one maximum-sized ordinary lexical segment in bounded wall time", () => {
    const gate = new StreamingSecretGate();
    const startedAt = performance.now();
    const output = gate.feed(key(), `${"a".repeat(64 * 1_024 - 1)} `);
    const elapsedMs = performance.now() - startedAt;

    expect(output.suppressed).toBe(false);
    expect(output.chunks.join("")).toHaveLength(64 * 1_024);
    // This catches catastrophic assignment-pattern backtracking. The linear path
    // is normally single-digit milliseconds, leaving generous loaded-CI margin.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("drops incomplete state on completion, cancellation, restart, and close", () => {
    const gate = new StreamingSecretGate();
    gate.feed(key("complete"), "Bearer ");
    gate.complete(key("complete"));
    expect(gate.feed(key("complete"), "ordinary ").chunks.join("")).toBe("ordinary ");

    gate.feed(key("cancel"), "API_TOKEN = ");
    gate.cancelTask(1, "thread-1");
    expect(gate.bufferedCharacters).toBe(0);

    gate.feed(key("restart", 2), "sk-proj-partial");
    gate.cancelGeneration(2);
    expect(gate.bufferedCharacters).toBe(0);

    gate.feed(key("close", 3), "Bearer ");
    gate.close();
    expect(gate.bufferedCharacters).toBe(0);
    expect(gate.feed(key("after-close", 3), "safe ")).toEqual({
      chunks: [],
      suppressed: false,
    });
  });
});
