/**
 * Filesystem discovery of transcript files. Deliberately dumb: it only finds
 * files. Grouping into projects happens via the index, which reads the TRUE cwd
 * from inside each transcript (folder names are lossy and can collide).
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { projectsDir } from "./paths.js";

/**
 * Folder-name substrings for internal/plugin transcript stores that aren't real
 * coding sessions (e.g. claude-mem's observer logs — hundreds of files incl. a
 * 500MB+ one). Skipping them removes noise and avoids reading gigabytes.
 */
export const INTERNAL_FOLDER_PATTERNS = ["claude-mem", "observer-sessions"];

export function isInternalFolder(folderPath: string): boolean {
  const base = path.basename(folderPath);
  return INTERNAL_FOLDER_PATTERNS.some((p) => base.includes(p));
}

export async function scanProjectFolders(): Promise<string[]> {
  try {
    const entries = await readdir(projectsDir(), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsDir(), e.name))
      .filter((p) => !isInternalFolder(p));
  } catch {
    return [];
  }
}

/** Top-level *.jsonl in a project folder (excludes nested subagent transcripts). */
export async function scanSessionFiles(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(folder, e.name));
  } catch {
    return [];
  }
}

export async function scanAllSessionFiles(): Promise<string[]> {
  const folders = await scanProjectFolders();
  const all: string[] = [];
  for (const f of folders) {
    all.push(...(await scanSessionFiles(f)));
  }
  return all;
}
