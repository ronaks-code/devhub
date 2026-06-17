import { describe, it, expect } from "vitest";
import {
  pairToolResults,
  pairMessage,
  indexToolResults,
  type PairedToolUse,
} from "./transcript";
import type { ContentBlock, NormalizedMessage } from "./types";

// --- tiny synthetic-message builders ---------------------------------------
// Keep inputs minimal: pairing logic only inspects `role` + `blocks`, so the
// rest of NormalizedMessage is filled with stable defaults.

let nextSeq = 0;
function msg(role: NormalizedMessage["role"], blocks: ContentBlock[]): NormalizedMessage {
  const seq = nextSeq++;
  return {
    seq,
    uuid: `u${seq}`,
    parentUuid: null,
    role,
    type: role,
    timestamp: null,
    blocks,
  };
}

function toolUse(id: string, name = "Bash", input: unknown = {}): ContentBlock {
  return { type: "tool_use", id, name, input };
}

function toolResult(
  toolUseId: string,
  content = "ok",
  isError?: boolean,
): ContentBlock {
  return isError === undefined
    ? { type: "tool_result", toolUseId, content }
    : { type: "tool_result", toolUseId, content, isError };
}

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

/** Index into an array, asserting the element exists (tsc strict-index friendly). */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

/** Narrow the first tool_use block of a message to its paired form. */
function firstToolUse(m: NormalizedMessage): PairedToolUse {
  const b = m.blocks.find((x) => x.type === "tool_use");
  if (!b) throw new Error("no tool_use block");
  return b as PairedToolUse;
}

/** Pull a tool_use block by id, narrowed to its paired form. */
function toolUseById(m: NormalizedMessage, id: string): PairedToolUse {
  const b = m.blocks.find((x) => x.type === "tool_use" && x.id === id);
  if (!b) throw new Error(`no tool_use with id ${id}`);
  return b as PairedToolUse;
}

describe("pairToolResults", () => {
  it("attaches a tool_result to its matching tool_use by id", () => {
    const messages = [
      msg("assistant", [toolUse("t1"), text("running")]),
      msg("user", [toolResult("t1", "done")]),
    ];

    const out = pairToolResults(messages);

    // The consumed user message becomes empty and is dropped, leaving only the
    // assistant message with the result attached to its tool_use.
    expect(out).toHaveLength(1);
    const tu = firstToolUse(at(out, 0));
    expect(tu.type).toBe("tool_use");
    expect(tu.result).toBeDefined();
    expect(tu.result?.toolUseId).toBe("t1");
    expect(tu.result?.content).toBe("done");
  });

  it("leaves an unpaired tool_use (no result yet, still running) untouched", () => {
    const messages = [msg("assistant", [toolUse("t1"), text("working...")])];

    const out = pairToolResults(messages);

    // No results anywhere -> input returned as-is (same reference).
    expect(out).toBe(messages);
    const tu = firstToolUse(at(out, 0));
    expect(tu.result).toBeUndefined();
  });

  it("keeps an orphan tool_result (no preceding tool_use in window) standalone", () => {
    // The tool_use scrolled out of the window (tail mode); only the result is here.
    const messages = [msg("user", [toolResult("missing", "orphan output")])];

    const out = pairToolResults(messages);

    // Nothing to pair, so the message survives with its standalone result block.
    expect(out).toHaveLength(1);
    expect(at(out, 0).blocks).toHaveLength(1);
    const b = at(at(out, 0).blocks, 0);
    expect(b.type).toBe("tool_result");
    expect(b.type === "tool_result" && b.toolUseId).toBe("missing");
  });

  it("pairs multiple tool calls in one assistant message to their own results", () => {
    const messages = [
      msg("assistant", [toolUse("a", "Read"), toolUse("b", "Grep"), text("two calls")]),
      msg("user", [toolResult("a", "file contents"), toolResult("b", "matches")]),
    ];

    const out = pairToolResults(messages);

    expect(out).toHaveLength(1);
    const ta = toolUseById(at(out, 0), "a");
    const tb = toolUseById(at(out, 0), "b");
    expect(ta.result?.content).toBe("file contents");
    expect(tb.result?.content).toBe("matches");
    // Each result lands on the correct tool, not swapped.
    expect(ta.result?.toolUseId).toBe("a");
    expect(tb.result?.toolUseId).toBe("b");
  });

  it("preserves message and block ordering", () => {
    const messages = [
      msg("assistant", [text("intro")]),
      msg("assistant", [toolUse("t1", "Read"), toolUse("t2", "Bash")]),
      msg("user", [toolResult("t1"), toolResult("t2")]),
      msg("assistant", [text("outro")]),
    ];

    const out = pairToolResults(messages);

    // The emptied result-carrying user message is dropped; the rest stay in order.
    expect(out.map((m) => m.role)).toEqual(["assistant", "assistant", "assistant"]);
    expect((at(at(out, 0).blocks, 0) as { text: string }).text).toBe("intro");
    expect((at(at(out, 2).blocks, 0) as { text: string }).text).toBe("outro");
    // Block order within the tool-bearing message is unchanged (t1 before t2).
    const ids = at(out, 1).blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => (b as { id: string }).id);
    expect(ids).toEqual(["t1", "t2"]);
  });

  it("flags error tool_results via the attached result's isError", () => {
    const messages = [
      msg("assistant", [toolUse("t1", "Bash")]),
      msg("user", [toolResult("t1", "command failed", true)]),
    ];

    const out = pairToolResults(messages);

    const tu = firstToolUse(at(out, 0));
    expect(tu.result?.isError).toBe(true);
    expect(tu.result?.content).toBe("command failed");
  });

  it("keeps a user message that still has non-result content after absorbing its result", () => {
    const messages = [
      msg("assistant", [toolUse("t1")]),
      msg("user", [toolResult("t1", "done"), text("thanks, continue")]),
    ];

    const out = pairToolResults(messages);

    // The result is absorbed into the tool_use, but the user's text remains, so
    // the user message is NOT dropped.
    expect(out).toHaveLength(2);
    expect(firstToolUse(at(out, 0)).result?.content).toBe("done");
    expect(at(out, 1).role).toBe("user");
    expect(at(out, 1).blocks).toHaveLength(1);
    expect((at(at(out, 1).blocks, 0) as { text: string }).text).toBe("thanks, continue");
  });

  it("does not mutate the original messages or their block arrays", () => {
    const useBlock = toolUse("t1");
    const assistant = msg("assistant", [useBlock]);
    const messages = [assistant, msg("user", [toolResult("t1", "done")])];
    const beforeLen = assistant.blocks.length;

    const out = pairToolResults(messages);

    // Original block stays a plain tool_use (no result), and the output is a clone.
    expect(assistant.blocks.length).toBe(beforeLen);
    expect("result" in useBlock).toBe(false);
    expect(at(out, 0)).not.toBe(assistant);
  });
});

describe("indexToolResults", () => {
  it("indexes only results whose tool_use is present in the window", () => {
    const messages = [
      msg("assistant", [toolUse("present")]),
      msg("user", [toolResult("present", "x"), toolResult("absent", "orphan")]),
    ];

    const idx = indexToolResults(messages);

    expect(idx.has("present")).toBe(true);
    expect(idx.has("absent")).toBe(false);
    expect(idx.get("present")?.content).toBe("x");
    expect(idx.size).toBe(1);
  });

  it("returns an empty map when there are no tool_results", () => {
    const messages = [msg("assistant", [toolUse("t1"), text("hi")])];
    expect(indexToolResults(messages).size).toBe(0);
  });
});

describe("pairMessage", () => {
  it("returns null for a user message emptied by absorbing its only result", () => {
    const messages = [
      msg("assistant", [toolUse("t1")]),
      msg("user", [toolResult("t1", "done")]),
    ];
    const idx = indexToolResults(messages);

    const pairedUser = pairMessage(at(messages, 1), idx);
    expect(pairedUser).toBeNull();
  });

  it("returns the same reference when nothing changes", () => {
    const messages = [msg("assistant", [toolUse("t1")])];
    const idx = indexToolResults(messages); // empty: no results present
    const m = at(messages, 0);

    expect(pairMessage(m, idx)).toBe(m);
  });

  it("does not drop an emptied NON-user message", () => {
    // An assistant/system message that becomes empty is still returned (only
    // empty *user* messages are dropped).
    const messages = [
      msg("assistant", [toolUse("t1")]),
      msg("system", [toolResult("t1", "done")]),
    ];
    const idx = indexToolResults(messages);

    const paired = pairMessage(at(messages, 1), idx);
    expect(paired).not.toBeNull();
    expect(paired?.role).toBe("system");
    expect(paired?.blocks).toHaveLength(0);
  });
});
