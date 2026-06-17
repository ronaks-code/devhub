import { describe, it, expect } from "vitest";
import { messageToMarkdown } from "./CopyMessage";
import type { ContentBlock, NormalizedMessage } from "../lib/types";

function msg(blocks: ContentBlock[]): NormalizedMessage {
  return {
    seq: 0,
    uuid: "u0",
    parentUuid: null,
    role: "assistant",
    type: "assistant",
    timestamp: null,
    blocks,
  };
}

describe("messageToMarkdown", () => {
  it("copies text blocks verbatim (raw markdown, not rendered)", () => {
    const out = messageToMarkdown(msg([{ type: "text", text: "# Title\n\n**bold** and `code`" }]));
    expect(out).toBe("# Title\n\n**bold** and `code`");
  });

  it("joins multiple blocks with a blank line", () => {
    const out = messageToMarkdown(
      msg([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    );
    expect(out).toBe("first\n\nsecond");
  });

  it("blockquotes thinking under a labelled prefix", () => {
    const out = messageToMarkdown(msg([{ type: "thinking", text: "let me consider\ntwo lines" }]));
    expect(out).toBe("> _thinking_\n> let me consider\n> two lines");
  });

  it("renders a tool_use as a fenced block of name + input", () => {
    const out = messageToMarkdown(
      msg([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    );
    expect(out).toBe('```bash\n# Bash\n{\n  "command": "ls"\n}\n```');
  });

  it("renders a tool_result as a plain fenced block", () => {
    const out = messageToMarkdown(
      msg([{ type: "tool_result", toolUseId: "t1", content: "output here" }]),
    );
    expect(out).toBe("```\noutput here\n```");
  });

  it("represents an image as a placeholder (binary can't go on the text clipboard)", () => {
    const out = messageToMarkdown(msg([{ type: "image", mediaType: "image/png" }]));
    expect(out).toBe("[image]");
  });

  it("skips empty / whitespace-only text and trims the result", () => {
    const out = messageToMarkdown(
      msg([
        { type: "text", text: "   " },
        { type: "text", text: "real" },
        { type: "text", text: "\n" },
      ]),
    );
    expect(out).toBe("real");
  });

  it("returns an empty string for a message with no copyable content", () => {
    expect(messageToMarkdown(msg([]))).toBe("");
    expect(messageToMarkdown(msg([{ type: "text", text: "  " }]))).toBe("");
  });
});
