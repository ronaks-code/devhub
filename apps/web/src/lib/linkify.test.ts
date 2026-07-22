import { describe, expect, it } from "vitest";
import { linkifyText } from "./linkify.js";

/** Convenience: the kinds linkifyText produced, in order. */
function kinds(input: string): string[] {
  return linkifyText(input).map((t) => t.kind);
}

/** Round-trips: the tokens' values always reconstruct the original input exactly. */
function roundtrips(input: string): boolean {
  return linkifyText(input).map((t) => t.value).join("") === input;
}

describe("linkifyText — intra-word slashes are NOT paths (QA MAJOR)", () => {
  // A "/word" that follows a word character is ordinary prose, not a filesystem
  // path — these used to be promoted to a path chip mid-sentence.
  it.each([
    "and/or",
    "his/her",
    "tactile/vision positioning",
    "nicer, more/polished",
    "$5/mo plan",
    "read/write access",
  ])("leaves %j untouched (no path token)", (text) => {
    const toks = linkifyText(text);
    expect(toks.every((t) => t.kind === "text")).toBe(true);
    expect(roundtrips(text)).toBe(true);
  });
});

describe("linkifyText — real paths and URLs still promote", () => {
  it("promotes an absolute path at a boundary", () => {
    expect(kinds("cd /usr/local/bin now")).toContain("path");
  });
  it("promotes a home path", () => {
    expect(kinds("open ~/proj/file.txt")).toContain("path");
  });
  it("promotes an explicitly-relative dotted path", () => {
    expect(kinds("see ./src/lib/api.ts here")).toContain("path");
  });
  it("promotes a relative dotted path with an extension", () => {
    expect(kinds("edit src/lib/api.ts please")).toContain("path");
  });
  it("promotes an http URL", () => {
    expect(kinds("visit https://example.com/x today")).toContain("url");
  });
  it("always round-trips the original text", () => {
    expect(roundtrips("cd /usr/local/bin && open ~/a/b.txt at https://x.com/y")).toBe(true);
  });
});
