import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Folder } from "lucide-react";
import type { ProjectSummary } from "../lib/types";
import { cn } from "../lib/utils";

/**
 * Subsequence fuzzy match: every char of the query must appear in order in the
 * haystack. Returns a rough score (lower = better; contiguous/earlier hits win)
 * or null on no match. Mirrors the CommandPalette scorer so ranking feels the
 * same across both palettes.
 */
function fuzzyScore(query: string, haystack: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastIndex = -1;
  for (let hi = 0; hi < h.length && qi < q.length; hi++) {
    if (h[hi] === q[qi]) {
      if (lastIndex >= 0) score += hi - lastIndex;
      lastIndex = hi;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/**
 * ⌘P fuzzy project switcher. A focused palette (separate from ⌘K search and
 * ⌘⇧P commands) that lists projects, filters them by a fuzzy query over name +
 * cwd, and jumps to the chosen one. Arrow keys move the selection; Enter/click
 * picks; Escape closes. Styling matches CommandPalette.
 */
export function ProjectSwitcher({
  open,
  projects,
  selectedId,
  onClose,
  onPick,
}: {
  open: boolean;
  projects: ProjectSummary[];
  /** Currently-active project, tagged "current" in the list. */
  selectedId: string | null;
  onClose: () => void;
  /** Invoked with the chosen project id; the switcher closes itself first. */
  onPick: (projectId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset + focus each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Filter + rank by fuzzy score over name + cwd, preserving order on ties.
  const filtered = useMemo(() => {
    const term = q.trim();
    if (!term) return projects;
    const scored: Array<{ p: ProjectSummary; score: number; idx: number }> = [];
    projects.forEach((p, idx) => {
      const score = fuzzyScore(term, `${p.name} ${p.cwd}`);
      if (score != null) scored.push({ p, score, idx });
    });
    scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
    return scored.map((s) => s.p);
  }, [q, projects]);

  // Keep the active index in bounds as the list shrinks/grows.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, filtered]);

  if (!open) return null;

  const choose = (p: ProjectSummary | undefined) => {
    if (!p) return;
    onClose();
    // Defer so the palette unmounts before the action mutates app state.
    requestAnimationFrame(() => onPick(p.id));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[active]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-zinc-800 px-4 py-3">
          <Folder className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to a project…"
            className="w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-zinc-600">No projects</div>
          ) : (
            filtered.map((p, i) => {
              const isActive = i === active;
              const isCurrent = p.id === selectedId;
              return (
                <button
                  key={p.id}
                  data-row={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(p)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-left transition",
                    isActive ? "bg-clay-500/10" : "hover:bg-zinc-800/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center",
                      isActive ? "text-clay-400" : "text-zinc-600",
                    )}
                  >
                    <Folder className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "truncate text-[13px] font-medium",
                        isActive ? "text-clay-100" : "text-zinc-200",
                      )}
                    >
                      {p.name}
                    </div>
                    <div className="truncate text-[11px] text-zinc-600" title={p.cwd} dir="rtl">
                      {p.cwd}
                    </div>
                  </div>
                  {isCurrent ? (
                    <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      current
                    </span>
                  ) : isActive ? (
                    <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-zinc-800 px-4 py-2 text-[10.5px] text-zinc-600">
          <span>↑↓ navigate</span>
          <span>↵ jump</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
