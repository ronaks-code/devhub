import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TranscriptIndex } from "../src/index-db.js";
import {
  exportArchive,
  exportArchiveForProject,
  exportArchiveChunks,
  importArchive,
  ArchiveVersionError,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveBundle,
  type ArchiveChunk,
} from "../src/portable.js";
import { projectIdFromCwd } from "../src/paths.js";

// node:sqlite is a newer builtin vitest's module graph won't resolve; require it
// natively (the same trick index-db.ts uses) so we can open an index DB raw and count
// the exact rows an import wrote.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * Full-archive EXPORT -> IMPORT round-trip (packages/engine/src/portable.ts).
 *
 * Export the durable index into a portable bundle, then import it into a BRAND-NEW temp
 * index and assert every session + sidecar (titles/pins/tags/notes/archived/saved
 * views/audit) reproduces. Re-importing the same bundle is idempotent (no dup rows). An
 * incompatible schemaVersion throws a typed error (and no-ops in non-strict mode).
 * Hermetic: temp DBs + temp dir; nothing touches ~/.claude.
 */

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-portable-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

const cwd = "/home/dev/portable-project";

/**
 * A two-message transcript: a user prompt + an assistant reply with a tool_use. The
 * `cwd` (which determines the derived projectId) and the line `timestamp` (which lands
 * in lastTs, driving the `sinceTs` filter) are overridable for selective-export tests;
 * both default to the original fixed values so existing callers are unchanged.
 */
const writeTranscript = (
  file: string,
  term: string,
  opts: { cwd?: string; timestamp?: string } = {},
) => {
  const sessionCwd = opts.cwd ?? cwd;
  const ts = opts.timestamp;
  writeFileSync(
    file,
    jl({
      type: "user",
      cwd: sessionCwd,
      ...(ts ? { timestamp: ts } : {}),
      message: { role: "user", content: `index the ${term} notes` },
    }) +
      jl({
        type: "assistant",
        cwd: sessionCwd,
        ...(ts ? { timestamp: ts } : {}),
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

/** Open the index DB raw and count rows across the tables a bundle restores. */
const counts = (dbPath: string) => {
  const db = new DatabaseSync(dbPath);
  try {
    const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    const table =
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='messages_fts'")
          .get() as { name?: string } | undefined
      )?.name === "messages_fts"
        ? "messages_fts"
        : "messages_text";
    return {
      sessions: c("SELECT COUNT(*) AS c FROM sessions"),
      meta: c("SELECT COUNT(*) AS c FROM session_meta"),
      text: c(`SELECT COUNT(*) AS c FROM ${table}`),
      savedViews: c("SELECT COUNT(*) AS c FROM saved_views"),
      audit: c("SELECT COUNT(*) AS c FROM permission_audit"),
    };
  } finally {
    db.close();
  }
};

/**
 * Build a SOURCE index with two indexed sessions plus a full spread of sidecar metadata,
 * a saved view, and an audit row. Returns the open index + its db path.
 */
async function buildSource() {
  const dir = tmp();
  const proj = path.join(dir, "-proj");
  mkdirSync(proj);
  const fileA = path.join(proj, "sessA.jsonl");
  const fileB = path.join(proj, "sessB.jsonl");
  writeTranscript(fileA, "kiwi");
  writeTranscript(fileB, "durian");
  const dbPath = path.join(dir, "src.db");

  const idx = new TranscriptIndex(dbPath);
  await idx.indexSession(fileA);
  await idx.indexSession(fileB);

  // A full spread of sidecar metadata on sessA.
  idx.setCustomTitle("sessA", "My renamed session");
  idx.setPinned("sessA", true);
  idx.setTags("sessA", ["alpha", "beta"]);
  idx.setNotes("sessA", "remember the kiwi findings");
  idx.setArchived("sessB", true);

  // A saved view + an audit row (the other two sidecar tables).
  idx.saveView({ name: "Kiwi work", query: "kiwi", facets: { projectId: "p1" } });
  idx.audit.logDecision({ sessionId: "sessA", toolName: "Bash", decision: "allow", scope: "once" });

  return { idx, dbPath, dir };
}

describe("portable archive export/import (src/portable.ts)", () => {
  it("export -> import into a FRESH index reproduces sessions + sidecar meta", async () => {
    const src = await buildSource();
    const ts = 1_700_000_000_000;
    const bundle = src.idx.exportArchive({ timestamp: ts });

    // The bundle is a versioned, self-describing document.
    expect(bundle.kind).toBe("claude-ui-archive");
    expect(bundle.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
    expect(bundle.timestamp).toBe(ts);
    expect(bundle.sessions.map((s) => s.session.sessionId).sort()).toEqual(["sessA", "sessB"]);
    expect(bundle.savedViews).toHaveLength(1);
    expect(bundle.audit).toHaveLength(1);
    // Mirrored text travels in the bundle (our own normalized copy, not the transcript).
    const sessA = bundle.sessions.find((s) => s.session.sessionId === "sessA")!;
    expect(sessA.text.length).toBeGreaterThan(0);
    expect(sessA.text.some((t) => /kiwi/.test(t.text))).toBe(true);

    // Import into a brand-new, empty index.
    const destPath = path.join(src.dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    const res = dest.importArchive(bundle);
    expect(res.sessions).toBe(2);
    expect(res.meta).toBe(2); // sessA (title/pin/tags/notes) + sessB (archived)
    expect(res.textRows).toBeGreaterThan(0);
    expect(res.savedViews).toBe(1);
    expect(res.audit).toBe(1);

    // Sessions reproduced, with their normalized metadata.
    const a = dest.getSessionSummary("sessA")!;
    expect(a).toBeDefined();
    expect(a.model).toBe("claude-opus-4-8");
    expect(a.messageCount).toBe(2);

    // Sidecar meta reproduced exactly.
    expect(a.title).toBe("My renamed session"); // custom title wins
    expect(a.pinned).toBe(true);
    expect(dest.getTags("sessA")).toEqual(["alpha", "beta"]);
    expect(dest.getNotes("sessA")).toBe("remember the kiwi findings");
    expect(dest.getSessionSummary("sessB")!.archived).toBe(true);

    // Saved view + audit reproduced.
    const views = dest.listSavedViews();
    expect(views).toHaveLength(1);
    expect(views[0]!.name).toBe("Kiwi work");
    expect(views[0]!.query).toBe("kiwi");
    expect(views[0]!.facets).toEqual({ projectId: "p1" });
    const audit = dest.audit.list();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.toolName).toBe("Bash");
    expect(audit[0]!.decision).toBe("allow");

    // The mirrored text is searchable in the fresh index (round-tripped, not re-parsed
    // from a transcript — no transcript files exist next to dest.db).
    expect(dest.search("kiwi").map((h) => h.sessionId)).toContain("sessA");
    expect(dest.search("durian").map((h) => h.sessionId)).toContain("sessB");

    src.idx.close();
    dest.close();
  });

  it("re-importing the same bundle is IDEMPOTENT (no duplicate rows)", async () => {
    const src = await buildSource();
    const bundle = src.idx.exportArchive({ timestamp: 1 });

    const destPath = path.join(src.dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    dest.importArchive(bundle);
    const after1 = counts(destPath);

    // Import the same bundle two more times — counts must not grow.
    const res2 = dest.importArchive(bundle);
    const res3 = dest.importArchive(bundle);
    const afterN = counts(destPath);

    expect(afterN).toEqual(after1);
    // Sessions/meta upsert (touch rows but add none); text re-import adds 0 NEW rows;
    // saved views + audit skip the already-present rows entirely.
    expect(res2.savedViews).toBe(0);
    expect(res2.audit).toBe(0);
    expect(res3.savedViews).toBe(0);
    expect(res3.audit).toBe(0);

    src.idx.close();
    dest.close();
  });

  it("an incompatible schemaVersion throws a typed error (and no-ops in non-strict mode)", async () => {
    const src = await buildSource();
    const dest = new TranscriptIndex(path.join(src.dir, "dest.db"));

    const bad: ArchiveBundle = {
      ...src.idx.exportArchive({ timestamp: 1 }),
      schemaVersion: ARCHIVE_SCHEMA_VERSION + 999,
    };

    // Strict (default): throws a typed ArchiveVersionError carrying both versions.
    expect(() => dest.importArchive(bad)).toThrow(ArchiveVersionError);
    try {
      dest.importArchive(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(ArchiveVersionError);
      expect((err as ArchiveVersionError).found).toBe(ARCHIVE_SCHEMA_VERSION + 999);
      expect((err as ArchiveVersionError).expected).toBe(ARCHIVE_SCHEMA_VERSION);
    }
    // Nothing was written by the rejected import.
    expect(counts(path.join(src.dir, "dest.db"))).toMatchObject({
      sessions: 0,
      savedViews: 0,
      audit: 0,
    });

    // Non-strict: no-ops to an all-zero result instead of throwing.
    const res = dest.importArchive(bad, { strictVersion: false });
    expect(res).toEqual({ sessions: 0, meta: 0, textRows: 0, savedViews: 0, audit: 0 });

    src.idx.close();
    dest.close();
  });

  it("exportArchiveChunks re-assembles into exactly what exportArchive returns", async () => {
    const src = await buildSource();
    const ts = 42;
    const whole = src.idx.exportArchive({ timestamp: ts });

    // Re-assemble the streamed chunks (open the DB raw to drive the generator directly).
    const db = new DatabaseSync(src.dbPath);
    let assembled: ArchiveBundle | null = null;
    try {
      const sessions: ArchiveBundle["sessions"] = [];
      let savedViews: ArchiveBundle["savedViews"] = [];
      let audit: ArchiveBundle["audit"] = [];
      let header: { schemaVersion: number; timestamp: number } | null = null;
      for (const chunk of exportArchiveChunks(db, { timestamp: ts }) as Generator<ArchiveChunk>) {
        if (chunk.kind === "header") header = chunk.bundle;
        else if (chunk.kind === "session") sessions.push(chunk.session);
        else if (chunk.kind === "savedViews") savedViews = chunk.savedViews;
        else audit = chunk.audit;
      }
      assembled = {
        kind: "claude-ui-archive",
        schemaVersion: header!.schemaVersion,
        timestamp: header!.timestamp,
        sessions,
        savedViews,
        audit,
      };
    } finally {
      db.close();
    }

    expect(assembled).toEqual(whole);
    src.idx.close();
  });

  it("module-level exportArchive/importArchive work directly over a raw DB handle", async () => {
    // Verify the free functions (barrel exports) operate on a bare node:sqlite handle,
    // independent of the Engine/TranscriptIndex wrapper.
    const src = await buildSource();
    const bundle = exportArchive(new DatabaseSync(src.dbPath), { timestamp: 7 });
    expect(bundle.timestamp).toBe(7);
    expect(bundle.sessions.length).toBe(2);

    const destPath = path.join(src.dir, "dest.db");
    const destIdx = new TranscriptIndex(destPath); // create schema
    destIdx.close();
    const destDb = new DatabaseSync(destPath);
    const res = importArchive(destDb, bundle);
    destDb.close();
    expect(res.sessions).toBe(2);
    expect(counts(destPath).sessions).toBe(2);

    src.idx.close();
  });
});

/**
 * SELECTIVE export (packages/engine/src/portable.ts).
 *
 * exportArchive accepts an optional selection — projectId / sessionIds / sinceTs — to
 * bundle only a subset. Assert: a projectId export carries only that project's sessions
 * (+ only their meta/text/audit); a sessionIds export carries exactly the listed
 * sessions; a sinceTs export carries only recent-enough sessions; a no-selection export
 * is unchanged vs the full baseline; a selective bundle round-trips into a fresh index
 * (importArchive UNCHANGED) and re-imports idempotently. Hermetic: temp DBs + temp dir.
 */

const cwdAlpha = "/home/dev/alpha-project";
const cwdBeta = "/home/dev/beta-project";
const projAlpha = projectIdFromCwd(cwdAlpha);
const projBeta = projectIdFromCwd(cwdBeta);

/**
 * Build a SOURCE index spanning TWO projects (alpha: a1+a2, beta: b1) with distinct
 * last-activity timestamps, plus per-session sidecar meta and audit rows on sessions in
 * each project, and a global saved view. Returns the open index + its db path + dir.
 */
async function buildMultiProject() {
  const dir = tmp();
  const proj = path.join(dir, "-multi");
  mkdirSync(proj);
  const fA1 = path.join(proj, "a1.jsonl");
  const fA2 = path.join(proj, "a2.jsonl");
  const fB1 = path.join(proj, "b1.jsonl");
  // alpha sessions are OLD, beta session is NEW — so a sinceTs floor between them keeps
  // only beta.
  writeTranscript(fA1, "apple", { cwd: cwdAlpha, timestamp: "2024-01-01T00:00:00.000Z" });
  writeTranscript(fA2, "apricot", { cwd: cwdAlpha, timestamp: "2024-01-02T00:00:00.000Z" });
  writeTranscript(fB1, "banana", { cwd: cwdBeta, timestamp: "2024-06-01T00:00:00.000Z" });
  const dbPath = path.join(dir, "multi.db");

  const idx = new TranscriptIndex(dbPath);
  await idx.indexSession(fA1);
  await idx.indexSession(fA2);
  await idx.indexSession(fB1);

  // Sidecar meta + an audit row spread across both projects, so we can prove a selective
  // export carries only the included sessions' sidecar/audit.
  idx.setTags("a1", ["alpha"]);
  idx.setNotes("b1", "beta findings");
  idx.audit.logDecision({ sessionId: "a1", toolName: "Bash", decision: "allow", scope: "once" });
  idx.audit.logDecision({ sessionId: "b1", toolName: "Bash", decision: "deny", scope: "once" });
  // A global saved view (not tied to any session) — included in every bundle.
  idx.saveView({ name: "Fruit", query: "apple", facets: {} });

  return { idx, dbPath, dir };
}

describe("selective archive export (src/portable.ts)", () => {
  it("by projectId: bundle carries ONLY that project's sessions + their sidecar/audit", async () => {
    const src = await buildMultiProject();
    const bundle = src.idx.exportArchive({ timestamp: 1, projectId: projAlpha });

    // Only alpha's two sessions travel — beta is excluded.
    expect(bundle.sessions.map((s) => s.session.sessionId).sort()).toEqual(["a1", "a2"]);
    for (const s of bundle.sessions) expect(s.session.projectId).toBe(projAlpha);

    // Sidecar meta is scoped: a1's tags ride along, b1's notes do not.
    const a1 = bundle.sessions.find((s) => s.session.sessionId === "a1")!;
    expect(a1.meta?.tags).toBe(JSON.stringify(["alpha"]));
    expect(bundle.sessions.some((s) => s.session.sessionId === "b1")).toBe(false);

    // Audit is scoped to included sessions only — a1's allow, never b1's deny.
    expect(bundle.audit.map((a) => a.sessionId).sort()).toEqual(["a1"]);
    expect(bundle.audit.every((a) => a.sessionId === "a1")).toBe(true);

    // Saved views are global — still included in full.
    expect(bundle.savedViews).toHaveLength(1);
    // The bundle SHAPE/version is unchanged — a selective bundle is just smaller.
    expect(bundle.kind).toBe("claude-ui-archive");
    expect(bundle.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);

    src.idx.close();
  });

  it("exportArchiveForProject is the projectId shorthand", async () => {
    const src = await buildMultiProject();
    const db = new DatabaseSync(src.dbPath);
    try {
      const viaHelper = exportArchiveForProject(db, projBeta, { timestamp: 9 });
      const viaOpts = exportArchive(db, { timestamp: 9, projectId: projBeta });
      expect(viaHelper).toEqual(viaOpts);
      expect(viaHelper.sessions.map((s) => s.session.sessionId)).toEqual(["b1"]);
    } finally {
      db.close();
    }
    src.idx.close();
  });

  it("by sessionIds: bundle carries exactly the listed sessions (empty list = none)", async () => {
    const src = await buildMultiProject();

    const bundle = src.idx.exportArchive({ timestamp: 1, sessionIds: ["a2", "b1"] });
    expect(bundle.sessions.map((s) => s.session.sessionId).sort()).toEqual(["a2", "b1"]);
    // a1's audit row is excluded (a1 not selected); b1's deny travels.
    expect(bundle.audit.map((a) => a.sessionId).sort()).toEqual(["b1"]);

    // An empty id list selects no sessions (and so no scoped audit), but the envelope +
    // global saved views still come through — a valid, near-empty bundle.
    const none = src.idx.exportArchive({ timestamp: 1, sessionIds: [] });
    expect(none.sessions).toHaveLength(0);
    expect(none.audit).toHaveLength(0);
    expect(none.savedViews).toHaveLength(1);

    src.idx.close();
  });

  it("by sinceTs: bundle carries only sessions at/after the floor", async () => {
    const src = await buildMultiProject();
    // A floor between the (old) alpha sessions and the (new) beta session keeps only beta.
    const floor = Date.parse("2024-03-01T00:00:00.000Z");
    const bundle = src.idx.exportArchive({ timestamp: 1, sinceTs: floor });
    expect(bundle.sessions.map((s) => s.session.sessionId)).toEqual(["b1"]);

    // A floor before everything keeps all three.
    const all = src.idx.exportArchive({ timestamp: 1, sinceTs: 0 });
    expect(all.sessions.map((s) => s.session.sessionId).sort()).toEqual(["a1", "a2", "b1"]);

    src.idx.close();
  });

  it("combines filters with AND (projectId + sinceTs)", async () => {
    const src = await buildMultiProject();
    // alpha project AND since a date after both alpha sessions -> nothing matches.
    const empty = src.idx.exportArchive({
      timestamp: 1,
      projectId: projAlpha,
      sinceTs: Date.parse("2024-03-01T00:00:00.000Z"),
    });
    expect(empty.sessions).toHaveLength(0);

    // alpha project AND since a date between the two alpha sessions -> only a2.
    const one = src.idx.exportArchive({
      timestamp: 1,
      projectId: projAlpha,
      sinceTs: Date.parse("2024-01-01T12:00:00.000Z"),
    });
    expect(one.sessions.map((s) => s.session.sessionId)).toEqual(["a2"]);

    src.idx.close();
  });

  it("no selection is UNCHANGED vs the full baseline (same session set + byte-identical)", async () => {
    const src = await buildMultiProject();
    const full = src.idx.exportArchive({ timestamp: 5 });
    // Full corpus: all three sessions, both audit rows.
    expect(full.sessions.map((s) => s.session.sessionId).sort()).toEqual(["a1", "a2", "b1"]);
    expect(full.audit).toHaveLength(2);

    // An "all-encompassing" selection (e.g. sinceTs:0) yields the SAME session set as the
    // default full export, and the default path is byte-identical to passing no opts.
    const fullAgain = src.idx.exportArchive({ timestamp: 5 });
    expect(fullAgain).toEqual(full);

    src.idx.close();
  });

  it("a selective bundle round-trips into a FRESH index (import UNCHANGED) + re-import idempotent", async () => {
    const src = await buildMultiProject();
    const bundle = src.idx.exportArchive({ timestamp: 1, projectId: projAlpha });

    // Import the SELECTIVE bundle into a brand-new index — importArchive is unchanged; a
    // selective bundle is just a smaller valid one.
    const destPath = path.join(src.dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    const res = dest.importArchive(bundle);
    expect(res.sessions).toBe(2); // only alpha's a1 + a2
    expect(res.audit).toBe(1); // only a1's scoped audit row

    // Exactly alpha's sessions were restored — beta's b1 is absent.
    expect(dest.getSessionSummary("a1")).toBeDefined();
    expect(dest.getSessionSummary("a2")).toBeDefined();
    expect(dest.getSessionSummary("b1")).toBeUndefined();
    expect(dest.getTags("a1")).toEqual(["alpha"]);
    // Mirrored text round-trips and is searchable; beta's term is nowhere to be found.
    expect(dest.search("apple").map((h) => h.sessionId)).toContain("a1");
    expect(dest.search("banana")).toHaveLength(0);

    const before = counts(destPath);
    // Re-import the same selective bundle twice — counts must not grow (idempotent).
    const r2 = dest.importArchive(bundle);
    dest.importArchive(bundle);
    expect(counts(destPath)).toEqual(before);
    expect(r2.audit).toBe(0);
    expect(r2.savedViews).toBe(0);

    src.idx.close();
    dest.close();
  });
});
