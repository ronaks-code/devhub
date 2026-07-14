import { describe, expect, it } from "vitest";
import {
  CODEX_DEFAULT_MAX_LINE_BYTES,
  CodexJsonlDecoder,
  CodexProtocolFault,
} from "../../src/providers/codex/protocol/index.js";

describe("Codex JSONL decoder", () => {
  it("incrementally decodes partial UTF-8 and CRLF-delimited envelopes", () => {
    const decoder = new CodexJsonlDecoder();
    const bytes = Buffer.from(
      '{"method":"item/agentMessage/delta","params":{"delta":"café"}}\r\n',
      "utf8",
    );
    const split = bytes.indexOf(Buffer.from("é")) + 1;

    expect(decoder.push(bytes.subarray(0, split))).toEqual([]);
    expect(decoder.push(bytes.subarray(split))).toEqual([
      {
        envelope: {
          method: "item/agentMessage/delta",
          params: { delta: "café" },
        },
        lineBytes: bytes.length - 2,
        frameBytes: bytes.length,
      },
    ]);
  });

  it("preserves notification-before-response wire order", () => {
    const decoder = new CodexJsonlDecoder();

    expect(decoder.push(
      '{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}\n' +
      '{"id":7,"result":{"ok":true}}\n',
    ).map(({ envelope }) => envelope)).toEqual([
      { method: "turn/started", params: { turn: { id: "turn-1" } } },
      { id: 7, result: { ok: true } },
    ]);
  });

  it.each([
    { label: "malformed JSON", line: '{"id":1,}\n', code: "MALFORMED_JSON" },
    { label: "array", line: "[]\n", code: "INVALID_ENVELOPE" },
    { label: "primitive", line: "42\n", code: "INVALID_ENVELOPE" },
    { label: "null", line: "null\n", code: "INVALID_ENVELOPE" },
    { label: "fractional id", line: '{"id":1.5,"result":{}}\n', code: "INVALID_ID" },
    { label: "unsafe id", line: `{"id":${Number.MAX_SAFE_INTEGER + 1},"result":{}}\n`, code: "INVALID_ID" },
    { label: "object id", line: '{"id":{},"result":{}}\n', code: "INVALID_ID" },
    { label: "jsonrpc marker", line: '{"jsonrpc":"2.0","id":1,"result":{}}\n', code: "INVALID_ENVELOPE" },
    { label: "ambiguous result/error", line: '{"id":1,"result":{},"error":{"code":1,"message":"x"}}\n', code: "INVALID_ENVELOPE" },
  ])("rejects $label and permanently faults the decoder", ({ line, code }) => {
    const decoder = new CodexJsonlDecoder();
    let thrown: unknown;

    try {
      decoder.push(line);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexProtocolFault);
    expect(thrown).toMatchObject({ code });
    expect(() => decoder.push('{"method":"initialized"}\n')).toThrow(/faulted/i);
  });

  it("rejects an oversized partial line before retaining it", () => {
    const decoder = new CodexJsonlDecoder({ maxLineBytes: 32 });

    expect(decoder.push('{"method":"1234')).toEqual([]);
    expect(() => decoder.push("56789012345678901234567890")).toThrow(/32 bytes/i);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("uses a conservative configurable 4 MiB default line bound", () => {
    expect(CODEX_DEFAULT_MAX_LINE_BYTES).toBe(4 * 1024 * 1024);
    expect(new CodexJsonlDecoder().maxLineBytes).toBe(CODEX_DEFAULT_MAX_LINE_BYTES);
  });

  it("finalizes a complete stream and rejects writes after EOF", () => {
    const decoder = new CodexJsonlDecoder();
    expect(decoder.push('{"method":"initialized"}\n')).toHaveLength(1);

    expect(() => decoder.finish()).not.toThrow();
    expect(() => decoder.finish()).not.toThrow();
    expect(() => decoder.push('{"method":"initialized"}\n')).toThrow(/finished|EOF/i);
  });

  it("faults EOF when a final JSONL frame is truncated", () => {
    const decoder = new CodexJsonlDecoder();
    decoder.push('{"id":1,"result":');

    expect(() => decoder.finish()).toThrowError(expect.objectContaining({
      code: "TRUNCATED_FRAME",
    }));
    expect(decoder.bufferedBytes).toBe(0);
  });
});
