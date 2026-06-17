import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, Loader2, Plus, X } from "lucide-react";
import { api } from "../lib/api";
import type { GitBranch as GitBranchDef } from "../lib/types";
import { cn } from "../lib/utils";
import { Spinner } from "./ui";

/**
 * A compact git-branch dropdown for the chat header. Lists the project's local
 * branches (GET /api/git/branches), switches to one (POST /api/git/branch with
 * `checkout`), and offers a "new branch" affordance that creates + checks out a
 * branch in one go (POST /api/git/branch with a fresh `name` + `checkout`).
 *
 * Read-only-degrades gracefully: a `cwd` that isn't a git repo returns [] and the
 * control hides itself entirely, so a non-repo project chat is unchanged.
 *
 * `disabled` is set while a turn runs — switching branches mid-turn would change
 * the working tree out from under the agent, so we lock it then.
 */
export function BranchSwitcher({
  cwd,
  disabled = false,
  onSwitched,
}: {
  cwd: string;
  /** Locked while a turn is in flight (don't move the tree under the agent). */
  disabled?: boolean;
  /** Notified with the new branch name after a successful switch/create. */
  onSwitched?: (branch: string) => void;
}) {
  const [branches, setBranches] = useState<GitBranchDef[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The inline "create a new branch" composer, when the user clicked "New branch".
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    let cancelled = false;
    api
      .gitBranches(cwd)
      .then((b) => {
        if (!cancelled) {
          setBranches(b);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setBranches([]); // hide on failure (not a repo / git unavailable)
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // (Re)load when the project cwd changes.
  useEffect(() => load(), [load]);

  // Close the dropdown on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the new-branch input when the composer opens.
  useEffect(() => {
    if (creating) requestAnimationFrame(() => newInputRef.current?.focus());
  }, [creating]);

  const current = branches?.find((b) => b.current) ?? null;

  // Switch to (or create + switch to) `name`. The server returns the refreshed
  // branch list, so we update from the response without a re-fetch.
  const switchTo = useCallback(
    async (name: string, isNew: boolean) => {
      const trimmed = name.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setError(null);
      try {
        const next = await api.gitBranch(cwd, trimmed, true);
        setBranches(next);
        setOpen(false);
        setCreating(false);
        setNewName("");
        onSwitched?.(trimmed);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // On a create failure, keep the composer open so the user can fix the name.
        if (!isNew) setOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [cwd, busy, onSwitched],
  );

  // Branches still loading: show a quiet placeholder so the header doesn't jump.
  if (branches === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2 py-1 text-[12px] text-zinc-600 ring-1 ring-zinc-800">
        <Spinner className="h-3 w-3" />
      </span>
    );
  }

  // Not a git repo (or git unavailable): render nothing so non-repo chats are
  // visually unchanged.
  if (branches.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy}
        className={cn(
          "inline-flex max-w-[12rem] items-center gap-1.5 rounded-lg bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 transition hover:bg-zinc-800 focus:outline-none focus:ring-clay-500/40 disabled:opacity-50",
        )}
        title={
          disabled
            ? "Branch is locked while a turn is running"
            : `On branch ${current?.name ?? "(detached)"} — click to switch`
        }
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-clay-400" />
        ) : (
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        )}
        <span className="truncate">{current?.name ?? "(detached)"}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
          <ul className="max-h-64 overflow-y-auto py-1">
            {branches.map((b) => (
              <li key={b.name}>
                <button
                  onClick={() => switchTo(b.name, false)}
                  disabled={b.current || busy}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition",
                    b.current
                      ? "text-clay-300"
                      : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                  )}
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
                  {b.current ? <Check className="h-3.5 w-3.5 shrink-0 text-clay-400" /> : null}
                </button>
              </li>
            ))}
          </ul>

          <div className="border-t border-zinc-800 p-1">
            {creating ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void switchTo(newName, true);
                }}
                className="flex items-center gap-1 px-1 py-0.5"
              >
                <input
                  ref={newInputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="new-branch-name"
                  className="min-w-0 flex-1 rounded-md bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-100 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40"
                />
                <button
                  type="submit"
                  disabled={!newName.trim() || busy}
                  title="Create and switch to this branch"
                  className="inline-flex items-center justify-center rounded-md bg-clay-500 p-1.5 text-white transition hover:bg-clay-600 disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                  }}
                  title="Cancel"
                  className="inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-clay-300"
              >
                <Plus className="h-3.5 w-3.5" />
                New branch…
              </button>
            )}
          </div>

          {error && (
            <div className="border-t border-red-900/50 px-3 py-1.5 text-[11px] text-red-400">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
