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
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { liveSessionsDir } from "./paths.js";
import type { RunningSession } from "./types.js";

/** A cwd belongs to an internal/plugin store, not a real coding session. */
function isInternalCwd(cwd: string): boolean {
  return cwd.includes("/.claude-mem/") || cwd.includes("claude-mem");
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
 * Read every `<pid>.json` under the live-sessions dir, parse the known fields, and
 * stamp each with a liveness check. Tolerant: a missing dir => [], and any
 * unreadable / unparseable / internal entry is skipped. Dead PIDs are FLAGGED
 * (`alive: false`, `status: "dead"`) unless `dropDead` is set, in which case they
 * are omitted entirely. Sorted by `updatedAt` (most recently active first).
 */
export async function listRunningSessions(
  opts: { dropDead?: boolean } = {},
): Promise<RunningSession[]> {
  const dir = liveSessionsDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no sessions dir yet
  }

  const out: RunningSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    } catch {
      continue; // skip unreadable / unparseable files
    }
    if (!raw || typeof raw !== "object") continue;
    const cwd = typeof raw.cwd === "string" ? raw.cwd : null;
    if (cwd && isInternalCwd(cwd)) continue; // drop claude-mem etc.

    const pid = typeof raw.pid === "number" ? raw.pid : 0;
    const alive = isPidAlive(pid);
    if (!alive && opts.dropDead) continue; // caller wants stale entries gone

    // A dead PID overrides whatever stale status the file claims; a live one keeps
    // the process-reported status (busy/idle/waiting/...).
    const fileStatus = typeof raw.status === "string" ? raw.status : "unknown";
    out.push({
      pid,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
      cwd,
      status: alive ? fileStatus : "dead",
      alive,
      model: typeof raw.model === "string" ? raw.model : null,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
      name: typeof raw.name === "string" ? raw.name : null,
      entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : null,
    });
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out;
}
