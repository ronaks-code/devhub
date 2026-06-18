import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptIndex } from "../src/index-db.js";
import { toolStats } from "../src/tool-stats.js";
import { projectIdFromCwd } from "../src/paths.js";

/**
 * Hermetic tests for per-tool usage analytics. Each test stands up a TEMP index (its
 * own DB + transcript dir — nothing touches ~/.claude), seeds sessions whose assistant
 * turns invoke several tools (some of whose matching tool_result is flagged is_error),
 * then asserts: invocation counts per tool, the most-used-first ranking + name tiebreak,
 * the totals summary, project/session scoping, the `limit` cap, and the robustness
 * contract (tool-less / empty-scope corpus -> []). The errorCount/avgMs fields degrade
 * gracefully (the index does not persist the is_error flag or per-message timestamps),
 * which these tests pin down so the documented contract can't silently drift.
 */

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-toolstats-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** One assistant tool_use block: "<Tool>: <key input>" gets mirrored as a role="tool" row. */
function toolUse(name: string, input: Record<string, unknown>): unknown {
  return { type: "tool_use", id: `tu-${Math.random().toString(36).slice(2)}`, name, input };
}

/** A user tool_result block (optionally flagged as an error). */
function toolResult(text: string, isError = false): unknown {
  return { type: "tool_result", tool_use_id: "tu1", content: text, is_error: isError };
}

/**
 * Write a minimal transcript that invokes a sequence of tools. Each `tools` entry
 * becomes an assistant tool_use plus a following user tool_result (its `err` flag sets
 * is_error on that result). Carries a fixed `cwd`/`ts` so the session indexes cleanly.
 */
function writeSession(
  dir: string,
  id: string,
  opts: { cwd: string; ts: string; tools: Array<{ name: string; input: Record<string, unknown>; err?: boolean }> },
): string {
  const file = path.join(dir, `${id}.jsonl`);
  let body = jl({
    type: "user",
    cwd: opts.cwd,
    timestamp: opts.ts,
    message: { role: "user", content: "do the work" },
  });
  for (const t of opts.tools) {
    body += jl({
      type: "assistant",
      cwd: opts.cwd,
      timestamp: opts.ts,
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `running ${t.name}` }, toolUse(t.name, t.input)],
        usage: { input_tokens: 6, output_tokens: 3 },
      },
    });
    body += jl({
      type: "user",
      cwd: opts.cwd,
      timestamp: opts.ts,
      message: { role: "user", content: [toolResult(`result of ${t.name}`, t.err)] },
    });
  }
  writeFileSync(file, body);
  return file;
}

describe("toolStats", () => {
  it("counts invocations per tool and ranks most-used first", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/widget";

    // 3x Bash (one errored), 2x Edit, 1x Read.
    const s = writeSession(proj, "s1", {
      cwd,
      ts: "2026-06-10T12:00:00.000Z",
      tools: [
        { name: "Bash", input: { command: "ls" } },
        { name: "Bash", input: { command: "pwd" }, err: true },
        { name: "Bash", input: { command: "git status" } },
        { name: "Edit", input: { file_path: "/a.ts" } },
        { name: "Edit", input: { file_path: "/b.ts" } },
        { name: "Read", input: { file_path: "/c.ts" } },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    const res = idx.toolStats();
    const names = res.tools.map((t) => t.toolName);
    expect(names).toEqual(["Bash", "Edit", "Read"]); // count desc

    const byName = Object.fromEntries(res.tools.map((t) => [t.toolName, t]));
    expect(byName.Bash!.count).toBe(3);
    expect(byName.Edit!.count).toBe(2);
    expect(byName.Read!.count).toBe(1);

    // Totals summary sums the per-tool counts.
    expect(res.summary.tools).toBe(3);
    expect(res.summary.totalInvocations).toBe(6);

    // Errors/durations are not persisted in the index -> graceful 0 / omitted.
    for (const t of res.tools) {
      expect(t.errorCount).toBe(0);
      expect(t.errorRate).toBe(0);
      expect(t.avgMs).toBeUndefined();
    }
    expect(res.summary.totalErrors).toBe(0);
    expect(res.summary.errorRate).toBe(0);

    idx.close();
  });

  it("breaks count ties by tool name (ascending) for a deterministic order", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/tied";

    // One invocation each of Zebra, Alpha, Mango -> all tie at count 1.
    const s = writeSession(proj, "tie", {
      cwd,
      ts: "2026-06-10T12:00:00.000Z",
      tools: [
        { name: "Zebra", input: { x: 1 } },
        { name: "Alpha", input: { x: 1 } },
        { name: "Mango", input: { x: 1 } },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    expect(idx.toolStats().tools.map((t) => t.toolName)).toEqual(["Alpha", "Mango", "Zebra"]);
    idx.close();
  });

  it("narrows correctly when scoped to a single project", async () => {
    const dir = tmp();
    const projA = path.join(dir, "-projA");
    const projB = path.join(dir, "-projB");
    mkdirSync(projA);
    mkdirSync(projB);
    const dbPath = path.join(dir, "i.db");

    // Project A: lots of Bash. Project B: lots of Grep.
    const a = writeSession(projA, "a1", {
      cwd: "/home/dev/alpha",
      ts: "2026-06-10T12:00:00.000Z",
      tools: [
        { name: "Bash", input: { command: "ls" } },
        { name: "Bash", input: { command: "pwd" } },
      ],
    });
    const b = writeSession(projB, "b1", {
      cwd: "/home/dev/beta",
      ts: "2026-06-11T12:00:00.000Z",
      tools: [
        { name: "Grep", input: { pattern: "foo" } },
        { name: "Grep", input: { pattern: "bar" } },
        { name: "Grep", input: { pattern: "baz" } },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(a);
    await idx.indexSession(b);

    // Unscoped sees both tools.
    const all = idx.toolStats();
    expect(all.tools.map((t) => t.toolName).sort()).toEqual(["Bash", "Grep"]);
    expect(all.summary.totalInvocations).toBe(5);

    // The projectId is the stable sha1 of the cwd (same mapping the indexer uses).
    const projAId = projectIdFromCwd("/home/dev/alpha");
    const scoped = idx.toolStats({ projectId: projAId });
    expect(scoped.tools.map((t) => t.toolName)).toEqual(["Bash"]);
    expect(scoped.tools[0]!.count).toBe(2);
    expect(scoped.summary.totalInvocations).toBe(2);

    idx.close();
  });

  it("narrows correctly when scoped to a single session", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/multi";

    const s1 = writeSession(proj, "one", {
      cwd,
      ts: "2026-06-10T12:00:00.000Z",
      tools: [{ name: "Bash", input: { command: "ls" } }],
    });
    const s2 = writeSession(proj, "two", {
      cwd,
      ts: "2026-06-11T12:00:00.000Z",
      tools: [
        { name: "Edit", input: { file_path: "/a.ts" } },
        { name: "Edit", input: { file_path: "/b.ts" } },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s1);
    await idx.indexSession(s2);

    const scoped = idx.toolStats({ sessionId: "two" });
    expect(scoped.tools.map((t) => t.toolName)).toEqual(["Edit"]);
    expect(scoped.tools[0]!.count).toBe(2);
    expect(scoped.summary.totalInvocations).toBe(2);

    idx.close();
  });

  it("caps the ranked output to opts.limit (totals still cover all tools)", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/many";

    // Bash x3, Edit x2, Read x1 -> top-2 by count is Bash, Edit.
    const s = writeSession(proj, "lim", {
      cwd,
      ts: "2026-06-10T12:00:00.000Z",
      tools: [
        { name: "Bash", input: { command: "1" } },
        { name: "Bash", input: { command: "2" } },
        { name: "Bash", input: { command: "3" } },
        { name: "Edit", input: { file_path: "/a" } },
        { name: "Edit", input: { file_path: "/b" } },
        { name: "Read", input: { file_path: "/c" } },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    const res = idx.toolStats({ limit: 2 });
    expect(res.tools.map((t) => t.toolName)).toEqual(["Bash", "Edit"]);
    // The summary still reflects ALL distinct tools / invocations, not just the capped slice.
    expect(res.summary.tools).toBe(3);
    expect(res.summary.totalInvocations).toBe(6);

    idx.close();
  });

  it("returns [] for a tool-less corpus", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");

    // A session with text but NO tool_use blocks.
    const file = path.join(proj, "notools.jsonl");
    writeFileSync(
      file,
      jl({
        type: "user",
        cwd: "/home/dev/quiet",
        timestamp: "2026-06-10T12:00:00.000Z",
        message: { role: "user", content: "just chatting, no tools" },
      }) +
        jl({
          type: "assistant",
          cwd: "/home/dev/quiet",
          timestamp: "2026-06-10T12:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "sure, here is some prose" }],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        }),
    );

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);

    const res = idx.toolStats();
    expect(res.tools).toEqual([]);
    expect(res.summary).toEqual({ tools: 0, totalInvocations: 0, totalErrors: 0, errorRate: 0 });

    idx.close();
  });

  it("returns [] for an empty index and for a scope that matches nothing", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");

    // Empty index: no sessions indexed at all.
    const idx = new TranscriptIndex(dbPath);
    expect(idx.toolStats().tools).toEqual([]);

    // Seed one tool-bearing session, then scope to a session/project that doesn't exist.
    const s = writeSession(proj, "real", {
      cwd: "/home/dev/real",
      ts: "2026-06-10T12:00:00.000Z",
      tools: [{ name: "Bash", input: { command: "ls" } }],
    });
    await idx.indexSession(s);

    expect(idx.toolStats({ sessionId: "nope" }).tools).toEqual([]);
    expect(idx.toolStats({ projectId: "deadbeef" }).tools).toEqual([]);
    // Sanity: the unscoped call still sees the real tool.
    expect(idx.toolStats().tools.map((t) => t.toolName)).toEqual(["Bash"]);

    idx.close();
  });

  it("the module-level function matches the index delegation", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");

    const s = writeSession(proj, "s", {
      cwd: "/home/dev/x",
      ts: "2026-06-10T12:00:00.000Z",
      tools: [
        { name: "Bash", input: { command: "ls" } },
        { name: "Read", input: { file_path: "/a" } },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    // Reach the same DB the index opened, prove the exported function is the engine.
    const viaModule = toolStats((idx as unknown as { db: import("node:sqlite").DatabaseSync }).db);
    expect(idx.toolStats()).toEqual(viaModule);

    idx.close();
  });
});
