import { useMemo, useState } from "react";
import { Folder, Search, Layers } from "lucide-react";
import type { ProjectSummary } from "../lib/types";
import { cn } from "../lib/utils";
import { relativeTime } from "../lib/format";

export function ProjectsPane({
  projects,
  selectedId,
  onSelect,
}: {
  projects: ProjectSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(s) || p.cwd.toLowerCase().includes(s),
    );
  }, [projects, q]);

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-900/30">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Projects</h2>
        <span className="text-[11px] text-zinc-600">{projects.length}</span>
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 ring-1 ring-zinc-800 focus-within:ring-clay-500/40">
          <Search className="h-3.5 w-3.5 text-zinc-600" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter projects"
            className="w-full bg-transparent text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {filtered.map((p) => {
          const active = p.id === selectedId;
          return (
            <button
              key={p.id}
              data-testid="project"
              onClick={() => onSelect(p.id)}
              className={cn(
                "group mb-0.5 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition",
                active ? "bg-clay-500/10 ring-1 ring-clay-500/30" : "hover:bg-zinc-800/50",
              )}
            >
              <Folder
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  active ? "text-clay-400" : "text-zinc-600 group-hover:text-zinc-500",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "truncate text-[13px] font-medium",
                      active ? "text-clay-100" : "text-zinc-200",
                    )}
                  >
                    {p.name}
                  </span>
                  {p.encodedFolders.length > 1 && (
                    <Layers
                      className="h-3 w-3 shrink-0 text-amber-500/70"
                      aria-label={`${p.encodedFolders.length} transcript folders merged (orphan recovery)`}
                    />
                  )}
                </div>
                <div className="truncate text-[11px] text-zinc-600" dir="rtl">
                  {p.cwd}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-zinc-600">
                  <span>{p.sessionCount} sessions</span>
                  <span>·</span>
                  <span>{relativeTime(p.lastActivity)}</span>
                </div>
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">No projects</div>
        )}
      </div>
    </div>
  );
}
