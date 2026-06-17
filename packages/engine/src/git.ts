/**
 * Read-only git introspection for a project working directory.
 *
 *  - Runs `git` via {@link execFile} (NO shell): args are an array, so a path or
 *    branch name can never be interpreted as shell syntax.
 *  - Every method tolerates a non-git directory (or a missing `git` binary): it
 *    returns `null`/empty rather than throwing, so callers can call blindly on any
 *    project cwd.
 *  - READ-ONLY for now: status / diff / branch list / log. No mutating commands.
 */
import { execFile } from "node:child_process";

/** Working-tree status, parsed from `git status --porcelain=v1 -b`. */
export interface GitStatus {
  /** Current branch name, or null when detached / unparsable. */
  branch: string | null;
  /** Commits ahead of the upstream (0 when no upstream or unknown). */
  ahead: number;
  /** Commits behind the upstream. */
  behind: number;
  /** Paths with staged changes (index differs from HEAD). */
  staged: string[];
  /** Paths with unstaged changes (working tree differs from index). */
  unstaged: string[];
  /** Untracked paths. */
  untracked: string[];
}

/** One branch from `git branch`. */
export interface GitBranch {
  name: string;
  /** True for the currently checked-out branch. */
  current: boolean;
}

/** One commit from `git log`. */
export interface GitLogEntry {
  hash: string;
  /** Abbreviated 7-char hash for display. */
  shortHash: string;
  subject: string;
  authorName: string;
  /** Author date, ISO-8601 (strict). */
  date: string;
}

/** A unified diff for one file, or the whole working tree when `file` is null. */
export interface GitDiff {
  file: string | null;
  /** Raw unified-diff text (may be empty when there are no changes). */
  patch: string;
}

/** Max bytes of `git diff` output we buffer (a huge diff is truncated, not OOM). */
const MAX_DIFF_BUFFER = 8 * 1024 * 1024; // 8 MB
/** Default safety timeout for a single git invocation. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Run `git <args>` in `cwd` and resolve its stdout. Resolves `null` instead of
 * rejecting when git fails for ANY reason (not a repo, missing binary, non-zero
 * exit) — read-only callers treat that uniformly as "no git info here".
 */
function runGit(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Parse `git status --porcelain=v1 -b -z` output into a {@link GitStatus}.
 * Exported for unit testing of the (fiddly) porcelain format without spawning git.
 *
 * Porcelain v1 lines are `XY <path>` where X is the index (staged) state and Y the
 * worktree (unstaged) state. The leading `## ` line carries branch + ahead/behind.
 * `-z` makes entries NUL-separated (so paths with spaces/newlines are safe); a
 * rename entry is two NUL fields (`R  new\0old`), of which we keep the new path.
 */
export function parseStatus(raw: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
  };

  // Split on NUL. A trailing empty field (from the final NUL) is ignored below.
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;

    if (entry.startsWith("## ")) {
      parseBranchHeader(entry.slice(3), status);
      continue;
    }

    // Worktree entries: first two chars are the XY status, then a space, then path.
    const x = entry.charAt(0);
    const y = entry.charAt(1);
    const path = entry.slice(3);

    if (x === "?" && y === "?") {
      status.untracked.push(path);
      continue;
    }
    // A rename/copy in the index consumes the next NUL field (the old path); skip it.
    if (x === "R" || x === "C") i++;

    // X (index) tracks staged changes; Y (worktree) tracks unstaged changes.
    // " " means "clean in that column".
    if (x !== " " && x !== "?") status.staged.push(path);
    if (y !== " " && y !== "?") status.unstaged.push(path);
  }

  return status;
}

/** Parse the porcelain `-b` branch header body (the text after `## `). */
function parseBranchHeader(body: string, status: GitStatus): void {
  // Shapes:
  //   "main"
  //   "main...origin/main"
  //   "main...origin/main [ahead 1, behind 2]"
  //   "No commits yet on main"
  //   "HEAD (no branch)"
  const noCommits = body.match(/^No commits yet on (.+)$/);
  if (noCommits) {
    status.branch = noCommits[1] ?? null;
    return;
  }

  const trackIdx = body.indexOf("...");
  const localPart = trackIdx >= 0 ? body.slice(0, trackIdx) : body;
  // Strip a trailing " [ahead .., behind ..]" if there's no upstream separator.
  const bracket = localPart.indexOf(" [");
  const branch = (bracket >= 0 ? localPart.slice(0, bracket) : localPart).trim();
  status.branch = branch === "HEAD (no branch)" || branch === "" ? null : branch;

  const ahead = body.match(/ahead (\d+)/);
  const behind = body.match(/behind (\d+)/);
  if (ahead?.[1]) status.ahead = Number(ahead[1]);
  if (behind?.[1]) status.behind = Number(behind[1]);
}

/** Field separator unlikely to appear in a commit subject/author. */
const LOG_SEP = "\x1f"; // unit separator

/**
 * Read-only git operations against a single project working directory. Construct
 * one per cwd (cheap — it just stores the path). All methods are async and
 * tolerant: a non-git dir returns null/empty.
 */
export class GitService {
  constructor(private readonly cwd: string) {}

  /** True when `cwd` is inside a git work tree. */
  async isRepo(): Promise<boolean> {
    const out = await runGit(this.cwd, ["rev-parse", "--is-inside-work-tree"]);
    return out?.trim() === "true";
  }

  /** Working-tree status, or null when `cwd` is not a git repo. */
  async status(): Promise<GitStatus | null> {
    const out = await runGit(this.cwd, ["status", "--porcelain=v1", "-b", "-z"]);
    if (out === null) return null;
    return parseStatus(out);
  }

  /**
   * Unified diff. With no `file`, diffs the whole working tree (tracked changes);
   * with a `file`, diffs just that path. Returns null when not a git repo. The
   * patch is capped at {@link MAX_DIFF_BUFFER}; an over-cap diff yields null.
   */
  async diff(file?: string): Promise<GitDiff | null> {
    const args = ["diff"];
    if (file) args.push("--", file);
    const out = await runGit(this.cwd, args, MAX_DIFF_BUFFER);
    if (out === null) return null;
    return { file: file ?? null, patch: out };
  }

  /** Local branches (no remotes), or [] when not a git repo. */
  async branchList(): Promise<GitBranch[]> {
    // %(HEAD) is "*" for the current branch, " " otherwise; %(refname:short) is the name.
    const out = await runGit(this.cwd, [
      "for-each-ref",
      "--format=%(HEAD)%(refname:short)",
      "refs/heads",
    ]);
    if (out === null) return [];
    const branches: GitBranch[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const current = line.charAt(0) === "*";
      const name = line.slice(1).trim();
      if (name) branches.push({ name, current });
    }
    return branches;
  }

  /** Most-recent commits (newest first), capped at `limit`. [] when not a repo. */
  async log(limit = 20): Promise<GitLogEntry[]> {
    const n = Math.max(1, Math.min(limit, 500));
    // Custom format with a unit-separator between fields so subjects with spaces
    // parse cleanly; one record per line.
    const fmt = ["%H", "%h", "%s", "%an", "%aI"].join(LOG_SEP);
    const out = await runGit(this.cwd, [
      "log",
      `-n${n}`,
      `--pretty=format:${fmt}`,
    ]);
    if (out === null) return [];
    const entries: GitLogEntry[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split(LOG_SEP);
      if (parts.length < 5) continue;
      entries.push({
        hash: parts[0] ?? "",
        shortHash: parts[1] ?? "",
        subject: parts[2] ?? "",
        authorName: parts[3] ?? "",
        date: parts[4] ?? "",
      });
    }
    return entries;
  }
}
