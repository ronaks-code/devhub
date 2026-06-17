/**
 * Currently-running Claude processes, read from ~/.claude/sessions/<pid>.json.
 *
 * Extracted out of index.ts so the disk read + liveness check live in one focused,
 * testable module. `Engine.getRunningSessions()` delegates here.
 *
 * Claude Code writes one ephemeral JSON per live process; it does NOT always clean
 * up on crash/SIGKILL, so the directory accumulates stale/zombie entries pointing
 * at PIDs that are long gone. We probe each PID with `process.kill(pid, 0)` (sends
 * no signal — just an existence/permission check) and FLAG dead processes with
 * `alive: false` and `status: "dead"` so faces can grey them out or drop them,
 * rather than presenting a stale file as a running session.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { liveSessionsDir } from "./paths.js";
import type { RunningSession } from "./types.js";

/**
 * Default staleness threshold (ms) after which a `status: "waiting"` session is
 * treated as "needs you": it's been blocked on a prompt long enough that it clearly
 * isn't going to clear on its own. 60s balances "a momentary pause" against "stuck".
 */
export const DEFAULT_NEEDS_YOU_MS = 60_000;

/** A cwd belongs to an internal/plugin store, not a real coding session. */
function isInternalCwd(cwd: string): boolean {
  return cwd.includes("/.claude-mem/") || cwd.includes("claude-mem");
}

/**
 * Is a session blocked on the user? True when it's alive, `status: "waiting"`, and
 * its status last changed longer than `thresholdMs` ago (so it's been stuck, not
 * just briefly paused). A waiting session with no `statusUpdatedAt` is treated as
 * needing-you immediately (we can't prove it's recent, so surface it).
 */
function computeNeedsYou(
  alive: boolean,
  status: string,
  statusUpdatedAt: number | null,
  thresholdMs: number,
  now: number,
): boolean {
  if (!alive || status !== "waiting") return false;
  if (statusUpdatedAt === null) return true; // unknown age -> surface it
  return now - statusUpdatedAt >= thresholdMs;
}

/**
 * Is the process with this PID still alive?
 *
 * `process.kill(pid, 0)` sends signal 0 — a no-op that only performs the kernel's
 * permission/existence check:
 *  - succeeds            -> the process exists (alive).
 *  - throws ESRCH        -> no such process (dead/zombie file).
 *  - throws EPERM        -> the process exists but we can't signal it (alive, owned
 *                           by another user). We treat EPERM as ALIVE — it proves
 *                           the PID is in use.
 *  - non-positive PID    -> never a real live session (0 is our "unknown" sentinel).
 * Any other error is treated as alive (fail-open) so a transient quirk never hides
 * a genuinely-running session.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false; // no such process
    if (code === "EPERM") return true; // exists, just not ours to signal
    return true; // unknown error: fail open, don't hide a real session
  }
}

/**
 * The STATIC fields parsed out of one `<pid>.json` — everything that doesn't depend
 * on the wall clock or a live PID probe. This is exactly the slice we can safely
 * cache across calls (the file's bytes don't change unless its mtime does), leaving
 * the volatile bits (`alive`, `status` override, `needsYou`) to be recomputed every
 * call. `null` marks a file we read but deliberately skip (unparseable / internal),
 * so the cache remembers the skip and doesn't re-read it until its mtime changes.
 */
interface ParsedSession {
  pid: number;
  sessionId: string;
  cwd: string | null;
  fileStatus: string;
  model: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  name: string | null;
  entrypoint: string | null;
  waitingFor: string | null;
  statusUpdatedAt: number | null;
}

/** One cached `<pid>.json`: its mtime (the gate) + the parsed static fields (or null skip). */
interface CacheEntry {
  mtimeMs: number;
  parsed: ParsedSession | null;
}

/**
 * Per-directory parse cache, gated on file mtimes. The notifications poll + LiveOps
 * poll both call {@link listRunningSessions} on a short interval, and the session
 * files rarely change between polls — re-reading + re-parsing every `<pid>.json`
 * each time is wasted FS work. We keep the last parse keyed by file path and only
 * re-read a file whose mtime moved (or that we haven't seen). Liveness is NEVER
 * cached (a PID can die without touching the file), so it's re-probed every call.
 *
 * Keyed by the sessions DIR so a test that flips `CLAUDE_CONFIG_DIR` gets its own
 * cache slot and never sees another dir's entries.
 */
const parseCache = new Map<string, Map<string, CacheEntry>>();

/** Parse the raw JSON bytes of a `<pid>.json` into static fields, or null to skip. */
function parseStaticFields(text: string): ParsedSession | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return null; // unparseable
  }
  if (!raw || typeof raw !== "object") return null;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : null;
  if (cwd && isInternalCwd(cwd)) return null; // drop claude-mem etc.
  return {
    pid: typeof raw.pid === "number" ? raw.pid : 0,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
    cwd,
    fileStatus: typeof raw.status === "string" ? raw.status : "unknown",
    model: typeof raw.model === "string" ? raw.model : null,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
    name: typeof raw.name === "string" ? raw.name : null,
    entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : null,
    waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : null,
    statusUpdatedAt: typeof raw.statusUpdatedAt === "number" ? raw.statusUpdatedAt : null,
  };
}

/**
 * Get the parsed static fields for `<dir>/<name>`, reading from disk only when the
 * file's mtime moved since we last cached it (an mtime-gate). Returns null for a
 * file we read-and-skipped (unparseable / internal) — that skip is cached too, so a
 * junk file isn't re-read on every poll. A read failure evicts any stale entry and
 * returns null (the file vanished between readdir and stat).
 */
async function parseCached(
  cache: Map<string, CacheEntry>,
  dir: string,
  name: string,
): Promise<ParsedSession | null> {
  const file = path.join(dir, name);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    cache.delete(name);
    return null;
  }
  const hit = cache.get(name);
  if (hit && hit.mtimeMs === mtimeMs) return hit.parsed; // unchanged -> reuse parse

  let parsed: ParsedSession | null;
  try {
    parsed = parseStaticFields(await readFile(file, "utf8"));
  } catch {
    cache.delete(name);
    return null; // unreadable (raced with deletion)
  }
  cache.set(name, { mtimeMs, parsed });
  return parsed;
}

/**
 * Read every `<pid>.json` under the live-sessions dir, parse the known fields, and
 * stamp each with a liveness check. Tolerant: a missing dir => [], and any
 * unreadable / unparseable / internal entry is skipped. Dead PIDs are FLAGGED
 * (`alive: false`, `status: "dead"`) unless `dropDead` is set, in which case they
 * are omitted entirely. Sorted by `updatedAt` (most recently active first).
 *
 * The per-file JSON parse is CACHED behind an mtime-gate (see {@link parseCached}):
 * unchanged files are not re-read between the frequent notification / LiveOps polls.
 * Liveness + the `needsYou` clock are recomputed every call, so the cache never hides
 * a process that just died or a wait that just went stale.
 */
export async function listRunningSessions(
  opts: {
    dropDead?: boolean;
    /** Staleness threshold (ms) for the `needsYou` flag; defaults to {@link DEFAULT_NEEDS_YOU_MS}. */
    needsYouThresholdMs?: number;
    /** When true, sort sessions that need the user FIRST (then by `updatedAt`). */
    needsYouFirst?: boolean;
  } = {},
): Promise<RunningSession[]> {
  const dir = liveSessionsDir();
  const thresholdMs = opts.needsYouThresholdMs ?? DEFAULT_NEEDS_YOU_MS;
  const now = Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    parseCache.delete(dir); // dir gone -> drop its cache so a recreated dir re-reads
    return []; // no sessions dir yet
  }

  let cache = parseCache.get(dir);
  if (!cache) {
    cache = new Map<string, CacheEntry>();
    parseCache.set(dir, cache);
  }
  // Evict cache entries for files that no longer exist (a session that exited and
  // cleaned up its `<pid>.json`), so the cache can't grow unbounded over a long run.
  const present = new Set(names);
  for (const key of cache.keys()) {
    if (!present.has(key)) cache.delete(key);
  }

  const out: RunningSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = await parseCached(cache, dir, name);
    if (parsed === null) continue; // skipped (unreadable / unparseable / internal)

    const alive = isPidAlive(parsed.pid);
    if (!alive && opts.dropDead) continue; // caller wants stale entries gone

    // A dead PID overrides whatever stale status the file claims; a live one keeps
    // the process-reported status (busy/idle/waiting/...).
    const status = alive ? parsed.fileStatus : "dead";
    out.push({
      pid: parsed.pid,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      status,
      alive,
      model: parsed.model,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      name: parsed.name,
      entrypoint: parsed.entrypoint,
      // What a waiting session is blocked on + when its status last changed, so the
      // dashboard can surface *why* a session is paused and how stale that is.
      waitingFor: parsed.waitingFor,
      statusUpdatedAt: parsed.statusUpdatedAt,
      // Blocked-on-the-user detection: a waiting session stale past the threshold.
      needsYou: computeNeedsYou(alive, status, parsed.statusUpdatedAt, thresholdMs, now),
    });
  }
  // Default order: most recently active first. With `needsYouFirst`, float the
  // stuck/waiting-on-user sessions to the top (still tie-broken by recency).
  if (opts.needsYouFirst) {
    out.sort((a, b) => {
      const an = a.needsYou ? 1 : 0;
      const bn = b.needsYou ? 1 : 0;
      if (an !== bn) return bn - an; // needs-you first
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
  } else {
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  return out;
}

/**
 * Drop the mtime-gated parse cache (all dirs, or just one sessions dir). Mainly for
 * tests that rewrite a `<pid>.json` IN PLACE within the same millisecond — where the
 * mtime may not advance — so they can force a fresh read. Production code never needs
 * this: real session writes always move the mtime.
 */
export function clearRunningSessionsCache(dir?: string): void {
  if (dir) parseCache.delete(dir);
  else parseCache.clear();
}
