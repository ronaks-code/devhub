import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptIndex } from "../src/index-db.js";
import { relatedSessions } from "../src/related.js";

/**
 * Hermetic tests for the "related sessions" ranking. Each test stands up a TEMP index
 * (its own DB + transcript dir — nothing touches ~/.claude), seeds several sessions with
 * deliberately overlapping vs disjoint text / tags / projects / tools / times, then
 * asserts the ranking puts the genuinely-related session(s) first. Also covers the
 * robustness contract: unknown id -> [], the source never appears in its own results,
 * and a text-less session still relates via project/tag/time.
 */

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-related-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** Set a session file's mtime/atime to a fixed instant (drives temporal proximity). */
const setMtime = (file: string, when: Date) => utimesSync(file, when, when);

/**
 * Write a minimal transcript: a user prompt + an assistant reply (optionally with a
 * tool_use), all under `cwd`, carrying an explicit `timestamp` so `lastTs` is stable.
 */
function writeSession(
  dir: string,
  id: string,
  opts: {
    cwd: string;
    userText: string;
    assistantText: string;
    tool?: { name: string; command: string };
    ts: string;
  },
): string {
  const file = path.join(dir, `${id}.jsonl`);
  const assistantContent: unknown[] = [{ type: "text", text: opts.assistantText }];
  if (opts.tool) {
    assistantContent.push({
      type: "tool_use",
      id: "tu1",
      name: opts.tool.name,
      input: { command: opts.tool.command },
    });
  }
  writeFileSync(
    file,
    jl({
      type: "user",
      cwd: opts.cwd,
      timestamp: opts.ts,
      message: { role: "user", content: opts.userText },
    }) +
      jl({
        type: "assistant",
        cwd: opts.cwd,
        timestamp: opts.ts,
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: assistantContent,
          usage: { input_tokens: 8, output_tokens: 4 },
        },
      }),
  );
  return file;
}

describe("relatedSessions", () => {
  it("ranks the session with the most shared significant terms first", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/widget";

    // Source talks about a very distinctive topic.
    const src = writeSession(proj, "src", {
      cwd,
      userText: "debug the websocket reconnection backoff in the kafka consumer",
      assistantText: "The websocket backoff retries the kafka consumer subscription.",
      ts: "2026-06-10T12:00:00.000Z",
    });
    // Strongly related: shares the rare topical terms (websocket / kafka / backoff).
    const strong = writeSession(proj, "strong", {
      cwd,
      userText: "the kafka consumer keeps dropping the websocket connection",
      assistantText: "Add exponential backoff before re-subscribing the kafka consumer.",
      ts: "2026-06-10T13:00:00.000Z",
    });
    // Weakly related: one shared term, otherwise different topic.
    const weak = writeSession(proj, "weak", {
      cwd,
      userText: "tweak the css grid layout for the dashboard sidebar",
      assistantText: "Adjusted the websocket-status badge in the dashboard sidebar.",
      ts: "2026-06-10T14:00:00.000Z",
    });
    // Unrelated: completely disjoint vocabulary, different project.
    const off = writeSession(proj, "off", {
      cwd: "/home/dev/cookbook",
      userText: "convert the sourdough recipe to metric measurements",
      assistantText: "Scaled the flour and water grams for the sourdough loaf.",
      ts: "2026-06-10T15:00:00.000Z",
    });

    const idx = new TranscriptIndex(dbPath);
    for (const f of [src, strong, weak, off]) await idx.indexSession(f);

    const related = idx.relatedSessions("src");
    const ids = related.map((r) => r.sessionId);

    // Source is never in its own results.
    expect(ids).not.toContain("src");
    // The strongly-related session ranks first.
    expect(ids[0]).toBe("strong");
    // The weakly-related session is present but ranks below the strong one.
    expect(ids).toContain("weak");
    expect(ids.indexOf("strong")).toBeLessThan(ids.indexOf("weak"));
    // The strong hit's score beats the weak hit's, and it explains itself.
    const strongHit = related.find((r) => r.sessionId === "strong")!;
    const weakHit = related.find((r) => r.sessionId === "weak")!;
    expect(strongHit.score).toBeGreaterThan(weakHit.score);
    expect(strongHit.reason).toMatch(/shared term/);

    idx.close();
  });

  it("returns [] for an unknown sessionId", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(
      writeSession(proj, "only", {
        cwd: "/home/dev/x",
        userText: "hello there",
        assistantText: "general kenobi",
        ts: "2026-06-10T12:00:00.000Z",
      }),
    );

    expect(idx.relatedSessions("does-not-exist")).toEqual([]);
    expect(idx.relatedSessions("")).toEqual([]);
    // A lone indexed session has no neighbours -> [].
    expect(idx.relatedSessions("only")).toEqual([]);
    idx.close();
  });

  it("never includes the source session in its own results", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/repeat";

    // Two near-identical sessions: the source must still be excluded from its own list.
    const a = writeSession(proj, "alpha", {
      cwd,
      userText: "investigate the flaky integration test for the payment gateway",
      assistantText: "The payment gateway integration test races on the webhook.",
      ts: "2026-06-11T09:00:00.000Z",
    });
    const b = writeSession(proj, "beta", {
      cwd,
      userText: "the payment gateway integration test is flaky again",
      assistantText: "Stabilized the payment gateway webhook in the integration test.",
      ts: "2026-06-11T10:00:00.000Z",
    });
    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(a);
    await idx.indexSession(b);

    const fromAlpha = idx.relatedSessions("alpha");
    expect(fromAlpha.map((r) => r.sessionId)).not.toContain("alpha");
    expect(fromAlpha.map((r) => r.sessionId)).toContain("beta");

    const fromBeta = idx.relatedSessions("beta");
    expect(fromBeta.map((r) => r.sessionId)).not.toContain("beta");
    expect(fromBeta.map((r) => r.sessionId)).toContain("alpha");
    idx.close();
  });

  it("falls back to project/tag/time signals when the source has no indexed text", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/sharedproj";

    // The source transcript carries NO renderable conversation text (only a tool_use),
    // so it contributes no term signal — relatedness must come from project + tags.
    const emptyFile = path.join(proj, "empty.jsonl");
    writeFileSync(
      emptyFile,
      jl({
        type: "assistant",
        cwd,
        timestamp: "2026-06-12T08:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la" } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    setMtime(emptyFile, new Date("2026-06-12T08:00:00.000Z"));

    // Same project + (after tagging) a shared tag, near in time -> should relate.
    const sameProj = writeSession(proj, "sibling", {
      cwd,
      userText: "add a healthcheck endpoint",
      assistantText: "Added /healthz returning 200.",
      ts: "2026-06-12T08:30:00.000Z",
    });
    // Different project, no shared tag, far in time -> should NOT relate to the empty src.
    const otherProj = writeSession(proj, "stranger", {
      cwd: "/home/dev/unrelated",
      userText: "rename the marketing copy",
      assistantText: "Updated the hero headline.",
      ts: "2025-01-01T00:00:00.000Z",
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(emptyFile);
    await idx.indexSession(sameProj);
    await idx.indexSession(otherProj);

    // Give the source and its sibling a shared tag so the tag signal also fires.
    idx.setTags("empty", ["infra"]);
    idx.setTags("sibling", ["infra"]);

    const related = idx.relatedSessions("empty");
    const ids = related.map((r) => r.sessionId);

    expect(ids).toContain("sibling");
    expect(ids).not.toContain("empty");
    // The same-project + shared-tag sibling outranks the unrelated stranger (which only
    // qualifies, if at all, on nothing the source shares).
    if (ids.includes("stranger")) {
      expect(ids.indexOf("sibling")).toBeLessThan(ids.indexOf("stranger"));
    }
    // The sibling's reason names the structural signals (no term overlap was possible).
    const sib = related.find((r) => r.sessionId === "sibling")!;
    expect(sib.reason).toMatch(/same project|shared tag/);
    idx.close();
  });

  it("rewards shared tags and respects the limit + ordering", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");

    const idx = new TranscriptIndex(dbPath);
    // Five disjoint-topic sessions across DIFFERENT projects, each using a UNIQUE
    // made-up vocabulary (no token shared between any two), so the ONLY signal that can
    // relate them is the tag we assign — isolates the tag signal.
    const vocab = [
      ["aardvark", "zucchini", "blorptang"],
      ["flummox", "quokka", "vexilloid"],
      ["mangosteen", "drumlin", "syzygy"],
      ["bivouac", "kerfuffle", "nimbose"],
      ["wabbit", "frumious", "borogove"],
    ];
    for (let i = 0; i < 5; i++) {
      const [w1, w2, w3] = vocab[i]!;
      const f = writeSession(proj, `s${i}`, {
        cwd: `/home/dev/p${i}`,
        userText: `${w1} ${w2}`,
        assistantText: `${w3} ${w1}`,
        ts: `2026-06-13T0${i}:00:00.000Z`,
      });
      await idx.indexSession(f);
    }
    // Source = s0. Tag s0, s1, s2 with "release"; s3, s4 stay untagged + unrelated.
    idx.setTags("s0", ["release"]);
    idx.setTags("s1", ["release"]);
    idx.setTags("s2", ["release"]);

    const related = idx.relatedSessions("s0", { limit: 10 });
    const ids = related.map((r) => r.sessionId);
    // Only the two tag-sharing siblings relate; the untagged, disjoint ones don't.
    expect(ids).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(ids).not.toContain("s3");
    expect(ids).not.toContain("s4");
    expect(ids).not.toContain("s0");
    for (const r of related) expect(r.reason).toMatch(/shared tag/);

    // The limit caps results.
    expect(idx.relatedSessions("s0", { limit: 1 })).toHaveLength(1);
    idx.close();
  });

  it("works through the standalone relatedSessions(db, …) export too", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/lib";

    const a = writeSession(proj, "one", {
      cwd,
      userText: "implement the lru cache eviction policy",
      assistantText: "The lru cache evicts the least-recently-used entry.",
      ts: "2026-06-14T10:00:00.000Z",
    });
    const b = writeSession(proj, "two", {
      cwd,
      userText: "the lru cache eviction is evicting too eagerly",
      assistantText: "Tuned the lru cache eviction threshold.",
      ts: "2026-06-14T11:00:00.000Z",
    });
    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(a);
    await idx.indexSession(b);

    // Reach into the same DB connection the index uses (cast around the private field),
    // exercising the module-level function directly with a real index DB.
    const db = (idx as unknown as { db: Parameters<typeof relatedSessions>[0] }).db;
    const out = relatedSessions(db, "one");
    expect(out.map((r) => r.sessionId)).toEqual(["two"]);
    expect(out[0]!.score).toBeGreaterThan(0);
    idx.close();
  });
});
