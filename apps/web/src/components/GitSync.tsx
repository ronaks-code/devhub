import { useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  CloudDownload,
  CloudUpload,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { api, NotImplementedError, type GitRemoteResult } from "../lib/api";
import type { GitStatus } from "../lib/types";
import { cn } from "../lib/utils";

/** Which remote action is mid-flight (one at a time), or null when idle. */
type Action = "fetch" | "pull" | "push" | "commitPush";

/** The outcome of the last completed action, shown as a one-line result strip. */
interface Outcome {
  action: Action;
  ok: boolean;
  /** Human-readable line: git stdout on success, the error reason on failure. */
  text: string;
}

/** A compact ahead/behind chip — only rendered when n > 0. */
function SyncChip({
  icon,
  n,
  label,
  className,
}: {
  icon: React.ReactNode;
  n: number;
  label: string;
  className?: string;
}) {
  if (n <= 0) return null;
  return (
    <span
      title={`${n} commit${n === 1 ? "" : "s"} ${label}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10.5px] font-medium",
        className,
      )}
    >
      {icon}
      {n}
    </span>
  );
}

const ACTION_LABELS: Record<Action, string> = {
  fetch: "Fetch",
  pull: "Pull",
  push: "Push",
  commitPush: "Commit & Push",
};

/**
 * Remote-sync controls for a project's working tree: an ahead/behind indicator
 * (from `git status`) plus Fetch / Pull / Push / Commit-and-Push actions. Each
 * action runs one at a time, shows a spinner while in flight, and reports the
 * result (git stdout on success, the error reason on failure) in a one-line strip.
 *
 * Plain words: this is the little toolbar that tells you "you have 2 commits to
 * push, 1 to pull" and lets you sync with the remote in one click — fetch (just
 * check), pull (bring theirs down), push (send yours up), or commit-and-push
 * (save your local changes and send them up in one go).
 *
 * Lives in the GitPanel beneath the status. `onSynced` lets the panel refresh
 * its status/log after a successful remote op (so ahead/behind updates). The
 * remote routes are wired ahead of the engine/server lane that implements them;
 * until they ship, the API maps 404/501 to NotImplementedError and this control
 * shows a quiet "not available yet" line instead of erroring.
 */
export function GitSync({
  cwd,
  status,
  /** True when the working tree has staged/unstaged/untracked changes. */
  dirty,
  /** Commit the working tree (stage tracked + commit) using a message. */
  onCommitAndPush,
  /** Called after any successful remote op so the host can refresh git state. */
  onSynced,
}: {
  cwd: string;
  status: GitStatus;
  dirty: boolean;
  /**
   * Commit-and-push needs a commit message. The host owns the composer/draft, so
   * it provides the commit step; GitSync chains the push after it resolves. When
   * omitted, the "Commit & Push" button is hidden (e.g. nothing to commit).
   * Returns whether the commit succeeded — push only runs on success.
   */
  onCommitAndPush?: () => Promise<boolean>;
  onSynced?: () => void;
}) {
  // The action currently running (disables the others + shows its spinner), or
  // null when idle. Only one remote op runs at a time.
  const [busy, setBusy] = useState<Action | null>(null);
  // Result of the last finished action, shown in the strip below the buttons.
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // True once any route 404/501s — the server hasn't shipped remote ops yet.
  const [unavailable, setUnavailable] = useState(false);

  // Run one remote op, threading the busy/outcome state. `op` resolves a
  // GitRemoteResult; we surface stdout on success and the error on failure, then
  // refresh the host on success. A NotImplementedError flips to the quiet
  // "unavailable" state instead of showing a hard error.
  const run = (action: Action, op: () => Promise<GitRemoteResult>) => {
    setBusy(action);
    setOutcome(null);
    op()
      .then((res) => {
        setOutcome({
          action,
          ok: res.ok,
          text: res.ok
            ? res.stdout || "Done."
            : res.error || "The operation failed.",
        });
        if (res.ok) onSynced?.();
      })
      .catch((e) => {
        if (e instanceof NotImplementedError) {
          setUnavailable(true);
          return;
        }
        setOutcome({
          action,
          ok: false,
          text: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => setBusy(null));
  };

  // Commit-and-push: commit via the host, then push only if the commit succeeded.
  // Reported as the single "commitPush" action so the strip reads as one step.
  const commitAndPush = () => {
    if (!onCommitAndPush) return;
    setBusy("commitPush");
    setOutcome(null);
    onCommitAndPush()
      .then((committed) => {
        if (!committed) {
          // The commit didn't happen (e.g. cancelled / nothing to commit) — the
          // host surfaces its own commit error, so we just clear the busy state.
          setBusy(null);
          return;
        }
        return api
          .gitPush(cwd)
          .then((res) => {
            setOutcome({
              action: "commitPush",
              ok: res.ok,
              text: res.ok
                ? res.stdout || "Committed and pushed."
                : res.error || "Committed, but the push failed.",
            });
            if (res.ok) onSynced?.();
          })
          .catch((e) => {
            if (e instanceof NotImplementedError) {
              setUnavailable(true);
              return;
            }
            setOutcome({
              action: "commitPush",
              ok: false,
              text: e instanceof Error ? e.message : String(e),
            });
          })
          .finally(() => setBusy(null));
      })
      .catch((e) => {
        setOutcome({
          action: "commitPush",
          ok: false,
          text: e instanceof Error ? e.message : String(e),
        });
        setBusy(null);
      });
  };

  if (unavailable) {
    return (
      <div className="mt-2 py-1.5 text-[11px] text-zinc-600">
        Remote sync isn't available on this server yet.
      </div>
    );
  }

  // No remote-tracking info means no upstream; pull/push/commit-push are
  // meaningless without one, so we still allow fetch (it sets up tracking refs).
  const hasUpstream = status.ahead > 0 || status.behind > 0 || status.branch != null;

  const btn =
    "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ring-1 transition disabled:opacity-50";

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-zinc-600">
        <RefreshCw className="h-3 w-3" />
        Sync
        {/* Ahead/behind summary — how far the local branch is from its upstream. */}
        <span className="ml-1 flex items-center gap-1 normal-case tracking-normal">
          <SyncChip
            icon={<ArrowUp className="h-3 w-3" />}
            n={status.ahead}
            label="ahead (to push)"
            className="text-emerald-300"
          />
          <SyncChip
            icon={<ArrowDown className="h-3 w-3" />}
            n={status.behind}
            label="behind (to pull)"
            className="text-amber-300"
          />
          {status.ahead === 0 && status.behind === 0 ? (
            <span className="text-[10px] normal-case tracking-normal text-zinc-600">
              up to date
            </span>
          ) : null}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => run("fetch", () => api.gitFetch(cwd))}
          disabled={busy != null}
          title="Fetch remote refs (no working-tree change)"
          className={cn(
            btn,
            "bg-zinc-900 text-zinc-300 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-100",
          )}
        >
          {busy === "fetch" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Fetch
        </button>

        <button
          onClick={() => run("pull", () => api.gitPull(cwd))}
          disabled={busy != null || !hasUpstream}
          title="Pull — bring upstream commits into this branch"
          className={cn(
            btn,
            "bg-zinc-900 text-zinc-300 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-100",
            status.behind > 0 && "text-amber-200 ring-amber-500/30",
          )}
        >
          {busy === "pull" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <CloudDownload className="h-3 w-3" />
          )}
          Pull
        </button>

        <button
          onClick={() => run("push", () => api.gitPush(cwd))}
          disabled={busy != null || !hasUpstream}
          title="Push — upload your local commits to the remote"
          className={cn(
            btn,
            "bg-zinc-900 text-zinc-300 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-100",
            status.ahead > 0 && "text-emerald-200 ring-emerald-500/30",
          )}
        >
          {busy === "push" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <CloudUpload className="h-3 w-3" />
          )}
          Push
        </button>

        {/* Commit-and-Push — only when the host wired a commit step AND there's
            something to commit. Saves local changes, then pushes in one go. */}
        {onCommitAndPush && dirty ? (
          <button
            onClick={commitAndPush}
            disabled={busy != null}
            title="Commit your changes, then push them"
            className={cn(
              btn,
              "bg-clay-500/15 text-clay-200 ring-clay-500/30 hover:bg-clay-500/25",
            )}
          >
            {busy === "commitPush" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <GitCommitHorizontal className="h-3 w-3" />
            )}
            Commit &amp; Push
          </button>
        ) : null}
      </div>

      {/* Result strip — the last finished action's git output or error reason. */}
      {outcome ? (
        <div
          className={cn(
            "flex items-start gap-1.5 rounded-md px-2 py-1 text-[11px]",
            outcome.ok
              ? "bg-emerald-500/5 text-emerald-300 ring-1 ring-emerald-500/15"
              : "bg-red-500/5 text-red-300 ring-1 ring-red-500/15",
          )}
        >
          {outcome.ok ? (
            <Check className="mt-0.5 h-3 w-3 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className="font-medium">{ACTION_LABELS[outcome.action]}:</span>{" "}
            <span className="whitespace-pre-wrap break-words">{outcome.text}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
