import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptIndex } from "../src/index-db.js";
import { projectOverview } from "../src/project-overview.js";
import { costUsd } from "../src/pricing.js";
import { projectIdFromCwd } from "../src/paths.js";

/**
 * Hermetic tests for the per-project deep-dive aggregate. Each test stands up a TEMP
 * index (its own DB + transcript dir — nothing touches ~/.claude), seeds several sessions
 * across 2 models / multiple days, some invoking tools and carrying tags, then asserts the
 * assembled overview: headline sessionCount/tokens/cost, the per-model split (cost-sorted),
 * the top-tools ranking, the daily-cost buckets, the tag cloud, and the robustness contract
 * (unknown project -> a well-formed empty overview). The overview is built from a FEW bounded
 * queries (one GROUP BY model + reused toolStats/dailyUsage + one indexed tag join), never a
 * per-session query loop — see project-overview.ts.
 */

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-projoverview-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** One assistant tool_use block (mirrored as a role="tool" invocation row by indexing). */
function toolUse(name: string, input: Record<string, unknown>): unknown {
  return { type: "tool_use", id: `tu-${Math.random().toString(36).slice(2)}`, name, input };
}

/**
 * Write a minimal transcript on a given cwd/model/day, with explicit token usage and an
 * optional list of tool invocations. The session's lastTs (and so its daily bucket) is the
 * `ts` we stamp on every line.
 */
function writeSession(
  dir: string,
  id: string,
  opts: {
    cwd: string;
    ts: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    tools?: string[];
  },
): string {
  const file = path.join(dir, `${id}.jsonl`);
  let body = jl({
    type: "user",
    cwd: opts.cwd,
    timestamp: opts.ts,
    message: { role: "user", content: "do the work" },
  });
  const content: unknown[] = [{ type: "text", text: "working" }];
  for (const t of opts.tools ?? []) content.push(toolUse(t, { x: 1 }));
  body += jl({
    type: "assistant",
    cwd: opts.cwd,
    timestamp: opts.ts,
    message: {
      role: "assistant",
      model: opts.model,
      content,
      usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
    },
  });
  // A matching tool_result for each tool_use so the invocation is well-formed.
  for (const t of opts.tools ?? []) {
    body += jl({
      type: "user",
      cwd: opts.cwd,
      timestamp: opts.ts,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: `ok ${t}` }] },
    });
  }
  writeFileSync(file, body);
  return file;
}

describe("projectOverview", () => {
  it("assembles headline totals, per-model split, top tools, daily cost, and tag cloud", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/widget";

    // Three sessions in ONE project, across 2 models and 2 days:
    //   s1: opus, day-01, 100 in / 50 out, tools [Bash, Bash, Edit]
    //   s2: opus, day-01, 200 in / 100 out, tools [Bash]
    //   s3: sonnet, day-02, 400 in / 200 out, tools [Read]
    const s1 = writeSession(proj, "s1", {
      cwd,
      ts: "2026-06-10T09:00:00.000Z",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      tools: ["Bash", "Bash", "Edit"],
    });
    const s2 = writeSession(proj, "s2", {
      cwd,
      ts: "2026-06-10T15:00:00.000Z",
      model: "claude-opus-4-8",
      inputTokens: 200,
      outputTokens: 100,
      tools: ["Bash"],
    });
    const s3 = writeSession(proj, "s3", {
      cwd,
      ts: "2026-06-11T12:00:00.000Z",
      model: "claude-sonnet-4-6",
      inputTokens: 400,
      outputTokens: 200,
      tools: ["Read"],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s1);
    await idx.indexSession(s2);
    await idx.indexSession(s3);

    const projectId = projectIdFromCwd(cwd);
    const ov = idx.projectOverview(projectId);

    // Identity + headline.
    expect(ov.projectId).toBe(projectId);
    expect(ov.cwd).toBe(cwd);
    expect(ov.name).toBe("widget");
    expect(ov.sessionCount).toBe(3);
    // Total tokens = sum of all four buckets (no cache here) = 150 + 300 + 600 = 1050.
    expect(ov.totalTokens).toBe(1050);
    // firstTs/lastTs are the min/max session activity timestamps.
    expect(ov.firstTs).toBe("2026-06-10T09:00:00.000Z");
    expect(ov.lastTs).toBe("2026-06-11T12:00:00.000Z");

    // Per-model split: opus = 2 sessions (150 + 300 = 450 tokens), sonnet = 1 (600 tokens).
    const byModel = Object.fromEntries(ov.byModel.map((m) => [m.model, m]));
    expect(byModel["claude-opus-4-8"]!.sessions).toBe(2);
    expect(byModel["claude-opus-4-8"]!.tokens).toBe(450);
    expect(byModel["claude-sonnet-4-6"]!.sessions).toBe(1);
    expect(byModel["claude-sonnet-4-6"]!.tokens).toBe(600);

    // Per-model cost = model-priced grouped token sums. Opus = 5/Mtok in, 25/Mtok out.
    const opusCost = costUsd("claude-opus-4-8", {
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const sonnetCost = costUsd("claude-sonnet-4-6", {
      inputTokens: 400,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(byModel["claude-opus-4-8"]!.costUsd).toBeCloseTo(opusCost, 10);
    expect(byModel["claude-sonnet-4-6"]!.costUsd).toBeCloseTo(sonnetCost, 10);
    expect(ov.totalCostUsd).toBeCloseTo(opusCost + sonnetCost, 10);

    // byModel is sorted by cost descending.
    const costs = ov.byModel.map((m) => m.costUsd);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);

    // Top tools: Bash x3 (most used), then Edit x1 / Read x1 (tie broken by name asc).
    expect(ov.topTools.map((t) => t.toolName)).toEqual(["Bash", "Edit", "Read"]);
    expect(ov.topTools[0]!.count).toBe(3);
    for (const t of ov.topTools) expect(t.errorRate).toBe(0);

    // Daily cost: 2 distinct days, oldest first; per-day tokens sum the buckets.
    expect(ov.dailyCost.map((d) => d.day)).toEqual(["2026-06-10", "2026-06-11"]);
    expect(ov.dailyCost[0]!.tokens).toBe(450); // 150 + 300 on 06-10
    expect(ov.dailyCost[1]!.tokens).toBe(600); // 600 on 06-11

    // Tag cloud: tag two sessions "backend", one "api". counts: backend=2, api=1.
    idx.tags.set("s1", ["backend", "api"]);
    idx.tags.set("s2", ["backend"]);
    const tagged = idx.projectOverview(projectId);
    expect(tagged.tagCloud).toEqual([
      { tag: "backend", count: 2 },
      { tag: "api", count: 1 },
    ]);

    idx.close();
  });

  it("scopes strictly to the one project (other projects don't leak in)", async () => {
    const dir = tmp();
    const projA = path.join(dir, "-projA");
    const projB = path.join(dir, "-projB");
    mkdirSync(projA);
    mkdirSync(projB);
    const dbPath = path.join(dir, "i.db");

    const a = writeSession(projA, "a1", {
      cwd: "/home/dev/alpha",
      ts: "2026-06-10T12:00:00.000Z",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      tools: ["Bash", "Bash"],
    });
    const b = writeSession(projB, "b1", {
      cwd: "/home/dev/beta",
      ts: "2026-06-11T12:00:00.000Z",
      model: "claude-sonnet-4-6",
      inputTokens: 999,
      outputTokens: 999,
      tools: ["Grep", "Grep", "Grep"],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(a);
    await idx.indexSession(b);

    const ovA = idx.projectOverview(projectIdFromCwd("/home/dev/alpha"));
    expect(ovA.sessionCount).toBe(1);
    expect(ovA.name).toBe("alpha");
    expect(ovA.byModel.map((m) => m.model)).toEqual(["claude-opus-4-8"]);
    // Only project A's tool shows up — project B's Grep is excluded by the scope.
    expect(ovA.topTools.map((t) => t.toolName)).toEqual(["Bash"]);
    expect(ovA.topTools[0]!.count).toBe(2);
    expect(ovA.dailyCost.map((d) => d.day)).toEqual(["2026-06-10"]);

    idx.close();
  });

  it("returns a well-formed empty overview for an unknown project (never throws)", () => {
    const dir = tmp();
    const dbPath = path.join(dir, "i.db");
    const idx = new TranscriptIndex(dbPath);

    const ov = idx.projectOverview("deadbeefcafe");
    expect(ov).toEqual({
      projectId: "deadbeefcafe",
      cwd: null,
      name: null,
      sessionCount: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      firstTs: null,
      lastTs: null,
      byModel: [],
      topTools: [],
      dailyCost: [],
      tagCloud: [],
    });

    idx.close();
  });

  it("the module-level function matches the index delegation", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/x";

    const s = writeSession(proj, "s", {
      cwd,
      ts: "2026-06-10T12:00:00.000Z",
      model: "claude-opus-4-8",
      inputTokens: 10,
      outputTokens: 5,
      tools: ["Bash"],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    const projectId = projectIdFromCwd(cwd);
    // Reach the same DB the index opened, prove the exported function is the engine.
    const viaModule = projectOverview(
      (idx as unknown as { db: import("node:sqlite").DatabaseSync }).db,
      projectId,
    );
    expect(idx.projectOverview(projectId)).toEqual(viaModule);

    idx.close();
  });
});
