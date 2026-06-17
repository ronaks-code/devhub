/**
 * Best-effort link from a session to the git commits it LIKELY produced.
 *
 * A session has a cwd and a first/last activity window. We read the project's
 * `git log` (via the read-only {@link GitService}) and keep the commits whose
 * AUTHOR DATE falls inside that window — those are the commits made while the
 * session was active, the most likely candidates for "what this session shipped".
 *
 *  - READ-ONLY: uses GitService.log (which tolerates a non-git dir → []).
 *  - HEURISTIC, not exact: a commit authored during the window is a candidate, but
 *    there's no guarantee the session authored it (another terminal could have).
 *    Hence "likely". Returns [] for a non-git cwd, a missing cwd, or no window.
 *  - The window is padded slightly so a commit made moments after the last recorded
 *    message (the very common "do work, then commit" tail) is still captured.
 */
import type { GitLogEntry, GitService } from "./git.js";
import type { SessionSummary } from "./types.js";

/** One commit linked to a session. */
export interface SessionCommit {
  /** Full 40-char commit hash. */
  hash: string;
  /** Commit subject (first line of the message). */
  subject: string;
  /** Author time, epoch milliseconds. */
  ts: number;
}

/**
 * Padding (ms) added on each side of the session window. The trailing pad matters
 * most: people typically commit just AFTER the last message of a session. 10
 * minutes is generous enough to catch that without sweeping in unrelated commits.
 */
const WINDOW_PAD_MS = 10 * 60 * 1000;

/** How many recent commits to scan from `git log`. The window filter does the rest. */
const LOG_SCAN_LIMIT = 200;

/** Parse an ISO-8601 date string to epoch ms; NaN when unparsable. */
function isoToMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/**
 * Commits authored within a session's activity window. Pure (no git access) so it's
 * unit-testable against synthetic {@link GitLogEntry}[]; {@link getSessionCommits}
 * wires it to a real repo. `firstTs`/`lastTs` are the session's ISO timestamps; an
 * absent bound is treated as open (−∞ / +∞) so a single-message session still works.
 */
export function selectCommitsInWindow(
  log: GitLogEntry[],
  firstTs: string | null,
  lastTs: string | null,
): SessionCommit[] {
  const firstMs = isoToMs(firstTs);
  const lastMs = isoToMs(lastTs);
  // Nothing to anchor on — no usable window.
  if (Number.isNaN(firstMs) && Number.isNaN(lastMs)) return [];

  const lo = (Number.isNaN(firstMs) ? Number.NEGATIVE_INFINITY : firstMs) - WINDOW_PAD_MS;
  const hi = (Number.isNaN(lastMs) ? Number.POSITIVE_INFINITY : lastMs) + WINDOW_PAD_MS;

  const out: SessionCommit[] = [];
  for (const c of log) {
    const ts = isoToMs(c.date);
    if (Number.isNaN(ts)) continue;
    if (ts < lo || ts > hi) continue;
    out.push({ hash: c.hash, subject: c.subject, ts });
  }
  // Newest first (git log already is, but be explicit since the window filter ran).
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/**
 * The git commits a session LIKELY produced: commits in the session's project cwd
 * authored within its first→last activity window (padded). Best-effort — `[]` for a
 * session with no cwd, a non-git cwd, or no resolvable window.
 *
 * @param session  the session summary (provides cwd + first/last timestamps).
 * @param git      a factory the engine passes (`(cwd) => engine.git(cwd)`), so this
 *                 module never imports GitService construction directly and stays
 *                 easy to stub in tests.
 */
export async function getSessionCommits(
  session: Pick<SessionSummary, "cwd" | "firstTimestamp" | "lastTimestamp">,
  git: (cwd: string) => GitService,
): Promise<SessionCommit[]> {
  const cwd = session.cwd;
  if (!cwd) return [];
  const log = await git(cwd).log(LOG_SCAN_LIMIT);
  if (log.length === 0) return []; // non-git dir (or genuinely empty history)
  return selectCommitsInWindow(log, session.firstTimestamp, session.lastTimestamp);
}
