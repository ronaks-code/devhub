import { useEffect, useState } from "react";
import { CheckCircle2, FileQuestion, GitBranch, Pencil, Plus } from "lucide-react";
import type { GitStatus, ProjectSummary } from "../../lib/types";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

/** One project with a dirty working tree + its change counts (for sort + display). */
interface DirtyRow {
  project: ProjectSummary;
  status: GitStatus;
  /** staged + unstaged + untracked — the headline "how dirty" number. */
  changed: number;
}

/** How many git-status calls to run at once, so N projects don't fire N requests. */
const CONCURRENCY = 4;

/** Count of staged + unstaged + untracked paths in a status. */
function changeCount(s: GitStatus): number {
  return s.staged.length + s.unstaged.length + s.untracked.length;
}

/**
 * Run `task` over `items` with at most `limit` in flight at once. Resolves to the
 * results in input order; a rejected task yields `null` for that slot (so one bad
 * project doesn't sink the batch). A tiny worker-pool — no dependency needed.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await task(items[i]!);
      } catch {
        results[i] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** A compact count chip with an icon — only rendered when n > 0. Mirrors GitPanel. */
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
 * Dashboard widget: projects with uncommitted git changes ("dirty" working trees),
 * most-changed first. Click a row to open that project in the Browse view.
 *
 * Plain words: a quick "where did I leave unsaved git work?" list across all your
 * projects, so nothing slips through the cracks.
 *
 * Self-loads the project list, then queries each project's git status with capped
 * concurrency (so 16 projects don't fire 16 simultaneous calls). It's resilient:
 * projects that aren't git repos return a null status and are skipped, and a failed
 * status query is silently dropped. Shows a loading state and an "all clean" empty
 * state. Cost + counts come straight off the read-only /api/git/status route.
 */
export function DirtyRepos({
  onOpenProject,
}: {
  /** Open a project in the Browse view by its id. From the Dashboard host. */
  onOpenProject?: (projectId: string) => void;
}) {
  // null = still loading; [] = loaded with nothing dirty (all clean).
  const [rows, setRows] = useState<DirtyRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then(async (projects) => {
        // Only consider projects with a known working directory (the status route
        // is allowlisted by cwd). Skip archived projects — clutter, not action.
        const candidates = projects.filter((p) => p.cwd && !p.archived);
        const statuses = await mapLimit(candidates, CONCURRENCY, (p) =>
          api.gitStatus(p.cwd),
        );
        if (cancelled) return;
        const dirty: DirtyRow[] = [];
        candidates.forEach((project, i) => {
          const status = statuses[i];
          // null = not a git repo / errored → skip silently.
          if (!status) return;
          const changed = changeCount(status);
          if (changed > 0) dirty.push({ project, status, changed });
        });
        dirty.sort((a, b) => b.changed - a.changed);
        setRows(dirty);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
        Repository status isn't available on this server yet.
      </div>
    );
  }
  if (rows === null) {
    return (
      <div className="flex h-24 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/30">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-[12px] text-zinc-500">
        <CheckCircle2 className="h-4 w-4 text-emerald-400/80" />
        All working trees are clean.
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-zinc-800/60 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
      {rows.map(({ project, status, changed }) => {
        const open = () => onOpenProject?.(project.id);
        return (
          <button
            key={project.id}
            onClick={open}
            disabled={!onOpenProject}
            className="group flex items-center gap-3 px-3.5 py-2.5 text-left transition hover:bg-zinc-800/40 disabled:cursor-default"
            title={project.cwd}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-clay-400/80" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-zinc-200 group-hover:text-zinc-100">
                {project.name}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-600">
                {status.branch ? (
                  <span className="truncate font-mono">{status.branch}</span>
                ) : null}
                <span>
                  · {changed} change{changed === 1 ? "" : "s"}
                </span>
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-1.5">
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
            </span>
          </button>
        );
      })}
    </div>
  );
}
