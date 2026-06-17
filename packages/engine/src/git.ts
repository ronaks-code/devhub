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

/** One worktree from `git worktree list --porcelain`. */
export interface GitWorktree {
  /** Absolute path of the worktree's root directory. */
  path: string;
  /** Checked-out branch (short name), or null when detached / bare. */
  branch: string | null;
  /** Full HEAD commit hash, or null for a bare repo (no HEAD). */
  head: string | null;
  /** True when the worktree is locked (`git worktree lock`). */
  locked: boolean;
  /** True for the MAIN worktree (the first entry git lists — the repo's own dir). */
  isMain: boolean;
}

/**
 * Result of a mutating git op (stage/unstage/commit/branch/checkout). Unlike the
 * read-only ops (which return null on any failure), writes report success/failure
 * explicitly so a face can surface *why* it failed (e.g. "not a git repo",
 * "nothing to commit", a merge conflict) instead of silently no-op-ing.
 */
export interface GitWriteResult {
  ok: boolean;
  /** Trimmed stdout from git (may be empty). */
  stdout: string;
  /** Trimmed stderr / error message when `ok` is false; empty on success. */
  error: string;
}

/** {@link GitWriteResult} plus the resolved commit hash (null when no commit was made). */
export interface GitCommitResult extends GitWriteResult {
  /** Full 40-char HEAD hash after the commit, or null when the commit didn't happen. */
  hash: string | null;
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
 * Run a MUTATING `git <args>` in `cwd`, capturing both streams and the exit status.
 * Resolves a {@link GitWriteResult} (never rejects): `ok:false` with the stderr (or
 * error message) on any failure — not a repo, missing binary, non-zero exit — so
 * callers get a typed failure instead of an exception. Args are an array (no shell),
 * so a path/branch/message can't be interpreted as shell syntax.
 */
function runGitWrite(cwd: string, args: string[]): Promise<GitWriteResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (stdout ?? "").trim();
        if (err) {
          const msg = (stderr ?? "").trim() || err.message.trim();
          resolve({ ok: false, stdout: out, error: msg });
          return;
        }
        resolve({ ok: true, stdout: out, error: "" });
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

/**
 * Parse `git worktree list --porcelain` output into {@link GitWorktree}[]. Exported
 * for unit testing of the porcelain format without spawning git.
 *
 * The porcelain format is a NEWLINE-separated list of attribute lines, with a BLANK
 * line between worktrees. The first attribute of each block is always `worktree
 * <abs-path>`; then optional `HEAD <sha>`, `branch refs/heads/<name>`, `detached`,
 * `bare`, and `locked [<reason>]`. The FIRST block git emits is the main worktree.
 */
export function parseWorktrees(raw: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  // Flush the in-progress block (if any) into `out`.
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };

  for (const line of raw.split("\n")) {
    if (line === "") {
      // Blank line ends a worktree block.
      flush();
      continue;
    }
    // Each line is "<key>" or "<key> <value>".
    const sp = line.indexOf(" ");
    const key = sp >= 0 ? line.slice(0, sp) : line;
    const value = sp >= 0 ? line.slice(sp + 1) : "";

    if (key === "worktree") {
      // A new block starts; flush any prior one that wasn't blank-terminated.
      flush();
      cur = {
        path: value,
        branch: null,
        head: null,
        locked: false,
        // The first worktree git lists is the main one.
        isMain: out.length === 0,
      };
      continue;
    }
    if (!cur) continue; // attribute before any `worktree` line — ignore defensively
    if (key === "HEAD") {
      cur.head = value || null;
    } else if (key === "branch") {
      // "refs/heads/<name>" -> "<name>"; keep anything unexpected verbatim.
      cur.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    } else if (key === "detached") {
      cur.branch = null;
    } else if (key === "locked") {
      cur.locked = true;
    }
    // `bare` carries no fields we surface; HEAD/branch simply stay null for it.
  }
  flush(); // last block may not be blank-terminated
  return out;
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

  // -- Writes ----------------------------------------------------------------
  //
  // These MUTATE the project repo (index/branches/commits). They never touch a
  // transcript and never run a shell. Each guards a non-git dir up front and
  // returns a typed result (ok/false + error) rather than throwing. A path or
  // branch/message is passed as an execFile arg, so it can't be shell-injected;
  // `--` separates user paths from flags so a file named `-x` isn't read as one.

  /** Verify `cwd` is a git repo; returns a failed result when it isn't. */
  private async repoGuard(): Promise<GitWriteResult | null> {
    if (await this.isRepo()) return null;
    return { ok: false, stdout: "", error: "not a git repository" };
  }

  /**
   * Stage `files` (relative to the repo). `--` ends option parsing so a path that
   * looks like a flag is still treated as a path. No-op success when `files` is
   * empty. Returns a failed result for a non-git dir.
   */
  async stage(files: string[]): Promise<GitWriteResult> {
    const guard = await this.repoGuard();
    if (guard) return guard;
    if (files.length === 0) return { ok: true, stdout: "", error: "" };
    return runGitWrite(this.cwd, ["add", "--", ...files]);
  }

  /**
   * Unstage `files` (remove from the index, keep working-tree changes) via
   * `git reset -- <files>`. Chosen over `git restore --staged` because it also works
   * before the first commit (no HEAD yet): an unstaged file simply reverts to
   * untracked. No-op success when `files` is empty. Returns a failed result for a
   * non-git dir.
   */
  async unstage(files: string[]): Promise<GitWriteResult> {
    const guard = await this.repoGuard();
    if (guard) return guard;
    if (files.length === 0) return { ok: true, stdout: "", error: "" };
    return runGitWrite(this.cwd, ["reset", "-q", "--", ...files]);
  }

  /**
   * Commit the staged changes with `message`. With `{ all: true }`, also stages all
   * tracked modifications first (`git commit -a`). Returns a {@link GitCommitResult}
   * carrying the new HEAD hash on success (null on failure, e.g. nothing staged).
   */
  async commit(message: string, opts: { all?: boolean } = {}): Promise<GitCommitResult> {
    const guard = await this.repoGuard();
    if (guard) return { ...guard, hash: null };
    const args = ["commit"];
    if (opts.all) args.push("-a");
    // `-m` + a separate arg keeps the message a single literal (newlines, quotes,
    // and leading dashes are all safe — no shell, and -m consumes the next arg).
    args.push("-m", message);
    const res = await runGitWrite(this.cwd, args);
    if (!res.ok) return { ...res, hash: null };
    const head = await runGit(this.cwd, ["rev-parse", "HEAD"]);
    return { ...res, hash: head ? head.trim() : null };
  }

  /**
   * Create branch `name` at HEAD WITHOUT switching to it (`git branch <name>`).
   * Returns a failed result for a non-git dir or a name that already exists/invalid.
   */
  async createBranch(name: string): Promise<GitWriteResult> {
    const guard = await this.repoGuard();
    if (guard) return guard;
    return runGitWrite(this.cwd, ["branch", "--", name]);
  }

  /**
   * Check out an EXISTING branch `name` (`git checkout <name>`). Fails (typed) when
   * the branch doesn't exist or the working tree would be overwritten; returns a
   * failed result for a non-git dir.
   */
  async checkoutBranch(name: string): Promise<GitWriteResult> {
    const guard = await this.repoGuard();
    if (guard) return guard;
    return runGitWrite(this.cwd, ["checkout", name]);
  }

  // -- Worktrees -------------------------------------------------------------
  //
  // List/add/remove linked worktrees. Listing is read-only (tolerant: [] on a
  // non-git dir). add/remove MUTATE the repo's worktree set but never a transcript;
  // paths are execFile args (no shell) and `--` ends option parsing so a path that
  // looks like a flag is still treated as a path.

  /** Linked worktrees (main first), or [] when `cwd` is not a git repo. */
  async listWorktrees(): Promise<GitWorktree[]> {
    const out = await runGit(this.cwd, ["worktree", "list", "--porcelain"]);
    if (out === null) return [];
    return parseWorktrees(out);
  }

  /**
   * Add a worktree at `wtPath`. With `{ newBranch }` creates that branch (`-b`); with
   * `{ branch }` checks out an existing branch there; with neither, git checks out a
   * detached HEAD at the current commit. Returns a typed result (failed for a non-git
   * dir, an existing path, or a branch already checked out elsewhere).
   */
  async addWorktree(
    wtPath: string,
    opts: { branch?: string; newBranch?: string } = {},
  ): Promise<GitWriteResult> {
    const guard = await this.repoGuard();
    if (guard) return guard;
    const args = ["worktree", "add"];
    // `-b <new>` must precede the path; an existing branch is a positional after it.
    if (opts.newBranch) args.push("-b", opts.newBranch);
    args.push("--", wtPath);
    if (!opts.newBranch && opts.branch) args.push(opts.branch);
    return runGitWrite(this.cwd, args);
  }

  /**
   * Remove the worktree at `wtPath` (`git worktree remove`). Fails (typed) when the
   * worktree has uncommitted changes unless `{ force: true }`; returns a failed result
   * for a non-git dir.
   */
  async removeWorktree(wtPath: string, opts: { force?: boolean } = {}): Promise<GitWriteResult> {
    const guard = await this.repoGuard();
    if (guard) return guard;
    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push("--", wtPath);
    return runGitWrite(this.cwd, args);
  }
}
