/**
 * Per-session "files changed" aggregate — WHICH project files a session edited or
 * wrote, derived purely from the session's transcript tool_use blocks.
 *
 * A session's record of file mutations lives in its assistant `tool_use` blocks:
 * Edit / MultiEdit / Write / NotebookEdit each carry a `file_path` (NotebookEdit a
 * `notebook_path`) in their input. We walk the ALREADY-NORMALIZED messages (a single
 * bounded transcript read via the engine's `getSessionMessages`, never a corpus scan),
 * tally per-file edit/write counts, and return one display-friendly row per file.
 *
 *  - PURE walk: {@link aggregateFileChanges} takes the normalized messages + cwd and
 *    returns the result, so it's unit-testable without any file I/O; the engine method
 *    wires it to the real message-loading path.
 *  - ROBUST: a session with no file edits -> empty result; tolerate partial/odd tool
 *    inputs (a missing/non-string path, a non-object input) — they're skipped, never
 *    thrown on.
 *  - DISPLAY-FRIENDLY paths: when the session's cwd is known and a file lives under it,
 *    `filePath` is the project-relative path; the original absolute path is kept on
 *    `absPath` so a face can still open/serve the real file.
 */
import path from "node:path";
import type { ContentBlock, NormalizedMessage } from "./types.js";

/** The file-mutating tools whose `tool_use` blocks we tally (each carries a path). */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** One file a session touched, with per-tool activity counts. */
export interface FileChange {
  /** Display path: project-relative when under the session cwd, else the absolute path. */
  filePath: string;
  /** The absolute (original, un-relativized) path as it appeared in the tool input. */
  absPath: string;
  /** How many Edit/MultiEdit/NotebookEdit operations targeted this file (MultiEdit counts its `edits`). */
  edits: number;
  /** How many Write operations targeted this file. */
  writes: number;
  /** The distinct tool names that touched this file, in first-seen order (e.g. ["Edit","Write"]). */
  tools: string[];
}

/** Headline totals for a session's file changes (companion to the per-file rows). */
export interface FileChangesSummary {
  /** Number of distinct files touched. */
  fileCount: number;
  /** Total edit operations across all files (MultiEdit counts each of its `edits`). */
  editCount: number;
  /** Total write operations across all files. */
  writeCount: number;
}

/** A session's file-change aggregate: the per-file rows plus the headline summary. */
export interface SessionFileChanges {
  files: FileChange[];
  summary: FileChangesSummary;
}

/** A `tool_use` block's input as a plain object, or null when it isn't one. */
function inputObject(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** Read a trimmed, non-empty string field off an input object, or null. */
function strField(io: Record<string, unknown>, key: string): string | null {
  const v = io[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * How many discrete edits a tool input represents:
 *  - MultiEdit applies an array of edits in one call → its `edits.length` (>=1).
 *  - Edit / NotebookEdit are a single edit each → 1.
 * Tolerant: a missing/odd `edits` array falls back to 1.
 */
function editCountOf(toolName: string, io: Record<string, unknown>): number {
  if (toolName === "MultiEdit") {
    const e = io.edits;
    return Array.isArray(e) && e.length > 0 ? e.length : 1;
  }
  return 1;
}

/**
 * Relativize an absolute file path against the session cwd for display. Returns the
 * project-relative path when the file lives at/under cwd (no `../` escape), else the
 * original path unchanged. A blank/missing cwd leaves the path as-is.
 */
function displayPath(absPath: string, cwd: string | null): string {
  if (!cwd || !path.isAbsolute(absPath)) return absPath;
  const rel = path.relative(cwd, absPath);
  // Keep the absolute path when the file is outside the project (rel starts with `..`)
  // or relativization produced an absolute path (different drive/root on win32).
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
  return rel;
}

/**
 * Walk a session's normalized messages and aggregate the files it edited/wrote.
 *
 * Pure: no file I/O — pass the messages (from {@link Engine.getSessionMessages}) plus the
 * session cwd (for display relativization). Returns per-file rows sorted by activity
 * (edits+writes desc, then path asc) plus a headline summary. Tolerates malformed blocks
 * and never throws.
 */
export function aggregateFileChanges(
  messages: NormalizedMessage[],
  cwd: string | null,
): SessionFileChanges {
  // Keyed by the ABSOLUTE path so the same file across tools/edits folds into one row.
  const byPath = new Map<string, FileChange>();
  let editCount = 0;
  let writeCount = 0;

  for (const msg of messages) {
    // Only assistant turns carry tool_use blocks; skip everything else cheaply.
    if (msg.role !== "assistant") continue;
    const blocks: ContentBlock[] = Array.isArray(msg.blocks) ? msg.blocks : [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_use") continue;
      const toolName = typeof block.name === "string" ? block.name : "";
      if (!EDIT_TOOLS.has(toolName)) continue;
      const io = inputObject(block.input);
      if (!io) continue;
      const absPath = strField(io, "file_path") ?? strField(io, "notebook_path");
      if (!absPath) continue; // partial/odd input with no usable path — skip, don't throw

      let row = byPath.get(absPath);
      if (!row) {
        row = {
          filePath: displayPath(absPath, cwd),
          absPath,
          edits: 0,
          writes: 0,
          tools: [],
        };
        byPath.set(absPath, row);
      }
      if (!row.tools.includes(toolName)) row.tools.push(toolName);

      if (toolName === "Write") {
        row.writes += 1;
        writeCount += 1;
      } else {
        const n = editCountOf(toolName, io);
        row.edits += n;
        editCount += n;
      }
    }
  }

  const files = [...byPath.values()].sort((a, b) => {
    const actA = a.edits + a.writes;
    const actB = b.edits + b.writes;
    if (actB !== actA) return actB - actA; // most activity first
    return a.filePath.localeCompare(b.filePath); // stable tiebreak by display path
  });

  return {
    files,
    summary: { fileCount: files.length, editCount, writeCount },
  };
}
