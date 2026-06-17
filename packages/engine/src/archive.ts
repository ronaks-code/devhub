/**
 * Durable, compressed archive of real session transcripts.
 *
 * Claude Code auto-deletes transcripts after ~30 days. To keep deleted sessions
 * viewable in the UI, we copy each real session .jsonl into
 * `~/.claude-ui/archive/<sessionId>.jsonl.gz` (gzip-compressed) the first time we
 * see it (or when it changes).
 *
 *  - We NEVER touch the user's transcripts under ~/.claude/projects — we only READ
 *    them and WRITE a gzipped copy into our own app-data dir.
 *  - Disk-minded: gzip keeps these small, and we skip files larger than ~50MB so a
 *    giant transcript can't blow up the archive dir.
 *  - Reads stream through gunzip back into the same line objects the parser expects.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { stat, mkdir, rename, unlink } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { appDataDir } from "./paths.js";

/** Files larger than this are NOT archived (avoid bloating the archive dir). */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024; // ~50MB

/** Root dir holding `<sessionId>.jsonl.gz` files. */
export function archiveDir(): string {
  return path.join(appDataDir(), "archive");
}

/** Absolute path of the gzip archive for one session. */
export function archivePath(sessionId: string): string {
  return path.join(archiveDir(), `${sessionId}.jsonl.gz`);
}

/** True when an archive file already exists for this session. */
export async function hasArchive(sessionId: string): Promise<boolean> {
  try {
    await stat(archivePath(sessionId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy + gzip `filePath` into the archive for `sessionId`. Idempotent and safe to
 * re-call: writes to a temp file then atomically renames, so a crash mid-write can't
 * leave a half-written archive. Skips files over {@link MAX_ARCHIVE_BYTES}.
 *
 * Returns `"archived"` on success, `"skipped"` when the source is too large or
 * unreadable. Never throws on a missing/locked source — archiving is best-effort.
 */
export async function archiveSession(
  filePath: string,
  sessionId: string,
): Promise<"archived" | "skipped"> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return "skipped"; // source gone/unreadable — nothing to archive
  }
  if (size > MAX_ARCHIVE_BYTES) return "skipped";

  await mkdir(archiveDir(), { recursive: true });
  const dest = archivePath(sessionId);
  // Unique temp suffix so concurrent archives of the same id don't clobber.
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;

  try {
    await pipeline(createReadStream(filePath), createGzip(), createWriteStream(tmp));
    await rename(tmp, dest); // atomic publish
    return "archived";
  } catch {
    // Clean up the temp file on any failure; don't surface to the caller.
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    return "skipped";
  }
}

/**
 * Read an archived session back as the raw line objects the parser/index expect
 * (one parsed JSON object per non-empty line). Returns `undefined` when no archive
 * exists. Tolerant of corrupt lines (skips them), mirroring `parser.safeParse`.
 */
export async function readArchived(
  sessionId: string,
): Promise<Record<string, unknown>[] | undefined> {
  const src = archivePath(sessionId);
  try {
    await stat(src);
  } catch {
    return undefined; // no archive
  }

  const out: Record<string, unknown>[] = [];
  const gunzip = createGunzip();
  const rl = createInterface({
    input: createReadStream(src).pipe(gunzip),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const s = line.trim();
      if (!s || (s[0] !== "{" && s[0] !== "[")) continue;
      try {
        const v = JSON.parse(s);
        if (v && typeof v === "object") out.push(v as Record<string, unknown>);
      } catch {
        /* skip corrupt line */
      }
    }
  } finally {
    rl.close();
  }
  return out;
}
