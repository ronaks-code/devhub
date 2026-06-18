import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TranscriptIndex } from "../src/index-db.js";
import { Engine } from "../src/index.js";
import { projectIdFromCwd } from "../src/paths.js";

/**
 * Hermetic tests for the W28 `tool_calls` analytics sidecar and the force-reindex path.
 *
 * Unlike the message-text mirror (fixed FTS5 columns), `tool_calls` is a regular table
 * the indexer populates with one row per assistant tool_use — paired with its matching
 * tool_result's is_error flag (by tool_use_id) and a use→result timestamp-delta duration.
 * That unlocks REAL errorRate + avgMs in toolStats. These tests prove:
 *   - indexing populates tool_calls with the correct isError + durationMs;
 *   - toolStats now reports real errorRate / avgMs (and the totals summary);
 *   - re-indexing the same session is idempotent (stable rowids -> no duplicate rows);
 *   - indexAll({ force:true }) re-indexes a session whose mtime/size are UNCHANGED (the
 *     backfill path), where a default indexAll would skip it as "unchanged".
 * Everything runs against a TEMP index (own DB + transcript dir) — nothing touches ~/.claude.
 */

// node:sqlite is a newer builtin vitest's module graph won't resolve; require it natively
// (the same trick index-db.ts uses) so we can read the exact rows the indexer wrote.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-toolcalls-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** A spec for one tool invocation: name, a tool_use id, an err flag, and a duration in ms. */
interface ToolSpec {
  name: string;
  id: string;
  err?: boolean;
  /** ms between the tool_use line and its tool_result line (sets durationMs). */
  durMs?: number;
}

/**
 * Write a transcript that invokes a sequence of tools. Each spec emits an assistant
 * tool_use (id=`spec.id`) at time `base`, then a user tool_result (tool_use_id=`spec.id`,
 * is_error=`spec.err`) `spec.durMs` ms later — so the indexer can PAIR them by id and
 * compute a real duration. ids match across use/result so pairing actually fires.
 */
function writeSession(
  dir: string,
  id: string,
  opts: { cwd: string; baseMs: number; tools: ToolSpec[] },
): string {
  const file = path.join(dir, `${id}.jsonl`);
  const iso = (ms: number) => new Date(ms).toISOString();
  let t = opts.baseMs;
  let body = jl({
    type: "user",
    cwd: opts.cwd,
    timestamp: iso(t),
    message: { role: "user", content: "do the work" },
  });
  for (const spec of opts.tools) {
    const useTs = t;
    body += jl({
      type: "assistant",
      cwd: opts.cwd,
      timestamp: iso(useTs),
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: `running ${spec.name}` },
          { type: "tool_use", id: spec.id, name: spec.name, input: { x: 1 } },
        ],
        usage: { input_tokens: 6, output_tokens: 3 },
      },
    });
    const resultTs = useTs + (spec.durMs ?? 0);
    body += jl({
      type: "user",
      cwd: opts.cwd,
      timestamp: iso(resultTs),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: spec.id, content: `result of ${spec.name}`, is_error: !!spec.err },
        ],
      },
    });
    t = resultTs + 1000; // advance past this result before the next tool
  }
  writeFileSync(file, body);
  return file;
}

/** Read the raw tool_calls rows the indexer wrote, sorted for stable equality. */
function toolCallRows(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        `SELECT sessionId, seq, toolName, isError, ts, durationMs
         FROM tool_calls ORDER BY sessionId, seq, toolName`,
      )
      .all()
      .map((r) => {
        const o = r as Record<string, unknown>;
        return {
          sessionId: o.sessionId,
          seq: Number(o.seq),
          toolName: o.toolName,
          isError: Number(o.isError),
          ts: o.ts,
          durationMs: o.durationMs == null ? null : Number(o.durationMs),
        };
      });
  } finally {
    db.close();
  }
}

const countToolCalls = (dbPath: string): number => {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM tool_calls").get() as { c: number }).c;
  } finally {
    db.close();
  }
};

/** Bump the file's mtime so a default indexSession does a real (full) re-index pass. */
const bumpMtime = (file: string, n: number) => {
  const t = new Date(2026, 0, 1, 0, 0, n);
  utimesSync(file, t, t);
};

describe("tool_calls sidecar population", () => {
  it("records one row per tool_use with the matching isError + a use->result duration", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/sidecar";

    // 3 tools: Bash ok (200ms), Bash errored (500ms), Read ok (no duration: same ts).
    const base = Date.UTC(2026, 5, 10, 12, 0, 0);
    const s = writeSession(proj, "s1", {
      cwd,
      baseMs: base,
      tools: [
        { name: "Bash", id: "u1", durMs: 200 },
        { name: "Bash", id: "u2", err: true, durMs: 500 },
        { name: "Read", id: "u3" }, // durMs 0 -> ts equal -> durationMs 0
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    const rows = toolCallRows(dbPath);
    expect(rows.length).toBe(3);

    // Each call carries the right tool, isError, a non-null ts, and the expected duration.
    const bashOk = rows.find((r) => r.toolName === "Bash" && r.isError === 0)!;
    const bashErr = rows.find((r) => r.toolName === "Bash" && r.isError === 1)!;
    const read = rows.find((r) => r.toolName === "Read")!;
    expect(bashOk.durationMs).toBe(200);
    expect(bashErr.durationMs).toBe(500);
    expect(read.isError).toBe(0);
    expect(read.durationMs).toBe(0);
    for (const r of rows) expect(typeof r.ts).toBe("string");

    idx.close();
  });

  it("leaves durationMs null when a tool_use has no matching tool_result", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/unpaired";

    // An assistant tool_use whose result never arrives (no pairing).
    const file = path.join(proj, "lonely.jsonl");
    const ts = new Date(Date.UTC(2026, 5, 10, 9, 0, 0)).toISOString();
    writeFileSync(
      file,
      jl({ type: "user", cwd, timestamp: ts, message: { role: "user", content: "go" } }) +
        jl({
          type: "assistant",
          cwd,
          timestamp: ts,
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "tool_use", id: "orphan", name: "Glob", input: { pattern: "*" } }],
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        }),
    );

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);

    const rows = toolCallRows(dbPath);
    expect(rows.length).toBe(1);
    expect(rows[0]!.toolName).toBe("Glob");
    expect(rows[0]!.isError).toBe(0);
    expect(rows[0]!.durationMs).toBeNull();

    idx.close();
  });
});

describe("toolStats backed by tool_calls (real errorRate + avgMs)", () => {
  it("reports real errorCount/errorRate and avgMs from the sidecar", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/real";

    // Bash x4 (1 errored): durations 100,200,300,400 -> avg 250. Edit x2 (both ok): 1000,2000 -> avg 1500.
    const base = Date.UTC(2026, 5, 11, 8, 0, 0);
    const s = writeSession(proj, "real", {
      cwd,
      baseMs: base,
      tools: [
        { name: "Bash", id: "b1", durMs: 100 },
        { name: "Bash", id: "b2", durMs: 200 },
        { name: "Bash", id: "b3", durMs: 300, err: true },
        { name: "Bash", id: "b4", durMs: 400 },
        { name: "Edit", id: "e1", durMs: 1000 },
        { name: "Edit", id: "e2", durMs: 2000 },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    const res = idx.toolStats();
    const byName = Object.fromEntries(res.tools.map((t) => [t.toolName, t]));

    expect(byName.Bash!.count).toBe(4);
    expect(byName.Bash!.errorCount).toBe(1);
    expect(byName.Bash!.errorRate).toBeCloseTo(0.25, 6);
    expect(byName.Bash!.avgMs).toBe(250);

    expect(byName.Edit!.count).toBe(2);
    expect(byName.Edit!.errorCount).toBe(0);
    expect(byName.Edit!.errorRate).toBe(0);
    expect(byName.Edit!.avgMs).toBe(1500);

    // Totals: 6 invocations, 1 error -> errorRate 1/6.
    expect(res.summary.totalInvocations).toBe(6);
    expect(res.summary.totalErrors).toBe(1);
    expect(res.summary.errorRate).toBeCloseTo(1 / 6, 6);

    idx.close();
  });

  it("scopes errorRate/avgMs to a single project and session", async () => {
    const dir = tmp();
    const projA = path.join(dir, "-a");
    const projB = path.join(dir, "-b");
    mkdirSync(projA);
    mkdirSync(projB);
    const dbPath = path.join(dir, "i.db");

    const a = writeSession(projA, "a1", {
      cwd: "/home/dev/alpha",
      baseMs: Date.UTC(2026, 5, 10, 0, 0, 0),
      tools: [
        { name: "Bash", id: "a-1", durMs: 100, err: true },
        { name: "Bash", id: "a-2", durMs: 300 },
      ],
    });
    const b = writeSession(projB, "b1", {
      cwd: "/home/dev/beta",
      baseMs: Date.UTC(2026, 5, 11, 0, 0, 0),
      tools: [{ name: "Grep", id: "g-1", durMs: 50 }],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(a);
    await idx.indexSession(b);

    const scopedProj = idx.toolStats({ projectId: projectIdFromCwd("/home/dev/alpha") });
    expect(scopedProj.tools.map((t) => t.toolName)).toEqual(["Bash"]);
    expect(scopedProj.tools[0]!.errorCount).toBe(1);
    expect(scopedProj.tools[0]!.errorRate).toBe(0.5);
    expect(scopedProj.tools[0]!.avgMs).toBe(200); // (100+300)/2

    const scopedSession = idx.toolStats({ sessionId: "b1" });
    expect(scopedSession.tools.map((t) => t.toolName)).toEqual(["Grep"]);
    expect(scopedSession.tools[0]!.avgMs).toBe(50);
    expect(scopedSession.tools[0]!.errorCount).toBe(0);

    idx.close();
  });

  it("omits avgMs for a tool whose calls carried no usable duration", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");

    // A tool_use with no result -> no duration -> AVG over NULL is NULL -> avgMs omitted.
    const file = path.join(proj, "nodur.jsonl");
    const ts = new Date(Date.UTC(2026, 5, 10, 7, 0, 0)).toISOString();
    writeFileSync(
      file,
      jl({ type: "user", cwd: "/home/dev/nodur", timestamp: ts, message: { role: "user", content: "go" } }) +
        jl({
          type: "assistant",
          cwd: "/home/dev/nodur",
          timestamp: ts,
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "tool_use", id: "x", name: "WebFetch", input: { url: "u" } }],
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        }),
    );

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);

    const res = idx.toolStats();
    expect(res.tools[0]!.toolName).toBe("WebFetch");
    expect(res.tools[0]!.count).toBe(1);
    expect(res.tools[0]!.avgMs).toBeUndefined();

    idx.close();
  });

  it("falls back to the mirror COUNT for a scope with no tool_calls rows (never regresses)", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/legacy";

    const s = writeSession(proj, "legacy", {
      cwd,
      baseMs: Date.UTC(2026, 5, 10, 6, 0, 0),
      tools: [
        { name: "Bash", id: "l1", durMs: 100 },
        { name: "Bash", id: "l2", durMs: 200, err: true },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    // Simulate a pre-W28 session: wipe its tool_calls rows but keep the mirror rows.
    const db = (idx as unknown as { db: InstanceType<typeof DatabaseSync> }).db;
    db.prepare("DELETE FROM tool_calls").run();
    expect(countToolCalls(dbPath)).toBe(0);

    // toolStats still returns the per-tool COUNT from the mirror (graceful degradation):
    // counts are real, but errors are 0 and avgMs omitted (the mirror can't derive them).
    const res = idx.toolStats();
    expect(res.tools.map((t) => t.toolName)).toEqual(["Bash"]);
    expect(res.tools[0]!.count).toBe(2);
    expect(res.tools[0]!.errorCount).toBe(0);
    expect(res.tools[0]!.avgMs).toBeUndefined();
    expect(res.summary.totalInvocations).toBe(2);
    expect(res.summary.totalErrors).toBe(0);

    idx.close();
  });
});

describe("tool_calls re-index idempotency", () => {
  it("re-indexing the same session does not duplicate tool_calls rows", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/idem";

    const s = writeSession(proj, "idem", {
      cwd,
      baseMs: Date.UTC(2026, 5, 10, 5, 0, 0),
      tools: [
        { name: "Bash", id: "i1", durMs: 100, err: true },
        { name: "Edit", id: "i2", durMs: 200 },
      ],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);
    const first = toolCallRows(dbPath);
    expect(first.length).toBe(2);

    // Force several FULL re-index passes (changed mtime, unchanged content): stable rowids
    // must reproduce the exact same rows with no growth.
    for (let i = 1; i <= 4; i++) {
      bumpMtime(s, i);
      await idx.indexSession(s);
      const snap = toolCallRows(dbPath);
      expect(snap.length).toBe(2); // no duplicates
      expect(snap).toEqual(first); // byte-for-byte identical (isError + duration preserved)
    }

    idx.close();
  });
});

describe("tool_calls under the worker parse path", () => {
  it("the worker (CLAUDE_UI_INDEX_WORKER) produces identical tool_calls rows to the sync path", async () => {
    const dir = tmp();
    const projSync = path.join(dir, "-sync");
    const projWk = path.join(dir, "-wk");
    mkdirSync(projSync);
    mkdirSync(projWk);
    const cwd = "/home/dev/wkparity";
    const tools: ToolSpec[] = [
      { name: "Bash", id: "w1", durMs: 100, err: true },
      { name: "Edit", id: "w2", durMs: 250 },
    ];
    const base = Date.UTC(2026, 5, 10, 2, 0, 0);
    writeSession(projSync, "sess", { cwd, baseMs: base, tools });
    writeSession(projWk, "sess", { cwd, baseMs: base, tools });

    const prev = process.env.CLAUDE_UI_INDEX_WORKER;
    delete process.env.CLAUDE_UI_INDEX_WORKER;
    const syncDb = path.join(dir, "sync.db");
    const syncIdx = new TranscriptIndex(syncDb);
    await syncIdx.indexSession(path.join(projSync, "sess.jsonl"));
    const syncRows = toolCallRows(syncDb);
    syncIdx.close();

    process.env.CLAUDE_UI_INDEX_WORKER = "1";
    try {
      const wkDb = path.join(dir, "wk.db");
      const wkIdx = new TranscriptIndex(wkDb);
      await wkIdx.indexSession(path.join(projWk, "sess.jsonl"));
      const wkRows = toolCallRows(wkDb);
      wkIdx.close();
      // The ToolCall accumulators survive the structured-clone hop to the worker intact:
      // same tools, same isError, same durations — the parse output is byte-for-byte equal.
      expect(wkRows).toEqual(syncRows);
      expect(wkRows.length).toBe(2);
      expect(wkRows.find((r) => r.toolName === "Bash")!.isError).toBe(1);
      expect(wkRows.find((r) => r.toolName === "Edit")!.durationMs).toBe(250);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_UI_INDEX_WORKER;
      else process.env.CLAUDE_UI_INDEX_WORKER = prev;
    }
  });
});

describe("indexAll({ force: true }) backfill", () => {
  it("re-indexes a session whose size+mtime are unchanged (default would skip it)", async () => {
    const dir = tmp();
    // scanAllSessionFiles discovers under the real ~/.claude projects dir, which a
    // hermetic temp index won't see. So we drive the unit directly: prove the
    // engine-level indexSession force flag re-runs an otherwise-"unchanged" file, which is
    // exactly the per-file work indexAll({force}) performs across every discovered session.
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const dbPath = path.join(dir, "i.db");
    const cwd = "/home/dev/backfill";

    const s = writeSession(proj, "bf", {
      cwd,
      baseMs: Date.UTC(2026, 5, 10, 4, 0, 0),
      tools: [{ name: "Bash", id: "f1", durMs: 100, err: true }],
    });

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(s);

    // A normal re-index of the unchanged file is skipped.
    expect(await idx.indexSession(s)).toBe("unchanged");

    // Simulate a pre-W28 row: drop tool_calls + null out the model, without touching the file.
    const db = (idx as unknown as { db: InstanceType<typeof DatabaseSync> }).db;
    db.prepare("DELETE FROM tool_calls").run();
    db.prepare("UPDATE sessions SET model = NULL").run();
    expect(countToolCalls(dbPath)).toBe(0);

    // Default (no force) still skips the unchanged file -> no backfill.
    expect(await idx.indexSession(s)).toBe("unchanged");
    expect(countToolCalls(dbPath)).toBe(0);

    // force:true re-runs the full index even though size+mtime are unchanged: it backfills
    // tool_calls AND re-resolves the null model.
    expect(await idx.indexSession(s, { force: true })).toBe("updated");
    expect(countToolCalls(dbPath)).toBe(1);
    const rows = toolCallRows(dbPath);
    expect(rows[0]!.isError).toBe(1);
    expect(rows[0]!.durationMs).toBe(100);
    const model = (db.prepare("SELECT model FROM sessions WHERE sessionId='bf'").get() as { model: string | null }).model;
    expect(model).toBe("claude-opus-4-8");

    idx.close();
  });

  it("Engine.indexAll accepts a force flag and re-indexes every discovered (unchanged) session", async () => {
    // Point session discovery at an EMPTY temp ~/.claude/projects (via CLAUDE_CONFIG_DIR)
    // EXCEPT for one project folder we control, so indexAll stays hermetic + fast instead
    // of scanning the dev machine's real transcripts. We seed one tool-bearing session,
    // index it once, simulate a pre-W28 row (no tool_calls), then prove indexAll({force})
    // re-indexes the UNCHANGED file and backfills it — the cross-corpus backfill path.
    const cfg = tmp();
    const projects = path.join(cfg, "projects");
    const proj = path.join(projects, "-home-dev-allforce");
    mkdirSync(proj, { recursive: true });
    const dbPath = path.join(cfg, "i.db");
    const cwd = "/home/dev/allforce";

    writeSession(proj, "all1", {
      cwd,
      baseMs: Date.UTC(2026, 5, 10, 3, 0, 0),
      tools: [
        { name: "Bash", id: "z1", durMs: 100, err: true },
        { name: "Read", id: "z2", durMs: 50 },
      ],
    });

    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      const engine = new Engine(dbPath);
      try {
        // First full pass indexes the session + populates tool_calls.
        await engine.indexAll();
        expect(countToolCalls(dbPath)).toBe(2);

        // Simulate a pre-W28 row: wipe tool_calls, leave the file's size+mtime untouched.
        const db = (
          engine as unknown as { index: { db: InstanceType<typeof DatabaseSync> } }
        ).index.db;
        db.prepare("DELETE FROM tool_calls").run();
        expect(countToolCalls(dbPath)).toBe(0);

        // A default indexAll skips the unchanged file -> no backfill.
        await engine.indexAll();
        expect(countToolCalls(dbPath)).toBe(0);

        // force:true re-indexes the unchanged session and backfills tool_calls.
        await engine.indexAll({ force: true });
        expect(countToolCalls(dbPath)).toBe(2);
        const rows = toolCallRows(dbPath);
        const bash = rows.find((r) => r.toolName === "Bash")!;
        expect(bash.isError).toBe(1);
        expect(bash.durationMs).toBe(100);

        // toolStats now reports the real signal across the (backfilled) corpus.
        const res = engine.toolStats({ sessionId: "all1" });
        expect(res.summary.totalInvocations).toBe(2);
        expect(res.summary.totalErrors).toBe(1);
      } finally {
        engine.close();
      }
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});
