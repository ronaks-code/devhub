import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptIndex } from "../src/index-db.js";
import { buildMatchExpr, parseQueryTerms } from "../src/search.js";

// FTS5 has its own query mini-language (quotes, NEAR, *, parentheses, AND/OR/NOT,
// colons). Feeding a raw user query straight into `messages_fts MATCH` would let a
// stray metacharacter raise a SQLite "fts5: syntax error". src/search.ts neutralizes
// this by quoting every term as an FTS5 string literal (buildMatchExpr). These tests
// prove that special-char queries return (possibly empty) results WITHOUT throwing a
// SQLite syntax error. Hermetic: a temp DB + temp project dir; nothing touches ~/.claude.

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-query-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** Build a small index with a couple of real-text sessions to search against. */
const buildIndex = async () => {
  const dir = tmp();
  const proj = path.join(dir, "-proj");
  mkdirSync(proj);
  const cwd = "/home/dev/query-shop";
  const mk = (id: string, text: string) => {
    const p = path.join(proj, `${id}.jsonl`);
    writeFileSync(p, jl({ type: "user", cwd, message: { role: "user", content: text } }));
    return p;
  };
  const idx = new TranscriptIndex(path.join(dir, "i.db"));
  await idx.indexSession(mk("s1", "the checkout button uses stripe NEAR the cart"));
  await idx.indexSession(mk("s2", 'a "quoted" phrase and (parens) with OR words'));
  await idx.indexSession(mk("s3", "emoji 🚀 and a-hyphenated:colon term"));
  return idx;
};

// Each of these would be a valid-looking FTS5 metacharacter sequence that, fed raw to
// MATCH, could raise a syntax error. They must all be tolerated.
const SPECIAL_QUERIES: Array<[label: string, query: string]> = [
  ["a bare double quote", '"'],
  ["unbalanced opening quote", 'checkout "stripe'],
  ["unbalanced closing quote", 'checkout stripe"'],
  ["the NEAR operator", "NEAR(checkout cart, 3)"],
  ["a bare asterisk", "*"],
  ["leading asterisk", "*checkout"],
  ["parentheses", "(checkout OR stripe)"],
  ["uppercase boolean operators", "checkout AND stripe OR cart NOT widget"],
  ["a colon (column filter syntax)", "checkout:stripe"],
  ["a caret (column weight)", "^checkout"],
  ["a plus", "+checkout +stripe"],
  ["only a hyphen", "-"],
  ["double hyphen", "--checkout"],
  ["an emoji", "🚀"],
  ["mixed metacharacters", '*(checkout) NEAR "stripe : ^ -'],
  ["braces and brackets", "{checkout} [stripe]"],
  ["a trailing backslash", "checkout\\"],
  ["a very long string", "x ".repeat(5000)],
  ["a very long single token", "a".repeat(20000)],
  ["whitespace only", "   \t  "],
  ["a lone OR", "OR"],
  ["a lone AND", "AND"],
];

describe("search tolerates FTS5 special characters (no SQLite syntax error)", () => {
  it.each(SPECIAL_QUERIES)("query: %s", async (_label, query) => {
    const idx = await buildIndex();
    try {
      let hits: unknown;
      expect(() => {
        hits = idx.search(query);
      }).not.toThrow();
      // Whatever comes back must be an array (possibly empty) — never an exception.
      expect(Array.isArray(hits)).toBe(true);
    } finally {
      idx.close();
    }
  });

  it("a plain query still works after the special-char gauntlet (regression guard)", async () => {
    const idx = await buildIndex();
    try {
      expect(idx.search("checkout").map((h) => h.sessionId)).toContain("s1");
      expect(idx.search("phrase").map((h) => h.sessionId)).toContain("s2");
    } finally {
      idx.close();
    }
  });

  it("searchInSession also tolerates special characters", async () => {
    const idx = await buildIndex();
    try {
      for (const [, query] of SPECIAL_QUERIES) {
        expect(() => idx.searchInSession("s1", query)).not.toThrow();
      }
    } finally {
      idx.close();
    }
  });

  it("facet-only queries with special-char free text do not throw", async () => {
    const idx = await buildIndex();
    try {
      // A recognized facet token plus special free text: parsed, special chars quoted.
      expect(() => idx.search('role:user "')).not.toThrow();
      expect(() => idx.search("tool:Bash NEAR(x y)")).not.toThrow();
    } finally {
      idx.close();
    }
  });
});

describe("buildMatchExpr quotes terms so metacharacters are inert", () => {
  it("returns null for a query with no positive term (pure negation / empty)", () => {
    expect(buildMatchExpr("")).toBeNull();
    expect(buildMatchExpr("   ")).toBeNull();
    expect(buildMatchExpr("-stripe")).toBeNull();
  });

  it("wraps each term in double quotes, doubling embedded quotes (FTS5 string literal)", () => {
    // A term containing a quote must become a quote-doubled FTS5 literal, never a
    // bareword that FTS5 would parse as an operator/phrase boundary.
    const expr = buildMatchExpr('say"hi');
    expect(expr).toContain('""'); // the embedded " was doubled
    expect(expr!.startsWith('"')).toBe(true);
  });

  it("AND/OR/NEAR typed as words become quoted terms, not FTS5 operators", () => {
    const expr = buildMatchExpr("checkout AND stripe")!;
    // Three quoted literals AND-ed together (our implicit AND), not FTS5's AND keyword.
    expect((expr.match(/"/g) ?? []).length).toBe(6); // 3 terms * 2 quotes each
    expect(expr).toContain('"AND"'); // the literal word AND is a quoted term
  });

  it("parseQueryTerms keeps a trailing-* as a prefix and -term as an exclusion", () => {
    const terms = parseQueryTerms("data* -stripe");
    expect(terms.find((t) => t.text === "data")?.prefix).toBe(true);
    expect(terms.find((t) => t.text === "stripe")?.exclude).toBe(true);
  });
});
