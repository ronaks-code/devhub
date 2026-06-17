import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TranscriptIndex } from "../src/index-db.js";

// node:sqlite is a newer builtin vitest's module graph won't resolve; require it
// natively (the same trick index-db.ts uses) so we can open the index DB raw and read
// the exact rows the indexer wrote.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-idem-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/**
 * Re-indexing the SAME transcript must be IDEMPOTENT: the W23 stable-rowid FTS path
 * gives every mirrored row a deterministic rowid derived from its identity, so a full
 * re-index of unchanged content lands the exact same rows on the exact same rowids.
 * These tests re-index N times and assert the DB rows (sessions, message-text mirror,
 * FTS hits for a known term) are byte-for-byte identical after every pass. Hermetic:
 * temp DB + temp dir; nothing touches ~/.claude.
 */

const cwd = "/home/dev/idem-project";

/** A two-message transcript: a user prompt + an assistant reply with a tool_use. */
const writeTranscript = (file: string) => {
  writeFileSync(
    file,
    jl({ type: "user", cwd, message: { role: "user", content: "index the kiwi notes" } }) +
      jl({
        type: "assistant",
        cwd,
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "text", text: "Indexing the kiwi notes now." },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "grep kiwi notes.txt" } },
          ],
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      }),
  );
};

/** Bump the file's mtime so indexSession does a real (full) re-index pass. */
const bumpMtime = (file: string, n: number) => {
  const t = new Date(2026, 0, 1, 0, 0, n);
  utimesSync(file, t, t);
};

/** Read the active mirrored-text table name (FTS5 if available, else the LIKE table). */
const textTable = (db: InstanceType<typeof DatabaseSync>): string => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='messages_fts'")
    .get() as { name?: string } | undefined;
  return row?.name === "messages_fts" ? "messages_fts" : "messages_text";
};

/** A stable snapshot of everything the indexer wrote for this DB, sorted for equality. */
const snapshot = (dbPath: string) => {
  const db = new DatabaseSync(dbPath);
  try {
    const table = textTable(db);
    const sessions = db
      .prepare(
        `SELECT sessionId, cwd, projectId, title, titleSource, messageCount,
                inputTokens, outputTokens, model
         FROM sessions ORDER BY sessionId`,
      )
      .all();
    // The mirrored search rows, keyed by their stable rowid so we can prove the SAME
    // logical row keeps the SAME rowid across passes.
    const textRows = db
      .prepare(
        `SELECT rowid AS rowid, sessionId, role, seq, toolName, text
         FROM ${table} ORDER BY sessionId, seq, role, text`,
      )
      .all()
      .map((r) => ({ ...(r as Record<string, unknown>), rowid: Number((r as { rowid: bigint }).rowid) }));
    const textCount = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    return { sessions, textRows, textCount, table };
  } finally {
    db.close();
  }
};

describe("re-index idempotency (W23 stable-rowid FTS path)", () => {
  it("re-indexing the same file N times yields IDENTICAL rows each pass", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sessIdem.jsonl");
    writeTranscript(file);
    const dbPath = path.join(dir, "i.db");

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);
    const first = snapshot(dbPath);

    // Sanity: the known term is indexed and the session row is sound.
    expect(idx.search("kiwi").map((h) => h.sessionId)).toContain("sessIdem");
    expect(first.textCount).toBeGreaterThan(0);

    const passes: ReturnType<typeof snapshot>[] = [first];
    for (let i = 1; i <= 4; i++) {
      // Force a FULL re-index (changed mtime), content unchanged -> stable rowids must
      // reproduce the exact same rows.
      bumpMtime(file, i);
      await idx.indexSession(file);
      passes.push(snapshot(dbPath));
    }

    // Every snapshot is deeply equal to the first: rows, rowids, and counts are stable.
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i]!.sessions).toEqual(first.sessions);
      expect(passes[i]!.textRows).toEqual(first.textRows);
      expect(passes[i]!.textCount).toBe(first.textCount);
    }

    // FTS hits for the known term are identical after the last pass too.
    const hits = idx.search("kiwi").map((h) => h.sessionId);
    expect(hits).toContain("sessIdem");
    idx.close();
  });

  it("re-index never duplicates rows (rowids stay 1:1 with logical rows)", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sessDup.jsonl");
    writeTranscript(file);
    const dbPath = path.join(dir, "i.db");

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);
    const baseCount = snapshot(dbPath).textCount;

    for (let i = 1; i <= 3; i++) {
      bumpMtime(file, i);
      await idx.indexSession(file);
      expect(snapshot(dbPath).textCount).toBe(baseCount); // no growth from re-index
    }
    idx.close();
  });

  it("appending NEW lines then re-indexing ONLY adds rows (prior rows untouched)", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sessGrow.jsonl");
    writeTranscript(file);
    const dbPath = path.join(dir, "i.db");

    const idx = new TranscriptIndex(dbPath);
    await idx.indexSession(file);
    const before = snapshot(dbPath);

    // Append a brand-new searchable line; this grows the file (incremental append).
    appendFileSync(
      file,
      jl({
        type: "assistant",
        cwd,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Also indexing the durian notes." }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
    );
    expect(await idx.indexSession(file)).toBe("updated");
    const after = snapshot(dbPath);

    // Exactly one new mirrored row was added; the count strictly grew by the new rows.
    expect(after.textCount).toBe(before.textCount + 1);
    // Every PRIOR row is still present unchanged (same rowid + content) — the append
    // did not disturb the existing rows.
    for (const prior of before.textRows) {
      expect(after.textRows).toContainEqual(prior);
    }
    // The new text is searchable; the old text is still searchable (nothing dropped).
    expect(idx.search("durian").map((h) => h.sessionId)).toContain("sessGrow");
    expect(idx.search("kiwi").map((h) => h.sessionId)).toContain("sessGrow");

    // Re-indexing again (full pass, unchanged content) is idempotent on the grown file.
    bumpMtime(file, 9);
    await idx.indexSession(file);
    const reSnap = snapshot(dbPath);
    expect(reSnap.textRows).toEqual(after.textRows);
    expect(reSnap.textCount).toBe(after.textCount);
    expect(statSync(file).size).toBeGreaterThan(0);
    idx.close();
  });
});
