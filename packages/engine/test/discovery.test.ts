import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptIndex } from "../src/index-db.js";
import { encodeCwd, projectIdFromCwd } from "../src/paths.js";

// Project grouping / orphan-folder recovery.
//
// Claude Code's on-disk folder names are a LOSSY encoding of a cwd (every non-alnum
// char -> "-"), so the folder name can collide across different cwds AND can go stale
// when a directory is renamed/moved. The index therefore groups sessions by the TRUE
// cwd read from INSIDE each transcript (-> a stable projectId), never by folder name.
// These tests build a temp projects layout exercising the three real-world hazards and
// assert grouping is by in-file cwd. Hermetic: a temp DB + temp dirs; no ~/.claude.

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-disc-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** Write a one-line transcript whose in-file cwd is `cwd`. */
const writeSession = (folder: string, id: string, cwd: string, text: string): string => {
  const p = path.join(folder, `${id}.jsonl`);
  writeFileSync(p, jl({ type: "user", cwd, message: { role: "user", content: text } }));
  return p;
};

describe("project grouping by in-file cwd", () => {
  it("groups two lossy-encoded folders that resolve to the SAME cwd into one project", async () => {
    const dir = tmp();
    // The lossy encoder maps both "/home/me/a-b" and "/home/me/a/b" to the same folder
    // name — a genuine collision. But these are DIFFERENT cwds, so each must stay its
    // own project keyed by the true (distinct) cwd. Conversely, two DIFFERENT folder
    // names whose sessions share ONE in-file cwd must collapse to one project.
    const cwd = "/home/me/widget-shop";
    // Folder #1: the "canonical" lossy-encoded folder for this cwd.
    const folderA = path.join(dir, encodeCwd(cwd));
    // Folder #2: a stale/renamed folder name that no longer encodes the cwd, but whose
    // session's in-file cwd is the SAME project (a rename-orphan to recover).
    const folderB = path.join(dir, "-home-me-old-widget-name");
    mkdirSync(folderA);
    mkdirSync(folderB);

    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(writeSession(folderA, "sessA", cwd, "build the checkout"));
    await idx.indexSession(writeSession(folderB, "sessB", cwd, "fix the cart bug"));

    // ONE project (grouped by the shared in-file cwd), with BOTH folders recorded.
    const projects = idx.getProjects();
    const proj = projects.find((p) => p.cwd === cwd)!;
    expect(proj).toBeDefined();
    expect(proj.id).toBe(projectIdFromCwd(cwd));
    expect(proj.sessionCount).toBe(2);
    // >1 encoded folder == a rename/collision was recovered under one project.
    expect(proj.encodedFolders.sort()).toEqual(
      [path.basename(folderA), path.basename(folderB)].sort(),
    );
    idx.close();
  });

  it("keeps two DIFFERENT cwds as separate projects even from one folder", async () => {
    const dir = tmp();
    const folder = path.join(dir, "-mixed");
    mkdirSync(folder);
    const cwd1 = "/home/me/alpha";
    const cwd2 = "/home/me/beta";

    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(writeSession(folder, "s1", cwd1, "deploy alpha"));
    await idx.indexSession(writeSession(folder, "s2", cwd2, "deploy beta"));

    const projects = idx.getProjects();
    expect(projects.find((p) => p.cwd === cwd1)?.id).toBe(projectIdFromCwd(cwd1));
    expect(projects.find((p) => p.cwd === cwd2)?.id).toBe(projectIdFromCwd(cwd2));
    expect(projects.find((p) => p.cwd === cwd1)?.sessionCount).toBe(1);
    expect(projects.find((p) => p.cwd === cwd2)?.sessionCount).toBe(1);
    idx.close();
  });

  it("recovers a rename-orphan: a session whose FOLDER name no longer matches its in-file cwd", async () => {
    const dir = tmp();
    const cwd = "/home/me/renamed-project";
    // The session lives in a folder whose name encodes a DIFFERENT, older path — the
    // project was renamed on disk after this session was recorded. The in-file cwd is
    // the source of truth, so the session must land under the renamed project, NOT
    // under a project derived from the stale folder name.
    const staleFolder = path.join(dir, encodeCwd("/home/me/old-name-before-rename"));
    mkdirSync(staleFolder);

    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(writeSession(staleFolder, "orphan", cwd, "continue the work"));

    const projects = idx.getProjects();
    // Grouped under the TRUE (in-file) cwd's project id — the orphan is recovered.
    const recovered = projects.find((p) => p.id === projectIdFromCwd(cwd));
    expect(recovered).toBeDefined();
    expect(recovered!.cwd).toBe(cwd);
    expect(recovered!.sessionCount).toBe(1);
    // It must NOT have been bucketed under the stale folder name's would-be project.
    const staleId = projectIdFromCwd("/home/me/old-name-before-rename");
    expect(projects.find((p) => p.id === staleId)).toBeUndefined();
    // The session is reachable via the recovered project's id.
    const sessions = idx.getSessionsForProject(projectIdFromCwd(cwd));
    expect(sessions.map((s) => s.sessionId)).toEqual(["orphan"]);
    idx.close();
  });

  it("the lossy encoder really does collide (motivates cwd-based grouping)", () => {
    // Two different paths encode to the SAME folder name — proof that the folder name
    // alone can't identify a project, which is why grouping uses the in-file cwd.
    expect(encodeCwd("/home/me/a-b")).toBe(encodeCwd("/home/me/a/b"));
  });
});
