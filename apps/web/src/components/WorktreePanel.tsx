import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  FolderTree,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { api, NotImplementedError } from "../lib/api";
import type { Worktree } from "../lib/types";
import { cn } from "../lib/utils";
import { Spinner } from "./ui";

const inputCls =
  "w-full rounded-md bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40";

/** The "create worktree" mini-form. Collapsed by default; the panel toggles it. */
function CreateForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (path: string, branch: string, newBranch: boolean) => void;
}) {
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const p = path.trim();
    const b = branch.trim();
    if (!p) return setError("A worktree path is required.");
    if (!b) return setError("A branch is required.");
    setError(null);
    onSubmit(p, b, newBranch);
  };

  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
      <input
        autoFocus
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="Path (e.g. ../myrepo-feature)"
        className={inputCls}
      />
      <div className="flex items-center gap-1.5">
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Branch"
          className={inputCls}
        />
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-400" title="Create the branch as part of the add (git worktree add -b)">
          <input
            type="checkbox"
            checked={newBranch}
            onChange={(e) => setNewBranch(e.target.checked)}
            className="accent-clay-500"
          />
          new
        </label>
      </div>
      {error ? (
        <div className="flex items-center gap-1 text-[11px] text-red-400">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-1.5">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-clay-500 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-clay-600 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Add worktree
        </button>
      </div>
    </div>
  );
}

/** One worktree row with a two-step (confirm) remove. The main worktree can't be removed. */
function WorktreeRow({
  wt,
  busy,
  forceHint,
  onRemove,
}: {
  wt: Worktree;
  busy: boolean;
  /** True when a prior plain remove of THIS worktree failed — escalate to force. */
  forceHint: boolean;
  onRemove: (wt: Worktree, force: boolean) => void;
}) {
  // null = idle; "confirm" = first click (asks); "force" = offer a forced remove.
  const [confirm, setConfirm] = useState<null | "confirm" | "force">(null);
  // A failed plain remove (e.g. uncommitted changes) escalates the open confirm
  // strip to a forced remove, so the second click can carry --force.
  useEffect(() => {
    if (forceHint) setConfirm((c) => (c == null ? c : "force"));
  }, [forceHint]);
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-zinc-800/80 bg-zinc-900/30 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <FolderTree className="h-3 w-3 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-300" title={wt.path}>
          {wt.path}
        </span>
        {wt.branch ? (
          <span className="shrink-0 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium text-clay-300">
            {wt.branch}
          </span>
        ) : (
          <span className="shrink-0 text-[10px] italic text-zinc-600">detached</span>
        )}
        {wt.isMain ? (
          <span className="shrink-0 text-[10px] text-zinc-600">main</span>
        ) : confirm == null ? (
          <button
            onClick={() => setConfirm("confirm")}
            disabled={busy}
            title="Remove worktree"
            className="shrink-0 rounded p-0.5 text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      {/* Confirm strip — only for non-main worktrees once the trash icon is hit. */}
      {!wt.isMain && confirm != null ? (
        <div className="flex items-center gap-1.5 rounded bg-red-500/5 px-1.5 py-1 ring-1 ring-red-500/20">
          <span className="flex-1 text-[10.5px] text-red-300">
            {confirm === "force"
              ? "Has changes — remove anyway?"
              : "Remove this worktree?"}
          </span>
          <button
            onClick={() => onRemove(wt, confirm === "force")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-red-200 ring-1 ring-red-500/30 transition hover:bg-red-500/25 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            {confirm === "force" ? "Force remove" : "Remove"}
          </button>
          <button
            onClick={() => setConfirm(null)}
            disabled={busy}
            className="rounded p-0.5 text-zinc-400 transition hover:text-zinc-200 disabled:opacity-50"
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * List / create / remove git worktrees for a project working directory, backed
 * by the /api/git/worktree(s) endpoints. Surfaced inside the GitPanel. Removes
 * are two-step (confirm), and a failed plain remove (uncommitted changes)
 * escalates the confirm to an explicit "force remove".
 *
 * The endpoints are wired here ahead of the engine/server lane that implements
 * them. Until they ship, the API maps 404/501 to NotImplementedError and this
 * panel shows a quiet "not available yet" line instead of erroring — so the
 * GitPanel keeps working unchanged.
 */
export function WorktreePanel({ cwd }: { cwd: string }) {
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  // Path of the row whose plain remove failed (likely uncommitted changes), so
  // that row escalates its confirm strip to an explicit "force remove".
  const [forceHintPath, setForceHintPath] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    setError(null);
    api
      .gitWorktrees(cwd)
      .then((w) => {
        if (cancelled) return;
        setWorktrees(w);
        setUnavailable(false);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof NotImplementedError) {
          setUnavailable(true);
          setWorktrees([]);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => refresh(), [refresh]);

  const add = (path: string, branch: string, newBranch: boolean) => {
    setBusy(true);
    setError(null);
    api
      .gitWorktreeAdd(cwd, path, branch, newBranch)
      .then(() => {
        setCreating(false);
        refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const remove = (wt: Worktree, force: boolean) => {
    setBusy(true);
    setError(null);
    api
      .gitWorktreeRemove(cwd, wt.path, force)
      .then(() => {
        setForceHintPath(null);
        refresh();
      })
      .catch((e) => {
        // A non-forced remove that fails is almost always "has changes" — surface
        // the reason and flag the row so its confirm escalates to "force remove".
        if (!force) setForceHintPath(wt.path);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  };

  if (worktrees === null && !error) {
    return (
      <div className="flex items-center gap-2 py-2 text-[11px] text-zinc-600">
        <Spinner className="h-3 w-3" /> Reading worktrees…
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="py-1.5 text-[11px] text-zinc-600">
        Worktrees aren't available on this server yet.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-zinc-600">
        <FolderTree className="h-3 w-3" />
        Worktrees
        <button
          onClick={() => setCreating((v) => !v)}
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium normal-case tracking-normal transition",
            creating
              ? "bg-clay-500/20 text-clay-100"
              : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
          )}
          title="Add a worktree"
        >
          <Plus className="h-3 w-3" />
          New
        </button>
      </div>

      {worktrees && worktrees.length > 0 ? (
        <div className="space-y-1">
          {worktrees.map((wt) => (
            <WorktreeRow
              key={wt.path}
              wt={wt}
              busy={busy}
              forceHint={forceHintPath === wt.path}
              onRemove={remove}
            />
          ))}
        </div>
      ) : !creating ? (
        <div className="text-[11px] text-zinc-600">No worktrees.</div>
      ) : null}

      {creating ? (
        <CreateForm busy={busy} onCancel={() => setCreating(false)} onSubmit={add} />
      ) : null}

      {error ? (
        <div className="flex items-start gap-1 text-[11px] text-red-400">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
