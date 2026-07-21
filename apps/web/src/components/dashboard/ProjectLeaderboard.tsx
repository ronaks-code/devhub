import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, FolderGit2 } from "lucide-react";
import type { ProjectSummary, Stats } from "../../lib/types";
import { api } from "../../lib/api";
import { compactNumber, formatUsd, relativeTime, totalTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

/** Which column the leaderboard is sorted by. */
type SortKey = "name" | "cost" | "tokens" | "sessions" | "lastActive";
type SortDir = "asc" | "desc";

/** One merged leaderboard row: project meta (projects) + spend (stats.topProjects). */
interface Row {
  projectId: string;
  name: string;
  cwd: string | null;
  cost: number;
  tokens: number;
  sessions: number;
  /** ISO of last activity (for relative display + recency sort), or null. */
  lastActivity: string | null;
}

/**
 * Merge the project list with the per-project spend from Stats.topProjects.
 *
 * `/api/projects` is the authoritative list (every project, with name/cwd/last
 * activity/session count/token usage); `Stats.topProjects` adds APPROXIMATE
 * cost, but only for the top 8 by tokens (the engine caps that array for the
 * compact dashboard glance card). Tokens and sessions do NOT need that capped
 * source at all — `ProjectSummary` already carries each project's own real,
 * uncapped `totalUsage`/`sessionCount` — so we read tokens straight off the
 * project (D4: this is what turns a real "0 tokens" join gap on ~30 rows into
 * the project's actual, non-zero token total). Cost has no such uncapped source
 * on the web side; projects outside the top 8 honestly show "—" rather than a
 * fabricated estimate.
 */
function buildRows(projects: ProjectSummary[], stats: Stats | null): Row[] {
  const spend = new Map<string, { cost: number }>();
  for (const p of stats?.topProjects ?? []) {
    spend.set(p.projectId, { cost: p.costUsd });
  }
  return projects.map((p) => {
    const s = spend.get(p.id);
    return {
      projectId: p.id,
      name: p.name,
      cwd: p.cwd,
      cost: s?.cost ?? 0,
      tokens: totalTokens(p.totalUsage),
      sessions: p.sessionCount,
      lastActivity: p.lastActivity,
    };
  });
}

/**
 * Disambiguate rows whose display `name` collides with another row's (D5: two
 * genuinely DIFFERENT projects — different cwd, different projectId, separate
 * spend — can share the same basename, e.g. "6thSense-capture" checked out
 * under two different parent directories). Never merges them: that would mix
 * two real projects' spend into one line. Instead, append the real,
 * distinguishing parent-directory segment so the list never reads as if it
 * has a phantom duplicate.
 */
function disambiguateNames(rows: Row[]): Row[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  return rows.map((r) => {
    if ((counts.get(r.name) ?? 0) <= 1) return r;
    const segments = r.cwd?.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean) ?? [];
    const parent = segments.length >= 2 ? segments[segments.length - 2] : null;
    return parent ? { ...r, name: `${r.name} (${parent})` } : r;
  });
}

/** Compare two rows by the active sort key (always returns a desc-natural order). */
function compareBy(key: SortKey, a: Row, b: Row): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "cost":
      return a.cost - b.cost;
    case "tokens":
      return a.tokens - b.tokens;
    case "sessions":
      return a.sessions - b.sessions;
    case "lastActive": {
      const at = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bt = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return at - bt;
    }
  }
}

/** A clickable column header with the active sort arrow. */
function Th({
  label,
  col,
  sort,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  col: SortKey;
  sort: SortKey;
  dir: SortDir;
  onSort: (col: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort === col;
  return (
    <th
      className={cn(
        "select-none px-3 py-2 text-[11px] font-semibold uppercase tracking-wide",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <button
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex items-center gap-1 transition hover:text-zinc-200",
          align === "right" && "flex-row-reverse",
          active ? "text-zinc-300" : "text-zinc-500",
        )}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {active ? (
          dir === "desc" ? (
            <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )
        ) : null}
      </button>
    </th>
  );
}

/**
 * A sortable leaderboard table for the Dashboard: one row per project with its
 * estimated cost, token total, session count, and last-active time. Click a
 * column header to sort; click a row to open that project in the Browse view.
 *
 * Self-loads from `/api/projects` (the full list) and `/api/stats` (top-project
 * spend), merging the two so every project appears with its spend folded on. Cost
 * + tokens are APPROXIMATE display estimates straight from the engine's stats.
 */
export function ProjectLeaderboard({
  onOpenProject,
}: {
  /** Open a project in the Browse view by its id. From the Dashboard host. */
  onOpenProject?: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<SortKey>("cost");
  const [dir, setDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.projects(), api.stats()])
      .then(([p, s]) => {
        if (cancelled) return;
        setProjects(p);
        setStats(s);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Toggle direction when re-clicking the active column; otherwise switch column
  // and default to descending (the most useful first read for cost/tokens).
  const onSort = (col: SortKey) => {
    if (col === sort) {
      setDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSort(col);
      setDir("desc");
    }
  };

  const rows = useMemo<Row[]>(() => {
    if (!projects) return [];
    // Disambiguate BEFORE sorting so a "name" sort orders by what's actually shown.
    const built = disambiguateNames(buildRows(projects, stats));
    const sorted = [...built].sort((a, b) => compareBy(sort, a, b));
    if (dir === "desc") sorted.reverse();
    return sorted;
  }, [projects, stats, sort, dir]);

  if (error) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
        The project leaderboard isn't available on this server yet.
      </div>
    );
  }
  if (projects === null) {
    return (
      <div className="flex h-24 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/30">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="text-[12px] text-zinc-600">No projects yet.</div>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900/50">
            <Th label="Project" col="name" sort={sort} dir={dir} onSort={onSort} />
            <Th label="Cost" col="cost" sort={sort} dir={dir} onSort={onSort} align="right" />
            <Th label="Tokens" col="tokens" sort={sort} dir={dir} onSort={onSort} align="right" />
            <Th label="Sessions" col="sessions" sort={sort} dir={dir} onSort={onSort} align="right" />
            <Th label="Last active" col="lastActive" sort={sort} dir={dir} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = () => onOpenProject?.(r.projectId);
            return (
              <tr
                key={r.projectId}
                onClick={open}
                className={cn(
                  "border-b border-zinc-800/50 transition last:border-0",
                  onOpenProject && "cursor-pointer hover:bg-zinc-800/40",
                )}
                title={r.cwd ?? undefined}
              >
                <td className="max-w-0 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-violet-400/80" />
                    <span className="truncate font-medium text-zinc-200">{r.name}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums text-violet-300">
                  {r.cost > 0 ? formatUsd(r.cost) : <span className="text-zinc-600">—</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                  {r.tokens > 0 ? compactNumber(r.tokens) : <span className="text-zinc-600">—</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                  {r.sessions > 0 ? r.sessions.toLocaleString() : <span className="text-zinc-600">—</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                  {relativeTime(r.lastActivity)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
