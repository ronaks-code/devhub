/**
 * File-history checkpoints: list and restore PROJECT files from the per-session
 * snapshots Claude Code keeps under `~/.claude/file-history/<sessionId>/`.
 *
 * How Claude Code's file history works (observed on disk):
 *   - Before it edits a tracked project file, it copies the file's current bytes to
 *     `~/.claude/file-history/<sessionId>/<hash>@v<N>` (a content-addressed blob).
 *   - The transcript records a `file-history-snapshot` line:
 *       { type: "file-history-snapshot",
 *         messageId,
 *         snapshot: {
 *           messageId,
 *           timestamp,                     // ISO time of the snapshot
 *           trackedFileBackups: {
 *             "<path>": { backupFileName: "<hash>@vN", version, backupTime }
 *           }
 *         },
 *         isSnapshotUpdate }
 *   - `<path>` is RELATIVE to the session's cwd (e.g. "src/app.ts", "../sib/x.ts")
 *     or ABSOLUTE ("/Users/.../x.ts"); we resolve it against the session cwd.
 *
 * So a "checkpoint" = one `file-history-snapshot` line: a point in time, the files
 * it backed up, and the blob holding each file's pre-edit bytes.
 *
 * SAFETY CONTRACT for restore:
 *   - This restores the user's PROJECT FILES (the feature) — it NEVER writes a
 *     transcript or any `~/.claude` data.
 *   - `dryRun` (default ON for the plan) reports exactly what WOULD be written
 *     without touching disk.
 *   - Each target file is backed up to `<file>.bak` before being overwritten.
 *   - Restores resolve under the session cwd; a target that escapes nowhere is fine
 *     (Claude itself tracked it), but a missing backup blob is skipped + reported
 *     rather than silently writing nothing.
 *   - Writes are atomic (temp file + rename).
 *
 * Tolerant reads: a missing transcript / file-history dir yields an empty list.
 */
import { readFile, writeFile, copyFile, rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { claudeConfigDir } from "./paths.js";
import { streamRawLines } from "./parser.js";

/** Directory holding a session's file-history blobs. */
export function fileHistoryDir(sessionId: string): string {
  return path.join(claudeConfigDir(), "file-history", sessionId);
}

/** One file backed up within a checkpoint. */
export interface CheckpointFile {
  /** Path as written in the transcript (relative to cwd, or absolute). */
  path: string;
  /** Absolute path the backup would be restored to (resolved against the session cwd). */
  absolutePath: string;
  /** Blob file name under the session's file-history dir (e.g. "abc123@v2"). */
  backupFileName: string;
  /** Absolute path of the backup blob. */
  backupPath: string;
  /** Backup version counter from the snapshot, when present. */
  version: number | null;
  /** ISO time this file was backed up, when present. */
  backupTime: string | null;
}

/** One checkpoint: a single `file-history-snapshot` line and the files it captured. */
export interface Checkpoint {
  /** The snapshot's messageId (use as the restore target id). */
  messageId: string;
  /** The inner snapshot messageId, when it differs (the message the snapshot is for). */
  snapshotMessageId: string | null;
  /** ISO timestamp of the snapshot. */
  timestamp: string | null;
  /** Whether Claude flagged this as an update to a prior snapshot. */
  isSnapshotUpdate: boolean;
  /** Files captured in this checkpoint. May be empty (a marker snapshot). */
  files: CheckpointFile[];
}

interface BackupEntry {
  backupFileName: string;
  version: number | null;
  backupTime: string | null;
}

/** Pull a string field off an unknown object, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Resolve a tracked-file path against the session cwd (absolute paths pass through). */
function resolveTarget(filePath: string, cwd: string | null): string {
  if (path.isAbsolute(filePath)) return filePath;
  return cwd ? path.resolve(cwd, filePath) : path.resolve(filePath);
}

/** Parse a snapshot line's `trackedFileBackups` map into typed entries. */
function parseBackups(raw: unknown): Record<string, BackupEntry> {
  const out: Record<string, BackupEntry> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [filePath, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const backupFileName = str(e.backupFileName);
    if (!backupFileName) continue; // an entry with no blob is unusable
    out[filePath] = {
      backupFileName,
      version: typeof e.version === "number" ? e.version : null,
      backupTime: str(e.backupTime),
    };
  }
  return out;
}

/**
 * List the checkpoints for a session by scanning its transcript for
 * `file-history-snapshot` lines. Each becomes a {@link Checkpoint} with the files it
 * backed up resolved to absolute paths + blob locations.
 *
 *  - `transcriptPath` is the session's `.jsonl` (from the index's SessionSummary).
 *  - `sessionCwd` resolves relative tracked-file paths (the session's true cwd).
 *
 * Tolerant: a missing/unreadable transcript yields []. Order is transcript order
 * (chronological), oldest first.
 */
export async function listCheckpoints(
  sessionId: string,
  transcriptPath: string,
  sessionCwd: string | null,
): Promise<Checkpoint[]> {
  const dir = fileHistoryDir(sessionId);
  const out: Checkpoint[] = [];
  let lines: AsyncGenerator<Record<string, unknown>>;
  try {
    lines = streamRawLines(transcriptPath);
  } catch {
    return out;
  }
  try {
    for await (const raw of lines) {
      if (raw.type !== "file-history-snapshot") continue;
      const snapshot =
        raw.snapshot && typeof raw.snapshot === "object" && !Array.isArray(raw.snapshot)
          ? (raw.snapshot as Record<string, unknown>)
          : {};
      const messageId = str(raw.messageId) ?? str(snapshot.messageId);
      if (!messageId) continue; // no stable id to restore to — skip
      const backups = parseBackups(snapshot.trackedFileBackups);
      const files: CheckpointFile[] = Object.entries(backups).map(([filePath, b]) => ({
        path: filePath,
        absolutePath: resolveTarget(filePath, sessionCwd),
        backupFileName: b.backupFileName,
        backupPath: path.join(dir, b.backupFileName),
        version: b.version,
        backupTime: b.backupTime,
      }));
      out.push({
        messageId,
        snapshotMessageId: str(snapshot.messageId),
        timestamp: str(snapshot.timestamp),
        isSnapshotUpdate: raw.isSnapshotUpdate === true,
        files,
      });
    }
  } catch {
    // A read error mid-stream returns whatever we parsed so far.
  }
  return out;
}

/** What a restore did (dry-run or real) for one file. */
export interface RestoredFile {
  /** Absolute path that was (or would be) overwritten. */
  absolutePath: string;
  /** Blob the bytes came from. */
  backupPath: string;
  /** "restored" (written), "would-restore" (dry-run), or "skipped" (blob missing). */
  action: "restored" | "would-restore" | "skipped";
  /** Reason a file was skipped (e.g. "backup blob missing"). */
  reason?: string;
  /** Where the prior contents were backed up to (real restore of an existing file). */
  backedUpTo?: string;
}

/** Result of a {@link restoreCheckpoint} call. */
export interface RestoreResult {
  sessionId: string;
  messageId: string;
  /** Whether this was a dry run (nothing written). */
  dryRun: boolean;
  /** Per-file outcome. */
  files: RestoredFile[];
}

/** Back up `file` to `<file>.bak` if it exists; no-op when the source is absent. */
async function backup(file: string): Promise<string | undefined> {
  try {
    await stat(file);
  } catch {
    return undefined; // nothing to back up
  }
  const dest = `${file}.bak`;
  await copyFile(file, dest);
  return dest;
}

/** Atomic write: temp file in the target dir, then rename over the target. */
async function atomicWrite(file: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/**
 * Restore the PROJECT files captured in one checkpoint to their backed-up bytes.
 *
 * Finds the checkpoint with `messageId` in the session's transcript, then for each
 * tracked file copies the blob's bytes back onto the project file. This is the
 * explicit checkpoint-restore feature — it writes the USER'S PROJECT FILES, never a
 * transcript or any `~/.claude` data.
 *
 *  - `opts.dryRun` (DEFAULT true): report what would happen, write nothing. Pass
 *    `{ dryRun: false }` to actually restore.
 *  - Each existing target is backed up to `<file>.bak` before being overwritten.
 *  - A missing backup blob is reported as `action: "skipped"` (never a silent write).
 *
 * Throws only when the checkpoint id isn't found (so the caller can surface a clear
 * error); per-file blob problems are reported in the result, not thrown.
 */
export async function restoreCheckpoint(
  sessionId: string,
  messageId: string,
  transcriptPath: string,
  sessionCwd: string | null,
  opts: { dryRun?: boolean } = {},
): Promise<RestoreResult> {
  const dryRun = opts.dryRun !== false; // default ON — safe by default
  const checkpoints = await listCheckpoints(sessionId, transcriptPath, sessionCwd);
  const cp = checkpoints.find((c) => c.messageId === messageId);
  if (!cp) {
    throw new Error(`restoreCheckpoint: no checkpoint with messageId "${messageId}" for session ${sessionId}`);
  }

  const files: RestoredFile[] = [];
  for (const f of cp.files) {
    // The blob must exist to restore from; otherwise skip + report.
    let blob: Buffer | null = null;
    try {
      blob = await readFile(f.backupPath);
    } catch {
      files.push({
        absolutePath: f.absolutePath,
        backupPath: f.backupPath,
        action: "skipped",
        reason: "backup blob missing",
      });
      continue;
    }

    if (dryRun) {
      files.push({
        absolutePath: f.absolutePath,
        backupPath: f.backupPath,
        action: "would-restore",
      });
      continue;
    }

    const backedUpTo = await backup(f.absolutePath);
    await atomicWrite(f.absolutePath, blob);
    files.push({
      absolutePath: f.absolutePath,
      backupPath: f.backupPath,
      action: "restored",
      ...(backedUpTo ? { backedUpTo } : {}),
    });
  }

  return { sessionId, messageId, dryRun, files };
}
