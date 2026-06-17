import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Clock,
  Coins,
  DollarSign,
  Folder,
  GitBranch,
  MessagesSquare,
  Star,
} from "lucide-react";
import type { ProjectSummary } from "../lib/types";
import { api } from "../lib/api";
import { compactNumber, formatUsd, relativeTime, totalTokens } from "../lib/format";
import { costUsd } from "../lib/pricing";
import { cn } from "../lib/utils";

/** One labelled stat chip in the header's metric row. */
function Stat({
  icon,
  children,
  title,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900/70 px-2 py-1 text-[11.5px] text-zinc-400 ring-1 ring-zinc-800"
    >
      <span className="text-zinc-600">{icon}</span>
      {children}
    </span>
  );
}

/**
 * A rich header for the selected project: name + cwd, the working tree's current
 * git branch, session count, total tokens and APPROXIMATE spend, last activity,
 * and favorite / archive toggles. Sits atop the Sessions pane (or the transcript
 * area) so the project's shape is visible at a glance before drilling into a chat.
 *
 * The cost is a display estimate: ProjectSummary carries only aggregate
 * `totalUsage` (no per-model split), so we price it at the fallback tier via the
 * shared `costUsd` — the same approximate basis the dashboard uses. The git
 * branch is fetched lazily from GET /api/git/status and simply omitted when the
 * cwd isn't a repo (or the route is unavailable). Toggles call PATCH
 * /api/projects/:id via `onToggleFavorite` / `onToggleArchive`, which the host
 * wires to refresh the project list.
 */
export function ProjectDetailHeader({
  project,
  onToggleFavorite,
  onToggleArchive,
  className,
}: {
  project: ProjectSummary;
  /** Persist the favorite flag (PATCH /api/projects/:id { favorite }). */
  onToggleFavorite?: (id: string, favorite: boolean) => void | Promise<void>;
  /** Persist the archived flag (PATCH /api/projects/:id { archived }). */
  onToggleArchive?: (id: string, archived: boolean) => void | Promise<void>;
  className?: string;
}) {
  // The working tree's current branch, fetched lazily. null = unknown / not a
  // repo / route unavailable (we just hide the branch chip in that case).
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBranch(null);
    api
      .gitStatus(project.cwd)
      .then((s) => {
        if (!cancelled) setBranch(s?.branch ?? null);
      })
      .catch(() => {
        /* not a repo / route unavailable — leave the branch hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [project.cwd]);

  const tokens = totalTokens(project.totalUsage);
  // APPROXIMATE spend at the fallback pricing tier (no per-model split here).
  const cost = costUsd(null, project.totalUsage);

  return (
    <div className={cn("border-b border-zinc-800/80 bg-zinc-950 px-5 py-3", className)}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-clay-500/10 p-1.5 text-clay-400 ring-1 ring-clay-500/20">
          <Folder className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[15px] font-semibold text-zinc-100">{project.name}</h1>
            {project.favorite ? (
              <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
            ) : null}
            {project.archived ? (
              <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                archived
              </span>
            ) : null}
          </div>
          <div className="truncate text-[11px] text-zinc-600" title={project.cwd} dir="rtl">
            {project.cwd}
          </div>
        </div>

        {/* Favorite + archive toggles — only shown when the host wired a handler. */}
        <div className="flex shrink-0 items-center gap-1">
          {onToggleFavorite ? (
            <button
              onClick={() => onToggleFavorite(project.id, !project.favorite)}
              className={cn(
                "inline-flex items-center justify-center rounded-lg p-1.5 ring-1 transition",
                project.favorite
                  ? "bg-amber-500/15 text-amber-300 ring-amber-500/30 hover:bg-amber-500/25"
                  : "bg-zinc-900 text-zinc-500 ring-zinc-800 hover:bg-zinc-800 hover:text-amber-300",
              )}
              title={project.favorite ? "Unfavorite project" : "Favorite project"}
              aria-pressed={project.favorite}
              aria-label={project.favorite ? "Unfavorite project" : "Favorite project"}
            >
              <Star className={cn("h-3.5 w-3.5", project.favorite && "fill-current")} />
            </button>
          ) : null}
          {onToggleArchive ? (
            <button
              onClick={() => onToggleArchive(project.id, !project.archived)}
              className={cn(
                "inline-flex items-center justify-center rounded-lg p-1.5 ring-1 transition",
                project.archived
                  ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                  : "bg-zinc-900 text-zinc-500 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
              )}
              title={project.archived ? "Unarchive project" : "Archive project"}
              aria-pressed={project.archived}
              aria-label={project.archived ? "Unarchive project" : "Archive project"}
            >
              {project.archived ? (
                <ArchiveRestore className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
        </div>
      </div>

      {/* Metric row */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {branch ? (
          <Stat icon={<GitBranch className="h-3 w-3" />} title="Current git branch">
            {branch}
          </Stat>
        ) : null}
        <Stat icon={<MessagesSquare className="h-3 w-3" />} title="Sessions in this project">
          {project.sessionCount.toLocaleString()} session{project.sessionCount === 1 ? "" : "s"}
        </Stat>
        <Stat icon={<Coins className="h-3 w-3" />} title="input + output + cache tokens">
          {compactNumber(tokens)} tok
        </Stat>
        <Stat icon={<DollarSign className="h-3 w-3" />} title="APPROXIMATE spend (display estimate)">
          {formatUsd(cost)}
        </Stat>
        <Stat icon={<Clock className="h-3 w-3" />} title="Last activity">
          {relativeTime(project.lastActivity)}
        </Stat>
      </div>
    </div>
  );
}
