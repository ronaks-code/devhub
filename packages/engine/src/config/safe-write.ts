/**
 * One safe-write primitive for every config file the engine touches.
 *
 * The contract (the same one {@link writeClaudeMd}/{@link setMcpServer} hand-rolled
 * before): VALIDATE the caller's content, BACK UP the existing file, then write
 * ATOMICALLY (temp file in the same dir + rename, so a reader never sees a partial
 * write). We NEVER touch transcripts — only config files flow through here.
 *
 * Backups ROTATE. Instead of a single clobbered `<file>.bak`, each write snapshots
 * the prior contents to a timestamped `<file>.bak.<ts>` and prunes to the most recent
 * {@link DEFAULT_BACKUP_KEEP}. That history powers a restore picker:
 *   - {@link listBackups} enumerates the snapshots (newest first), and
 *   - {@link restoreBackup} promotes a chosen snapshot back over the live file —
 *     itself a safe write, so the about-to-be-overwritten "current" state is backed
 *     up first and a bad restore is itself undoable.
 *
 * Everything is keyed off the LIVE file path; backups live beside it. A `backupId`
 * is just the snapshot's filename (no directory), so it's safe to round-trip through
 * an API without leaking absolute paths or allowing traversal.
 */
import { readFile, readdir, writeFile, copyFile, rename, mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** How many rotating `<file>.bak.<ts>` snapshots to keep per file by default. */
export const DEFAULT_BACKUP_KEEP = 5;

/** Suffix that marks a rotating backup: `<basename>.bak.<epochMillis>`. */
const BAK_INFIX = ".bak.";

/** One rotating backup snapshot of a config file. */
export interface BackupInfo {
  /** Opaque id == the backup's basename (e.g. `settings.json.bak.1718580000000`). */
  id: string;
  /** Absolute path of the backup file. */
  path: string;
  /** Snapshot time parsed from the id (epoch ms). */
  timestamp: number;
  /** Size of the backup in bytes. */
  sizeBytes: number;
}

/** The `<file>.bak.<ts>` path for a given live file + timestamp. */
function backupPathFor(file: string, ts: number): string {
  return `${file}${BAK_INFIX}${ts}`;
}

/**
 * Parse the epoch-ms timestamp out of a backup basename, or null when `name` isn't a
 * backup of `liveBase` (the live file's basename). Used to enumerate + prune.
 */
function parseBackupTs(liveBase: string, name: string): number | null {
  const prefix = `${liveBase}${BAK_INFIX}`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  const ts = Number(rest);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Snapshot `file` to a fresh `<file>.bak.<ts>` if it exists, then prune to the newest
 * `keep`. Best-effort on a MISSING source (nothing to back up — a brand-new file).
 * The copy of an EXISTING file must succeed (we never silently lose prior config);
 * only the prune is swallowed (a leftover stale backup is harmless).
 */
async function rotatingBackup(file: string, keep: number): Promise<void> {
  try {
    await stat(file);
  } catch {
    return; // no existing file -> nothing to back up
  }
  // Distinct id even on rapid successive writes: bump past any existing snapshot ts.
  let ts = Date.now();
  const existing = await listBackups(file);
  if (existing.length > 0 && existing[0]!.timestamp >= ts) {
    ts = existing[0]!.timestamp + 1;
  }
  await copyFile(file, backupPathFor(file, ts));
  await pruneBackups(file, keep);
}

/** Delete all but the newest `keep` backups of `file`. Swallows individual failures. */
async function pruneBackups(file: string, keep: number): Promise<void> {
  if (keep < 0) keep = 0;
  const all = await listBackups(file); // newest first
  for (const b of all.slice(keep)) {
    try {
      await unlink(b.path);
    } catch {
      /* a backup we couldn't delete is harmless; leave it */
    }
  }
}

/** Atomic write: temp file in the same dir, then rename over the target. */
async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

/**
 * THE safe-write primitive: validate `content` is a string, snapshot the existing file
 * to a rotating backup, then write atomically. Returns the path written.
 *
 * @param file    absolute path of the config file to write
 * @param content the new contents (must be a string)
 * @param opts.keep how many rotating backups to retain (default {@link DEFAULT_BACKUP_KEEP})
 */
export async function safeWriteFile(
  file: string,
  content: string,
  opts: { keep?: number } = {},
): Promise<string> {
  if (typeof content !== "string") {
    throw new TypeError("safeWriteFile: content must be a string");
  }
  const keep = opts.keep ?? DEFAULT_BACKUP_KEEP;
  await rotatingBackup(file, keep);
  await atomicWrite(file, content);
  return file;
}

/**
 * List the rotating backups of `file`, NEWEST first. Returns [] when the directory or
 * any backups are absent (a file never written, or written only once before rotation
 * existed). Tolerant: a missing dir / unreadable entry is treated as "no backups".
 */
export async function listBackups(file: string): Promise<BackupInfo[]> {
  const dir = path.dirname(file);
  const liveBase = path.basename(file);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const ts = parseBackupTs(liveBase, name);
    if (ts === null) continue;
    const full = path.join(dir, name);
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(full)).size;
    } catch {
      continue; // vanished between readdir and stat — skip it
    }
    out.push({ id: name, path: full, timestamp: ts, sizeBytes });
  }
  out.sort((a, b) => b.timestamp - a.timestamp); // newest first
  return out;
}

/**
 * Restore the backup identified by `backupId` over the live `file`. The restore is
 * itself a SAFE write: the current contents are snapshotted first (so a regretted
 * restore is undoable), then the chosen snapshot's bytes are written atomically.
 *
 * `backupId` MUST be one of the ids returned by {@link listBackups} for this file —
 * it's validated against that list (which also blocks path traversal, since a real
 * backup id is a plain basename in the same directory). Throws when it doesn't match.
 *
 * Returns the path that was restored (== `file`).
 */
export async function restoreBackup(
  file: string,
  backupId: string,
  opts: { keep?: number } = {},
): Promise<string> {
  if (typeof backupId !== "string" || !backupId.trim()) {
    throw new Error("restoreBackup: backupId must be a non-empty string");
  }
  const backups = await listBackups(file);
  const chosen = backups.find((b) => b.id === backupId);
  if (!chosen) {
    throw new Error(`restoreBackup: no backup '${backupId}' for ${file}`);
  }
  const data = await readFile(chosen.path, "utf8");
  // Reuse the primitive so the current state is backed up before being overwritten.
  return safeWriteFile(file, data, opts);
}
