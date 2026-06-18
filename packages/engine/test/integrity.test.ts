import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TranscriptIndex } from "../src/index-db.js";

// node:sqlite is a newer builtin vitest's module graph won't resolve; require it natively
// (the same trick index-db.ts uses) so a test can poke the raw index DB to INJECT the
// corruption the integrity check is meant to catch.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-integ-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

const cwd = "/home/dev/integ-project";

/** A two-message transcript: a user prompt + an assistant reply (text + a tool_use). */
const writeTranscript = (file: string, term = "kiwi") => {
  writeFileSync(
    file,
    jl({ type: "user", cwd, message: { role: "user", content: `index the ${term} notes` } }) +
      jl({
        type: "assistant",
        cwd,
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "text", text: `Indexing the ${term} notes now.` },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: `grep ${term} notes.txt` } },
          ],
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      }),
  );
};

/** The active mirrored-text table name for this DB (FTS5 if available, else the LIKE table). */
const textTable = (db: InstanceType<typeof DatabaseSync>): string => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='messages_fts'")
    .get() as { name?: string } | undefined;
  return row?.name === "messages_fts" ? "messages_fts" : "messages_text";
};

describe("index integrity check + safe repair", () => {
  it("a freshly-indexed healthy index reports ok with no issues", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sessOk.jsonl");
    writeTranscript(file);
    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(file);

    const report = idx.checkIntegrity();
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.sqliteIntegrity).toBe("ok");
    expect(report.userVersion).toBeGreaterThan(0);
    expect(report.counts.sessions).toBe(1);
    expect(report.counts.ftsRows).toBeGreaterThan(0);
    expect(typeof report.checkedAt).toBe("number");
    idx.close();
  });

  it("flags injected orphan sidecar + FTS rows, then repair removes them and re-check is ok", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sessLive.jsonl");
    writeTranscript(file);
    const dbPath = path.join(dir, "i.db");
    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);

    // Inject orphans for a sessionId that has NO sessions row: a session_meta row, a
    // tool_calls row, an FTS mirror row, and a permission_audit row. The integrity check
    // must flag every one; repair must remove them WITHOUT touching the live session.
    const raw = new DatabaseSync(dbPath);
    const table = textTable(raw);
    raw.prepare("INSERT INTO session_meta (sessionId, pinned) VALUES (?, 1)").run("ghost");
    raw
      .prepare("INSERT INTO tool_calls (sessionId, seq, toolName, isError) VALUES (?, 0, 'Bash', 0)")
      .run("ghost");
    raw
      .prepare(`INSERT INTO ${table} (sessionId, role, seq, toolName, text) VALUES (?, 'user', 0, NULL, 'ghost text')`)
      .run("ghost");
    raw
      .prepare("INSERT INTO permission_audit (sessionId, toolName, decision, ts) VALUES (?, 'Bash', 'allow', 1)")
      .run("ghost");
    raw.close();

    const before = idx.checkIntegrity();
    expect(before.ok).toBe(false);
    const kinds = before.issues.map((i) => i.kind).sort();
    expect(kinds).toEqual(
      ["orphan-audit", "orphan-fts", "orphan-session-meta", "orphan-tool-calls"].sort(),
    );

    const repair = await idx.repairIntegrity();
    expect(repair.reindexed).toBe(0); // nothing to re-derive; only orphan deletes
    const repairedKinds = repair.repaired.map((r) => r.kind).sort();
    expect(repairedKinds).toEqual(
      ["orphan-audit", "orphan-fts", "orphan-session-meta", "orphan-tool-calls"].sort(),
    );

    // The live session is untouched: still indexed, still searchable.
    expect(idx.getSessionSummary("sessLive")).toBeDefined();
    expect(idx.search("kiwi").map((h) => h.sessionId)).toContain("sessLive");

    // Re-check is clean.
    const after = idx.checkIntegrity();
    expect(after.ok).toBe(true);
    expect(after.issues).toEqual([]);
    idx.close();
  });

  it("repair RE-DERIVES a session with emptied mirror text whose transcript still exists", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sessEmpty.jsonl");
    writeTranscript(file, "durian");
    const dbPath = path.join(dir, "i.db");
    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);
    expect(idx.search("durian").map((h) => h.sessionId)).toContain("sessEmpty");

    // Simulate an interrupted index pass: wipe the session's mirrored text but keep its
    // sessions row (messageCount > 0) and its on-disk transcript.
    const raw = new DatabaseSync(dbPath);
    const table = textTable(raw);
    raw.prepare(`DELETE FROM ${table} WHERE sessionId = ?`).run("sessEmpty");
    raw.close();

    const before = idx.checkIntegrity();
    expect(before.ok).toBe(false);
    const missing = before.issues.find((i) => i.kind === "missing-mirror-text");
    expect(missing).toBeDefined();
    expect(missing!.count).toBe(1);
    // Search now misses it (the proof the empty mirror matters).
    expect(idx.search("durian").map((h) => h.sessionId)).not.toContain("sessEmpty");

    const repair = await idx.repairIntegrity();
    expect(repair.reindexed).toBe(1);

    // Re-derived from disk: searchable again and the check is clean.
    expect(idx.search("durian").map((h) => h.sessionId)).toContain("sessEmpty");
    expect(idx.checkIntegrity().ok).toBe(true);
    idx.close();
  });

  it("flags a session whose on-disk transcript is missing as a WARNING and never deletes it", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sessGone.jsonl");
    writeTranscript(file);
    const dbPath = path.join(dir, "i.db");
    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);

    // Delete the transcript out from under the index (Claude Code's ~30-day auto-delete).
    rmSync(file);

    const report = idx.checkIntegrity();
    const gone = report.issues.find((i) => i.kind === "missing-transcript");
    expect(gone).toBeDefined();
    expect(gone!.severity).toBe("warning");
    expect(gone!.count).toBe(1);

    // Repair must NOT delete the session row (it's a permanent metadata archive) and must
    // NOT try to reindex a gone transcript.
    const repair = await idx.repairIntegrity();
    expect(repair.reindexed).toBe(0);
    expect(idx.getSessionSummary("sessGone")).toBeDefined();
    idx.close();
  });

  it("repair is idempotent: a second run finds nothing to do", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sessIdem.jsonl");
    writeTranscript(file, "mango");
    const dbPath = path.join(dir, "i.db");
    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);

    // Inject one orphan AND empty one session's mirror so the first repair does real work.
    const raw = new DatabaseSync(dbPath);
    const table = textTable(raw);
    raw.prepare("INSERT INTO tool_calls (sessionId, seq, toolName, isError) VALUES (?, 0, 'Edit', 0)").run("ghost2");
    raw.close();

    const first = await idx.repairIntegrity();
    expect(first.repaired.length).toBeGreaterThan(0);
    expect(idx.checkIntegrity().ok).toBe(true);

    // Second run: no orphans, no empty mirrors -> nothing repaired, nothing reindexed.
    const second = await idx.repairIntegrity();
    expect(second.repaired).toEqual([]);
    expect(second.reindexed).toBe(0);
    expect(idx.checkIntegrity().ok).toBe(true);

    // The live session is intact throughout.
    expect(idx.search("mango").map((h) => h.sessionId)).toContain("sessIdem");
    idx.close();
  });
});
