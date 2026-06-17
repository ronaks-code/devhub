import { useEffect, useState } from "react";
import {
  GitBranch,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  GitCommitHorizontal,
  Plus,
  Pencil,
  FileQuestion,
} from "lucide-react";
import { api } from "../lib/api";
import type { GitLogEntry, GitStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { relativeTime } from "../lib/format";
import { Spinner } from "./ui";

/** A compact count chip with an icon — only rendered when n > 0. */
function CountChip({
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
      title={`${n} ${label}`}
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

/**
 * A collapsible, read-only git panel for a project working directory. Shows the
 * current branch, ahead/behind counts, staged/unstaged/untracked totals, and the
 * most recent commits. Degrades gracefully when `cwd` is not a git repo.
 *
 * Data is fetched on expand (and when `cwd` changes while open) so a non-git
 * project — or a slow `git` — never blocks the rest of the Browse view.
 */
export function GitPanel({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  // null = not fetched yet; "repo" / "no-repo" / "error" once we know.
  const [state, setState] = useState<"idle" | "repo" | "no-repo" | "error">("idle");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.gitStatus(cwd), api.gitLog(cwd, 10)])
      .then(([s, l]) => {
        if (cancelled) return;
        setStatus(s);
        setLog(l);
        // A null status means "not a git repo"; an empty log alone doesn't (a
        // fresh repo has no commits yet but is still a repo).
        setState(s === null ? "no-repo" : "repo");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  // A new project resets what we know so the next expand refetches fresh.
  useEffect(() => {
    setStatus(null);
    setLog([]);
    setState("idle");
  }, [cwd]);

  const dirty =
    status != null &&
    (status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0);

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-900/20">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-5 py-2 text-left text-[12px] text-zinc-400 transition hover:bg-zinc-900/40 hover:text-zinc-200"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-clay-400" />
        <span className="font-medium text-zinc-300">Git</span>
        {/* Summary chips visible even while collapsed, once we know the state. */}
        {state === "repo" && status ? (
          <span className="flex items-center gap-1.5">
            {status.branch ? (
              <span className="truncate font-mono text-[11px] text-zinc-400">
                {status.branch}
              </span>
            ) : null}
            <CountChip
              icon={<ArrowUp className="h-3 w-3" />}
              n={status.ahead}
              label="ahead"
              className="text-emerald-300"
            />
            <CountChip
              icon={<ArrowDown className="h-3 w-3" />}
              n={status.behind}
              label="behind"
              className="text-amber-300"
            />
            {!dirty ? <span className="text-[10.5px] text-zinc-600">clean</span> : null}
          </span>
        ) : state === "no-repo" ? (
          <span className="text-[10.5px] text-zinc-600">not a git repo</span>
        ) : null}
        {loading ? <Spinner className="ml-auto h-3 w-3" /> : null}
      </button>

      {open && (
        <div className="px-5 pb-3 pt-1">
          {state === "no-repo" ? (
            <div className="py-2 text-[11.5px] text-zinc-600">
              This project's working directory is not a git repository.
            </div>
          ) : state === "error" ? (
            <div className="py-2 text-[11.5px] text-red-400">Could not read git status.</div>
          ) : state === "repo" && status ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 py-1">
                <CountChip
                  icon={<Plus className="h-3 w-3" />}
                  n={status.staged.length}
                  label="staged"
                  className="text-emerald-300"
                />
                <CountChip
                  icon={<Pencil className="h-3 w-3" />}
                  n={status.unstaged.length}
                  label="unstaged"
                  className="text-amber-300"
                />
                <CountChip
                  icon={<FileQuestion className="h-3 w-3" />}
                  n={status.untracked.length}
                  label="untracked"
                  className="text-zinc-400"
                />
                {!dirty ? (
                  <span className="text-[11px] text-zinc-600">Working tree clean</span>
                ) : null}
              </div>

              {log.length > 0 ? (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-zinc-600">
                    <GitCommitHorizontal className="h-3 w-3" />
                    Recent commits
                  </div>
                  {log.map((c) => (
                    <div key={c.hash} className="flex items-baseline gap-2 text-[11.5px]">
                      <code className="shrink-0 font-mono text-[10.5px] text-clay-300">
                        {c.shortHash}
                      </code>
                      <span className="min-w-0 flex-1 truncate text-zinc-300" title={c.subject}>
                        {c.subject}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-zinc-600">
                        {relativeTime(c.date)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-zinc-600">No commits yet.</div>
              )}
            </>
          ) : (
            // idle + loading first paint
            <div className="py-2 text-[11px] text-zinc-600">Reading git status…</div>
          )}
        </div>
      )}
    </div>
  );
}
