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

/**
 * Which CLI/agent produced a session. Today everything we scan is "claude" (these
 * files live under ~/.claude/projects); the other kinds exist so future ingestion
 * of Codex/Gemini/Cursor logs can tag their sessions without a schema change.
 */
export type SourceKind = "claude" | "codex" | "gemini" | "cursor" | "unknown";

/**
 * Substring hints for detecting a non-Claude source from a folder name or cwd.
 * Order matters only for display; matching is independent per kind.
 */
const SOURCE_HINTS: Array<{ kind: SourceKind; patterns: string[] }> = [
  { kind: "codex", patterns: [".codex", "/codex/", "codex-"] },
  { kind: "gemini", patterns: [".gemini", "/gemini/", "gemini-cli"] },
  { kind: "cursor", patterns: [".cursor", "/cursor/"] },
];

/**
 * Best-effort source detection from a project folder path or a session's true cwd.
 * Defaults to "claude" (current behavior) since everything we scan today comes from
 * ~/.claude/projects. Exposed so future multi-source ingestion can label sessions.
 */
export function detectSourceKind(folderOrCwd: string | null | undefined): SourceKind {
  if (!folderOrCwd) return "claude";
  const lower = folderOrCwd.toLowerCase();
  for (const { kind, patterns } of SOURCE_HINTS) {
    if (patterns.some((p) => lower.includes(p))) return kind;
  }
  return "claude";
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
