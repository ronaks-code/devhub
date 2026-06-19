import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/index.js";
import {
  aggregateFileChanges,
  type SessionFileChanges,
} from "../src/file-changes.js";
import type { NormalizedMessage } from "../src/types.js";

/**
 * Hermetic tests for the per-session "files changed" aggregate.
 *
 * Two layers:
 *  - PURE: {@link aggregateFileChanges} folds normalized messages → per-file edit/write
 *    counts + a summary, with cwd-relative display paths. Exercised directly with synthetic
 *    NormalizedMessage[] (no file I/O) for the counting math, path relativization, and the
 *    robustness contract (no-edit + odd inputs).
 *  - WIRED: {@link Engine.sessionFileChanges} reuses the real bounded message-loading path
 *    (getSessionMessages) on a TEMP index (own DB + transcript dir — nothing touches
 *    ~/.claude). Proves Edit/MultiEdit/Write fold into correct per-file counts and that an
 *    unknown session id returns the empty result.
 */

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-filechanges-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** Build a NormalizedMessage carrying a list of tool_use blocks (the only shape we read). */
function asstMsg(
  seq: number,
  blocks: Array<{ name: string; input: unknown }>,
): NormalizedMessage {
  return {
    seq,
    uuid: `u${seq}`,
    parentUuid: null,
    role: "assistant",
    type: "assistant",
    timestamp: null,
    blocks: blocks.map((b, i) => ({
      type: "tool_use" as const,
      id: `tu-${seq}-${i}`,
      name: b.name,
      input: b.input,
    })),
  };
}

/**
 * Write a transcript that invokes a sequence of file-mutating tools. Each spec emits an
 * assistant tool_use with the given input, so indexing → getSessionMessages reproduces the
 * blocks sessionFileChanges walks.
 */
function writeSession(
  dir: string,
  id: string,
  opts: { cwd: string; tools: Array<{ name: string; input: Record<string, unknown> }> },
): string {
  const file = path.join(dir, `${id}.jsonl`);
  const ts = new Date(Date.UTC(2026, 5, 10, 12, 0, 0)).toISOString();
  let body = jl({
    type: "user",
    cwd: opts.cwd,
    timestamp: ts,
    message: { role: "user", content: "do the work" },
  });
  const content: unknown[] = [{ type: "text", text: "editing files" }];
  opts.tools.forEach((t, i) =>
    content.push({ type: "tool_use", id: `u${i}`, name: t.name, input: t.input }),
  );
  body += jl({
    type: "assistant",
    cwd: opts.cwd,
    timestamp: ts,
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      content,
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  });
  writeFileSync(file, body);
  return file;
}

describe("aggregateFileChanges (pure walk)", () => {
  it("tallies Edit (1) + MultiEdit (its edits) + Write per file, sorted by activity", () => {
    const cwd = "/home/dev/proj";
    const msgs: NormalizedMessage[] = [
      asstMsg(0, [{ name: "Edit", input: { file_path: `${cwd}/src/a.ts` } }]),
      asstMsg(1, [
        // MultiEdit with 3 edits → edits +3 on the SAME file as the earlier Edit
        { name: "MultiEdit", input: { file_path: `${cwd}/src/a.ts`, edits: [1, 2, 3] } },
      ]),
      asstMsg(2, [{ name: "Write", input: { file_path: `${cwd}/src/new.ts` } }]),
    ];

    const res = aggregateFileChanges(msgs, cwd);

    // a.ts: 1 Edit + 3 MultiEdit edits = 4 edits, 0 writes, tools [Edit, MultiEdit].
    const a = res.files.find((f) => f.filePath === "src/a.ts")!;
    expect(a.edits).toBe(4);
    expect(a.writes).toBe(0);
    expect(a.tools).toEqual(["Edit", "MultiEdit"]);
    expect(a.absPath).toBe(`${cwd}/src/a.ts`);

    // new.ts: 1 Write, relativized for display.
    const n = res.files.find((f) => f.filePath === "src/new.ts")!;
    expect(n.writes).toBe(1);
    expect(n.edits).toBe(0);
    expect(n.tools).toEqual(["Write"]);

    // Most-active file first.
    expect(res.files[0]!.filePath).toBe("src/a.ts");
    expect(res.summary).toEqual({ fileCount: 2, editCount: 4, writeCount: 1 });
  });

  it("relativizes against cwd, keeps the absolute path, and leaves out-of-tree files absolute", () => {
    const cwd = "/home/dev/proj";
    const msgs: NormalizedMessage[] = [
      asstMsg(0, [{ name: "Edit", input: { file_path: `${cwd}/lib/x.ts` } }]),
      asstMsg(1, [{ name: "Edit", input: { file_path: "/etc/hosts" } }]),
    ];

    const res = aggregateFileChanges(msgs, cwd);
    const inTree = res.files.find((f) => f.absPath === `${cwd}/lib/x.ts`)!;
    const outTree = res.files.find((f) => f.absPath === "/etc/hosts")!;
    expect(inTree.filePath).toBe("lib/x.ts"); // relativized for display
    expect(outTree.filePath).toBe("/etc/hosts"); // outside cwd → stays absolute
  });

  it("returns empty for a session with no file edits and tolerates odd/partial inputs", () => {
    const msgs: NormalizedMessage[] = [
      // A non-edit tool, an edit tool with no path, a non-object input, a Read.
      asstMsg(0, [{ name: "Bash", input: { command: "ls" } }]),
      asstMsg(1, [{ name: "Edit", input: { foo: "bar" } }]), // no file_path
      asstMsg(2, [{ name: "Write", input: "oops-not-an-object" }]),
      asstMsg(3, [{ name: "Read", input: { file_path: "/home/dev/proj/r.ts" } }]),
    ];
    const res = aggregateFileChanges(msgs, "/home/dev/proj");
    expect(res.files).toEqual([]);
    expect(res.summary).toEqual({ fileCount: 0, editCount: 0, writeCount: 0 });
  });

  it("falls back to notebook_path and counts a MultiEdit with no edits array as one", () => {
    const cwd = "/home/dev/proj";
    const msgs: NormalizedMessage[] = [
      asstMsg(0, [{ name: "NotebookEdit", input: { notebook_path: `${cwd}/nb.ipynb` } }]),
      asstMsg(1, [{ name: "MultiEdit", input: { file_path: `${cwd}/m.ts` } }]), // no edits array
    ];
    const res = aggregateFileChanges(msgs, cwd);
    const nb = res.files.find((f) => f.filePath === "nb.ipynb")!;
    const m = res.files.find((f) => f.filePath === "m.ts")!;
    expect(nb.edits).toBe(1);
    expect(m.edits).toBe(1); // missing edits[] → counts as a single edit
    expect(res.summary.editCount).toBe(2);
  });

  it("leaves paths unchanged when cwd is null", () => {
    const msgs: NormalizedMessage[] = [
      asstMsg(0, [{ name: "Edit", input: { file_path: "/abs/only/a.ts" } }]),
    ];
    const res = aggregateFileChanges(msgs, null);
    expect(res.files[0]!.filePath).toBe("/abs/only/a.ts");
  });
});

describe("Engine.sessionFileChanges (wired through getSessionMessages)", () => {
  function freshEngine(dir: string): Engine {
    return new Engine(path.join(dir, "i.db"));
  }

  it("aggregates Edit + MultiEdit + Write from a real indexed session", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const cwd = "/home/dev/widget-shop";
    const file = writeSession(proj, "s1", {
      cwd,
      tools: [
        { name: "Edit", input: { file_path: `${cwd}/src/app.ts` } },
        { name: "MultiEdit", input: { file_path: `${cwd}/src/app.ts`, edits: [1, 2] } },
        { name: "Write", input: { file_path: `${cwd}/README.md`, content: "hi" } },
      ],
    });

    const engine = freshEngine(dir);
    try {
      await engine.index.indexSession(file);
      const res: SessionFileChanges = await engine.sessionFileChanges("s1");

      expect(res.summary).toEqual({ fileCount: 2, editCount: 3, writeCount: 1 });
      const app = res.files.find((f) => f.filePath === "src/app.ts")!;
      expect(app.edits).toBe(3); // 1 Edit + 2 MultiEdit edits
      expect(app.writes).toBe(0);
      expect(app.tools).toEqual(["Edit", "MultiEdit"]);
      const readme = res.files.find((f) => f.filePath === "README.md")!;
      expect(readme.writes).toBe(1);
      // Most-active file is first.
      expect(res.files[0]!.filePath).toBe("src/app.ts");
    } finally {
      engine.close();
    }
  });

  it("returns the empty result for a session with no file edits", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const cwd = "/home/dev/noedits";
    // A session that only runs Bash + Read (no file mutations).
    const file = writeSession(proj, "s2", {
      cwd,
      tools: [
        { name: "Bash", input: { command: "npm test" } },
        { name: "Read", input: { file_path: `${cwd}/src/x.ts` } },
      ],
    });

    const engine = freshEngine(dir);
    try {
      await engine.index.indexSession(file);
      const res = await engine.sessionFileChanges("s2");
      expect(res.files).toEqual([]);
      expect(res.summary).toEqual({ fileCount: 0, editCount: 0, writeCount: 0 });
    } finally {
      engine.close();
    }
  });

  it("returns the empty result for an unknown session id (never throws)", async () => {
    const dir = tmp();
    const engine = freshEngine(dir);
    try {
      const res = await engine.sessionFileChanges("does-not-exist");
      expect(res.files).toEqual([]);
      expect(res.summary).toEqual({ fileCount: 0, editCount: 0, writeCount: 0 });
    } finally {
      engine.close();
    }
  });
});
