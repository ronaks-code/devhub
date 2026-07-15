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
  exportLegacyV1Archive,
  importArchive,
  ArchiveVersionError,
  ArchiveValidationError,
  DEVHUB_ARCHIVE_SCHEMA_VERSION,
  LEGACY_ARCHIVE_SCHEMA_VERSION,
  type DevHubArchiveBundleV2,
  type LegacyArchiveBundleV1,
  type ArchiveChunk,
  type ArchiveHomeMapping,
} from "../src/portable.js";
import { projectIdFromCwd } from "../src/paths.js";

// node:sqlite is a newer builtin vitest's module graph won't resolve; require it natively.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * Portable archive v2 (default) + v1 (legacy) — packages/engine/src/portable.ts.
 *
 * The DEFAULT export is now the authority-clean DevHub v2 bundle (no session content,
 * no transcript/home paths, no mirrored text, no cache rows). The legacy v1 bundle is
 * still IMPORTED (older backups), and can be EXPORTED for rollback only, restricted to
 * the unresolved legacy corpus. v2 import restores only additive metadata + locator links;
 * provider metadata lands as orphans unless a validated home mapping remaps it onto a
 * registered target. Hermetic: temp DBs + temp dir; nothing touches ~/.claude.
 */

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-portable-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";
const cwd = "/home/dev/portable-project";

/** A valid 64-hex home fingerprint built from one repeated char. */
const fp = (c: string) => c.repeat(64);

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

/** Count rows across the tables a bundle can restore. */
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
      providerMeta: c("SELECT COUNT(*) AS c FROM provider_task_meta"),
      forkLinks: c("SELECT COUNT(*) AS c FROM provider_fork_links"),
      provenance: c("SELECT COUNT(*) AS c FROM legacy_session_provenance"),
    };
  } finally {
    db.close();
  }
};

/**
 * Build a SOURCE index with two sessions + sidecar meta + a saved view + an audit row,
 * PLUS provider-task metadata and a fork link on registered provider homes.
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

  idx.setCustomTitle("sessA", "My renamed session");
  idx.setPinned("sessA", true);
  idx.setTags("sessA", ["alpha", "beta"]);
  idx.setNotes("sessA", "remember the kiwi findings");
  idx.setArchived("sessB", true);

  idx.saveView({ name: "Kiwi work", query: "kiwi", facets: { projectId: "p1" } });
  idx.audit.logDecision({ sessionId: "sessA", toolName: "Bash", decision: "allow", scope: "once" });

  // Provider-task metadata on registered homes (openai + anthropic).
  const oai = idx.providerIndex.registerHome({ provider: "openai", home: "/home/dev/.codex" }, 1000);
  const ant = idx.providerIndex.registerHome({ provider: "anthropic", home: "/home/dev/.claude" }, 1000);
  const locX = { version: 1 as const, provider: "openai" as const, homeFingerprint: oai.homeFingerprint, nativeTaskId: "task-x" };
  const locY = { version: 1 as const, provider: "anthropic" as const, homeFingerprint: ant.homeFingerprint, nativeTaskId: "task-y" };
  idx.providerIndex.patchMeta(locX, { favorite: true, tags: ["work"], notes: "task x notes", localLabel: "X label" });
  idx.providerIndex.patchMeta(locY, { pinned: true, localArchived: true });
  idx.providerIndex.linkFork(locX, locY, fp("d"), 2000);

  return { idx, dbPath, dir, oai, ant, locX, locY };
}

describe("default export is the DevHub v2 bundle (authority-clean)", () => {
  it("exports kind=devhub-archive/schemaVersion=2 with additive meta + provider links, NO session content/text/paths", async () => {
    const src = await buildSource();
    const ts = 1_700_000_000_000;
    const bundle = src.idx.exportArchive({ timestamp: ts });

    expect(bundle.kind).toBe("devhub-archive");
    expect(bundle.schemaVersion).toBe(DEVHUB_ARCHIVE_SCHEMA_VERSION);
    expect(bundle.timestamp).toBe(ts);

    // Additive legacy metadata (session_meta), keyed by sessionId — NO transcript path.
    expect(bundle.legacyMeta.map((m) => m.sessionId).sort()).toEqual(["sessA", "sessB"]);
    const sessA = bundle.legacyMeta.find((m) => m.sessionId === "sessA")!;
    expect(sessA.customTitle).toBe("My renamed session");
    expect(sessA.tags).toBe(JSON.stringify(["alpha", "beta"]));

    expect(bundle.savedViews).toHaveLength(1);
    expect(bundle.audit).toHaveLength(1);

    // Provider task metadata + fork link travel as opaque locators.
    expect(bundle.providerTaskMeta).toHaveLength(2);
    expect(bundle.providerForkLinks).toHaveLength(1);
    const metaX = bundle.providerTaskMeta.find((m) => m.locator.nativeTaskId === "task-x")!;
    expect(metaX.favorite).toBe(true);
    expect(metaX.locator.homeFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // NO content leakage: the serialized bundle carries no transcript/home path, no
    // mirrored text, no cache row, no hidden reasoning.
    const json = JSON.stringify(bundle);
    expect(json).not.toContain("/home/dev"); // no raw home / transcript path
    expect(json).not.toContain("filePath");
    expect(json).not.toContain("Indexing the kiwi"); // no mirrored message text
    expect(json).not.toContain("grep kiwi");
    expect(json).not.toMatch(/hidden|reasoning|thought/i);
    // The v2 shape has no `sessions` array (that was the v1 payload with transcript paths).
    expect((bundle as unknown as { sessions?: unknown }).sessions).toBeUndefined();

    src.idx.close();
  });

  it("v2 round-trips into a FRESH index: additive meta + provider links restore (as orphans, no cache row)", async () => {
    const src = await buildSource();
    const bundle = src.idx.exportArchive({ timestamp: 1 });

    const destPath = path.join(src.dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    const res = dest.importArchive(bundle);

    // Exact counts.
    expect(res.sessions).toBe(0); // v2 carries no session rows
    expect(res.textRows).toBe(0);
    expect(res.meta).toBe(2); // sessA + sessB additive meta
    expect(res.savedViews).toBe(1);
    expect(res.audit).toBe(1);
    expect(res.providerMeta).toBe(2);
    expect(res.forkLinks).toBe(1);
    expect(res.mappedLocators).toBe(0); // no mapping supplied
    expect(res.orphanedLocators).toBeGreaterThan(0); // source homes not registered here

    // Additive metadata reattached, WITHOUT any session/transcript content.
    const c = counts(destPath);
    expect(c.sessions).toBe(0);
    expect(c.text).toBe(0);
    expect(c.meta).toBe(2);
    expect(c.providerMeta).toBe(2);
    expect(c.forkLinks).toBe(1);
    // Never a provider task cache row.
    const raw = new DatabaseSync(destPath);
    const cacheRows = (raw.prepare("SELECT COUNT(*) AS c FROM provider_task_cache").get() as { c: number }).c;
    raw.close();
    expect(cacheRows).toBe(0);

    // Provider meta restored verbatim at its original (orphaned) locator.
    const metaX = dest.providerIndex.getMeta(src.locX);
    expect(metaX.favorite).toBe(true);
    expect(metaX.notes).toBe("task x notes");

    src.idx.close();
    dest.close();
  });

  it("v2 re-import is IDEMPOTENT (no duplicate rows)", async () => {
    const src = await buildSource();
    const bundle = src.idx.exportArchive({ timestamp: 1 });
    const destPath = path.join(src.dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    dest.importArchive(bundle);
    const after1 = counts(destPath);
    const r2 = dest.importArchive(bundle);
    dest.importArchive(bundle);
    expect(counts(destPath)).toEqual(after1);
    expect(r2.savedViews).toBe(0);
    expect(r2.audit).toBe(0);
    src.idx.close();
    dest.close();
  });

  it("exportArchiveChunks re-assembles into exactly what exportArchive returns", async () => {
    const src = await buildSource();
    const ts = 42;
    const whole = src.idx.exportArchive({ timestamp: ts });

    const db = new DatabaseSync(src.dbPath);
    let header: { schemaVersion: number; timestamp: number } | null = null;
    const legacyMeta: DevHubArchiveBundleV2["legacyMeta"] = [];
    let savedViews: DevHubArchiveBundleV2["savedViews"] = [];
    let audit: DevHubArchiveBundleV2["audit"] = [];
    const providerTaskMeta: DevHubArchiveBundleV2["providerTaskMeta"] = [];
    let providerForkLinks: DevHubArchiveBundleV2["providerForkLinks"] = [];
    try {
      for (const chunk of exportArchiveChunks(db, { timestamp: ts }) as Generator<ArchiveChunk>) {
        if (chunk.kind === "header") header = chunk.bundle;
        else if (chunk.kind === "legacyMeta") legacyMeta.push(chunk.legacyMeta);
        else if (chunk.kind === "savedViews") savedViews = chunk.savedViews;
        else if (chunk.kind === "audit") audit = chunk.audit;
        else if (chunk.kind === "providerTaskMeta") providerTaskMeta.push(chunk.providerTaskMeta);
        else providerForkLinks = chunk.providerForkLinks;
      }
    } finally {
      db.close();
    }
    const assembled: DevHubArchiveBundleV2 = {
      kind: "devhub-archive",
      schemaVersion: header!.schemaVersion as 2,
      timestamp: header!.timestamp,
      legacyMeta,
      savedViews,
      audit,
      providerTaskMeta,
      providerForkLinks,
    };
    expect(assembled).toEqual(whole);
    src.idx.close();
  });
});

describe("cross-machine home mapping (v2 import)", () => {
  /** Build a v2 bundle whose provider meta live on FOREIGN source fingerprints. */
  async function foreignBundle(): Promise<{ bundle: DevHubArchiveBundleV2; dir: string; sourceFp: string }> {
    const dir = tmp();
    const srcPath = path.join(dir, "src.db");
    const idx = new TranscriptIndex(srcPath);
    const sourceFp = fp("a");
    const loc = { version: 1 as const, provider: "openai" as const, homeFingerprint: sourceFp, nativeTaskId: "task-1" };
    idx.providerIndex.patchMeta(loc, { favorite: true, notes: "portable note" });
    const bundle = idx.exportArchive({ timestamp: 1 });
    idx.close();
    return { bundle, dir, sourceFp };
  }

  it("remaps a foreign source home onto a REGISTERED target (mappedLocators counted, rows at target)", async () => {
    const { bundle, dir, sourceFp } = await foreignBundle();
    const destPath = path.join(dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    const target = dest.providerIndex.registerHome({ provider: "openai", home: "/home/other/.codex" }, 500);

    const mapping: ArchiveHomeMapping = {
      entries: [
        { sourceProvider: "openai", sourceFingerprint: sourceFp, targetProvider: "openai", targetFingerprint: target.homeFingerprint },
      ],
    };
    const res = dest.importArchive(bundle, { homeMapping: mapping });
    expect(res.providerMeta).toBe(1);
    expect(res.mappedLocators).toBe(1);
    expect(res.orphanedLocators).toBe(0); // target is registered

    // Row landed at the TARGET locator, not the source.
    const atTarget = dest.providerIndex.getMeta({ version: 1, provider: "openai", homeFingerprint: target.homeFingerprint, nativeTaskId: "task-1" });
    expect(atTarget.favorite).toBe(true);
    expect(atTarget.notes).toBe("portable note");
    dest.close();
  });

  it("rejects an unknown-target mapping BEFORE any write", async () => {
    const { bundle, dir, sourceFp } = await foreignBundle();
    const dest = new TranscriptIndex(path.join(dir, "dest.db"));
    const mapping: ArchiveHomeMapping = {
      entries: [{ sourceProvider: "openai", sourceFingerprint: sourceFp, targetProvider: "openai", targetFingerprint: fp("f") }],
    };
    expect(() => dest.importArchive(bundle, { homeMapping: mapping })).toThrow(ArchiveValidationError);
    // Nothing written.
    expect(counts(path.join(dir, "dest.db")).providerMeta).toBe(0);
    dest.close();
  });

  it("rejects a provider-change mapping", async () => {
    const { bundle, dir, sourceFp } = await foreignBundle();
    const dest = new TranscriptIndex(path.join(dir, "dest.db"));
    const target = dest.providerIndex.registerHome({ provider: "anthropic", home: "/home/other/.claude" }, 500);
    const mapping: ArchiveHomeMapping = {
      entries: [{ sourceProvider: "openai", sourceFingerprint: sourceFp, targetProvider: "anthropic", targetFingerprint: target.homeFingerprint }],
    };
    expect(() => dest.importArchive(bundle, { homeMapping: mapping })).toThrow(/provider/);
    dest.close();
  });

  it("rejects a conflicting source→two-targets mapping, collapses a duplicate identical entry", async () => {
    const { bundle, dir, sourceFp } = await foreignBundle();
    const dest = new TranscriptIndex(path.join(dir, "dest.db"));
    const t1 = dest.providerIndex.registerHome({ provider: "openai", home: "/home/other/.codex" }, 500);
    const t2 = dest.providerIndex.registerHome({ provider: "openai", home: "/home/other/.codex2" }, 500);

    // Conflict: one source, two different registered targets.
    const conflict: ArchiveHomeMapping = {
      entries: [
        { sourceProvider: "openai", sourceFingerprint: sourceFp, targetProvider: "openai", targetFingerprint: t1.homeFingerprint },
        { sourceProvider: "openai", sourceFingerprint: sourceFp, targetProvider: "openai", targetFingerprint: t2.homeFingerprint },
      ],
    };
    expect(() => dest.importArchive(bundle, { homeMapping: conflict })).toThrow(ArchiveValidationError);

    // Duplicate identical entry collapses (no throw).
    const dup: ArchiveHomeMapping = {
      entries: [
        { sourceProvider: "openai", sourceFingerprint: sourceFp, targetProvider: "openai", targetFingerprint: t1.homeFingerprint },
        { sourceProvider: "openai", sourceFingerprint: sourceFp, targetProvider: "openai", targetFingerprint: t1.homeFingerprint },
      ],
    };
    const res = dest.importArchive(bundle, { homeMapping: dup });
    expect(res.mappedLocators).toBe(1);
    dest.close();
  });

  it("rejects a cyclic mapping", async () => {
    const { bundle, dir } = await foreignBundle();
    const dest = new TranscriptIndex(path.join(dir, "dest.db"));
    // Register two homes and construct A->B, B->A (a cycle) — both targets are registered.
    const a = dest.providerIndex.registerHome({ provider: "openai", home: "/home/other/.codexA" }, 1);
    const b = dest.providerIndex.registerHome({ provider: "openai", home: "/home/other/.codexB" }, 1);
    const mapping: ArchiveHomeMapping = {
      entries: [
        { sourceProvider: "openai", sourceFingerprint: a.homeFingerprint, targetProvider: "openai", targetFingerprint: b.homeFingerprint },
        { sourceProvider: "openai", sourceFingerprint: b.homeFingerprint, targetProvider: "openai", targetFingerprint: a.homeFingerprint },
      ],
    };
    expect(() => dest.importArchive(bundle, { homeMapping: mapping })).toThrow(/cycle/i);
    dest.close();
  });

  it("many-to-one: identical content collapses; differing content on one target ABORTS the whole transaction", async () => {
    const dir = tmp();
    // Two foreign sources, same nativeTaskId, DIFFERING content -> collision when mapped to one target.
    const srcPath = path.join(dir, "src.db");
    const idx = new TranscriptIndex(srcPath);
    const s1 = fp("a");
    const s2 = fp("b");
    idx.providerIndex.patchMeta({ version: 1, provider: "openai", homeFingerprint: s1, nativeTaskId: "t" }, { notes: "one" });
    idx.providerIndex.patchMeta({ version: 1, provider: "openai", homeFingerprint: s2, nativeTaskId: "t" }, { notes: "two" });
    const bundle = idx.exportArchive({ timestamp: 1 });
    idx.close();

    const destPath = path.join(dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    const target = dest.providerIndex.registerHome({ provider: "openai", home: "/home/other/.codex" }, 1);
    const mapping: ArchiveHomeMapping = {
      entries: [
        { sourceProvider: "openai", sourceFingerprint: s1, targetProvider: "openai", targetFingerprint: target.homeFingerprint },
        { sourceProvider: "openai", sourceFingerprint: s2, targetProvider: "openai", targetFingerprint: target.homeFingerprint },
      ],
    };
    expect(() => dest.importArchive(bundle, { homeMapping: mapping })).toThrow(/collide|collision/i);
    // Aborted: no meta row written (no last-writer-wins), and additive meta didn't leak either.
    expect(counts(destPath).providerMeta).toBe(0);
    dest.close();

    // Identical content collapses fine.
    const dir2 = tmp();
    const idx2 = new TranscriptIndex(path.join(dir2, "src.db"));
    idx2.providerIndex.patchMeta({ version: 1, provider: "openai", homeFingerprint: s1, nativeTaskId: "t" }, { notes: "same" });
    idx2.providerIndex.patchMeta({ version: 1, provider: "openai", homeFingerprint: s2, nativeTaskId: "t" }, { notes: "same" });
    const bundle2 = idx2.exportArchive({ timestamp: 1 });
    idx2.close();
    const dest2 = new TranscriptIndex(path.join(dir2, "dest.db"));
    const target2 = dest2.providerIndex.registerHome({ provider: "openai", home: "/home/other/.codex" }, 1);
    const res = dest2.importArchive(bundle2, {
      homeMapping: {
        entries: [
          { sourceProvider: "openai", sourceFingerprint: s1, targetProvider: "openai", targetFingerprint: target2.homeFingerprint },
          { sourceProvider: "openai", sourceFingerprint: s2, targetProvider: "openai", targetFingerprint: target2.homeFingerprint },
        ],
      },
    });
    expect(res.providerMeta).toBe(1); // collapsed to one row
    expect(res.mappedLocators).toBe(2); // both sources were remapped
    dest2.close();
  });

  it("mixed-provider isolation: same fingerprint+taskId under different providers do NOT collide", async () => {
    const dir = tmp();
    const idx = new TranscriptIndex(path.join(dir, "src.db"));
    const shared = fp("c");
    idx.providerIndex.patchMeta({ version: 1, provider: "openai", homeFingerprint: shared, nativeTaskId: "t" }, { notes: "oai" });
    idx.providerIndex.patchMeta({ version: 1, provider: "anthropic", homeFingerprint: shared, nativeTaskId: "t" }, { notes: "ant" });
    const bundle = idx.exportArchive({ timestamp: 1 });
    idx.close();

    const destPath = path.join(dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    const res = dest.importArchive(bundle); // no mapping — both orphaned, but distinct providers
    expect(res.providerMeta).toBe(2);
    expect(counts(destPath).providerMeta).toBe(2);
    dest.close();
  });
});

describe("legacy v1 import + export (rollback only)", () => {
  /** Hand-craft a golden v1 bundle a previous build would have produced. */
  function goldenV1(): LegacyArchiveBundleV1 {
    return {
      kind: "claude-ui-archive",
      schemaVersion: LEGACY_ARCHIVE_SCHEMA_VERSION,
      timestamp: 123,
      sessions: [
        {
          session: {
            sessionId: "legacy-1",
            filePath: "/home/dev/.claude/projects/p/legacy-1.jsonl",
            cwd: "/home/dev/p",
            projectId: "p",
            title: "Legacy one",
            titleSource: "first-message",
            gitBranch: null,
            firstTs: "2024-01-01T00:00:00.000Z",
            lastTs: "2024-01-01T00:01:00.000Z",
            messageCount: 2,
            inputTokens: 5,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            sizeBytes: 100,
            mtimeMs: 1,
            indexedBytes: 100,
            hasSubagents: 0,
            model: "claude-opus-4-8",
            headSig: null,
          },
          meta: { customTitle: "Renamed legacy", pinned: 1, tags: JSON.stringify(["t"]), archived: 0, notes: "n" },
          text: [
            { role: "user", seq: 0, toolName: null, text: "legacy mango question" },
            { role: "assistant", seq: 1, toolName: null, text: "legacy mango answer" },
          ],
        },
      ],
      savedViews: [{ name: "Legacy view", query: "mango", facets: "{}", createdAt: 10 }],
      audit: [{ sessionId: "legacy-1", toolName: "Bash", decision: "allow", scope: "once", reason: null, ts: 50 }],
    };
  }

  it("golden v1 reader compat: restores sessions/text/meta + records archive-v1-import provenance", async () => {
    const dir = tmp();
    const destPath = path.join(dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    const res = dest.importArchive(goldenV1());

    expect(res.sessions).toBe(1);
    expect(res.meta).toBe(1);
    expect(res.textRows).toBeGreaterThan(0);
    expect(res.savedViews).toBe(1);
    expect(res.audit).toBe(1);
    expect(res.legacyProvenance).toBe(1);

    // Session + mirrored text restored and searchable.
    expect(dest.getSessionSummary("legacy-1")!.title).toBe("Renamed legacy");
    expect(dest.search("mango").map((h) => h.sessionId)).toContain("legacy-1");

    // Provenance recorded as archive-v1-import (never native ownership).
    const raw = new DatabaseSync(destPath);
    const prov = raw.prepare("SELECT provenance FROM legacy_session_provenance WHERE legacy_session_id='legacy-1'").get() as { provenance: string };
    raw.close();
    expect(prov.provenance).toBe("archive-v1-import");
    dest.close();
  });

  it("v1 import NEVER overwrites a verified live mapping (quarantine skips provenance for it)", async () => {
    const dir = tmp();
    const destPath = path.join(dir, "dest.db");
    const dest = new TranscriptIndex(destPath);
    // Pre-existing verified live mapping for legacy-1.
    const home = dest.providerIndex.registerHome({ provider: "openai", home: "/home/dev/.codex" }, 1);
    dest.providerIndex.mapVerifiedLegacySession(
      "legacy-1",
      { version: 1, provider: "openai", homeFingerprint: home.homeFingerprint, nativeTaskId: "native-1" },
      { mappingSource: "live-provider-observation", verifiedAt: 10 },
    );

    const res = dest.importArchive(goldenV1());
    expect(res.sessions).toBe(1); // still restores the session data
    expect(res.legacyProvenance).toBe(0); // but does NOT quarantine the live-verified session

    // The verified live mapping is intact.
    const mapping = dest.providerIndex.getVerifiedLegacySessionMapping("legacy-1");
    expect(mapping?.locator.nativeTaskId).toBe("native-1");
    // No archive-v1-import provenance row was written over it.
    const raw = new DatabaseSync(destPath);
    const prov = raw.prepare("SELECT COUNT(*) AS c FROM legacy_session_provenance").get() as { c: number };
    raw.close();
    expect(prov.c).toBe(0);
    dest.close();
  });

  it("exportLegacyV1Archive excludes RESOLVED sessions and rejects explicitly selecting one", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-p");
    mkdirSync(proj);
    const fA = path.join(proj, "resolvedS.jsonl");
    const fB = path.join(proj, "unresolvedS.jsonl");
    writeTranscript(fA, "resolved");
    writeTranscript(fB, "unresolved");
    const idx = new TranscriptIndex(path.join(dir, "src.db"));
    await idx.indexSession(fA);
    await idx.indexSession(fB);

    // Mark "resolvedS" as having a verified unified mapping.
    const home = idx.providerIndex.registerHome({ provider: "openai", home: "/home/dev/.codex" }, 1);
    idx.providerIndex.mapVerifiedLegacySession(
      "resolvedS",
      { version: 1, provider: "openai", homeFingerprint: home.homeFingerprint, nativeTaskId: "n1" },
      { mappingSource: "live-provider-observation", verifiedAt: 5 },
    );

    // The legacy export carries only the UNRESOLVED corpus.
    const bundle = idx.exportLegacyV1Archive({ timestamp: 1 });
    expect(bundle.kind).toBe("claude-ui-archive");
    expect(bundle.schemaVersion).toBe(LEGACY_ARCHIVE_SCHEMA_VERSION);
    expect(bundle.sessions.map((s) => s.session.sessionId)).toEqual(["unresolvedS"]);

    // Explicitly selecting a resolved session is rejected.
    expect(() => idx.exportLegacyV1Archive({ timestamp: 1, sessionIds: ["resolvedS"] })).toThrow(ArchiveValidationError);
    // Selecting only the unresolved one is fine.
    expect(idx.exportLegacyV1Archive({ timestamp: 1, sessionIds: ["unresolvedS"] }).sessions).toHaveLength(1);
    idx.close();
  });
});

describe("version/discriminator + bounds", () => {
  it("an incompatible schemaVersion/discriminator throws (and no-ops in non-strict mode)", async () => {
    const dir = tmp();
    const dest = new TranscriptIndex(path.join(dir, "dest.db"));

    const bad = { kind: "devhub-archive", schemaVersion: 999, legacyMeta: [], savedViews: [], audit: [], providerTaskMeta: [], providerForkLinks: [] } as unknown as DevHubArchiveBundleV2;
    expect(() => dest.importArchive(bad)).toThrow(ArchiveVersionError);
    try {
      dest.importArchive(bad);
    } catch (err) {
      expect((err as ArchiveVersionError).found).toBe(999);
      expect((err as ArchiveVersionError).expected).toBe(DEVHUB_ARCHIVE_SCHEMA_VERSION);
    }
    // Wrong discriminator for a v2 version is also rejected.
    const mismatch = { kind: "claude-ui-archive", schemaVersion: 2, legacyMeta: [], savedViews: [], audit: [], providerTaskMeta: [], providerForkLinks: [] } as unknown as DevHubArchiveBundleV2;
    expect(() => dest.importArchive(mismatch)).toThrow(ArchiveVersionError);

    const res = dest.importArchive(bad, { strictVersion: false });
    expect(res.providerMeta).toBe(0);
    expect(res.meta).toBe(0);
    dest.close();
  });

  it("rejects a bomb-like oversized field before any write (bounded)", async () => {
    const dir = tmp();
    const dest = new TranscriptIndex(path.join(dir, "dest.db"));
    // A locator native id well past the 512-char cap.
    const bundle: DevHubArchiveBundleV2 = {
      kind: "devhub-archive",
      schemaVersion: DEVHUB_ARCHIVE_SCHEMA_VERSION,
      timestamp: 1,
      legacyMeta: [],
      savedViews: [],
      audit: [],
      providerTaskMeta: [
        {
          locator: { version: 1, provider: "openai", homeFingerprint: fp("a"), nativeTaskId: "z".repeat(600) },
          favorite: false, pinned: false, localLabel: null, tags: [], notes: null,
          localArchived: false, uiState: {}, unsupportedLocal: {}, updatedAt: null,
        },
      ],
      providerForkLinks: [],
    };
    expect(() => dest.importArchive(bundle)).toThrow(ArchiveValidationError);
    expect(counts(path.join(dir, "dest.db")).providerMeta).toBe(0);
    dest.close();
  });

  it("module-level exportArchive/importArchive work directly over a raw DB handle", async () => {
    const src = await buildSource();
    const bundle = exportArchive(new DatabaseSync(src.dbPath), { timestamp: 7 });
    expect(bundle.timestamp).toBe(7);
    expect(bundle.providerTaskMeta.length).toBe(2);

    const destPath = path.join(src.dir, "dest.db");
    const destIdx = new TranscriptIndex(destPath);
    destIdx.close();
    const destDb = new DatabaseSync(destPath);
    const res = importArchive(destDb, bundle);
    destDb.close();
    expect(res.meta).toBe(2);
    expect(res.providerMeta).toBe(2);
    src.idx.close();
  });
});

/**
 * SELECTIVE export (v2) — the selection scopes the additive legacy meta + audit.
 */
const cwdAlpha = "/home/dev/alpha-project";
const cwdBeta = "/home/dev/beta-project";
const projAlpha = projectIdFromCwd(cwdAlpha);
const projBeta = projectIdFromCwd(cwdBeta);

async function buildMultiProject() {
  const dir = tmp();
  const proj = path.join(dir, "-multi");
  mkdirSync(proj);
  const fA1 = path.join(proj, "a1.jsonl");
  const fB1 = path.join(proj, "b1.jsonl");
  writeTranscript(fA1, "apple", { cwd: cwdAlpha, timestamp: "2024-01-01T00:00:00.000Z" });
  writeTranscript(fB1, "banana", { cwd: cwdBeta, timestamp: "2024-06-01T00:00:00.000Z" });
  const dbPath = path.join(dir, "multi.db");
  const idx = new TranscriptIndex(dbPath);
  await idx.indexSession(fA1);
  await idx.indexSession(fB1);
  idx.setTags("a1", ["alpha"]);
  idx.setNotes("b1", "beta findings");
  idx.audit.logDecision({ sessionId: "a1", toolName: "Bash", decision: "allow", scope: "once" });
  idx.audit.logDecision({ sessionId: "b1", toolName: "Bash", decision: "deny", scope: "once" });
  idx.saveView({ name: "Fruit", query: "apple", facets: {} });
  return { idx, dbPath, dir };
}

describe("selective v2 export scopes additive meta + audit", () => {
  it("by projectId: only that project's session_meta + scoped audit; saved views global", async () => {
    const src = await buildMultiProject();
    const bundle = src.idx.exportArchive({ timestamp: 1, projectId: projAlpha });
    expect(bundle.legacyMeta.map((m) => m.sessionId)).toEqual(["a1"]);
    expect(bundle.audit.map((a) => a.sessionId).sort()).toEqual(["a1"]);
    expect(bundle.savedViews).toHaveLength(1);
    src.idx.close();
  });

  it("exportArchiveForProject is the projectId shorthand", async () => {
    const src = await buildMultiProject();
    const db = new DatabaseSync(src.dbPath);
    try {
      const viaHelper = exportArchiveForProject(db, projBeta, { timestamp: 9 });
      const viaOpts = exportArchive(db, { timestamp: 9, projectId: projBeta });
      expect(viaHelper).toEqual(viaOpts);
      expect(viaHelper.legacyMeta.map((m) => m.sessionId)).toEqual(["b1"]);
    } finally {
      db.close();
    }
    src.idx.close();
  });
});
