import { useEffect, useRef, useState } from "react";
import { Search, CornerDownLeft, Folder, Globe } from "lucide-react";
import type { SearchHitWithSeq } from "../lib/types";
import { cn } from "../lib/utils";
import { readCompat, writeCompat } from "../lib/compat-storage";
import { Spinner } from "./ui";
import { SearchDateFilter } from "./SearchDateFilter";

/** Search scope: everything, or just the active project. */
type SearchScope = "global" | "project";

/** Where the scope preference is remembered between opens. */
const SCOPE_KEY = "devhub:search-scope";

/** Read the persisted scope (defaults to "global" — the original behavior). */
function readScope(): SearchScope {
  return readCompat(SCOPE_KEY) === "project" ? "project" : "global";
}

/** Persist the chosen scope. Non-fatal on storage errors. */
function writeScope(scope: SearchScope): void {
  writeCompat(SCOPE_KEY, scope);
}

/** Render FTS snippet markers ([match]) as styled highlights. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="rounded bg-clay-500/20 px-0.5 text-clay-200">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function SearchPalette({
  open,
  onClose,
  onPick,
  activeProjectId,
  activeProjectName,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (hit: SearchHitWithSeq) => void;
  /** The currently-selected project, enabling the "Project" scope. From the App. */
  activeProjectId?: string | null;
  /** That project's display name, for the scope toggle label. */
  activeProjectName?: string | null;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHitWithSeq[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  // Global vs. Project scope, remembered across opens. "project" only narrows when
  // a project is actually active; otherwise it behaves like "global".
  const [scope, setScope] = useState<SearchScope>(() => readScope());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The scope actually applied: "project" requires an active project to mean
  // anything. Without one we always search globally.
  const effectiveProject = scope === "project" && activeProjectId ? activeProjectId : null;

  const setScopePersisted = (next: SearchScope) => {
    setScope(next);
    writeScope(next);
  };

  // Reset + focus each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setHits([]);
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(() => {
      // Pass projectId when scoped (the current server ignores unknown query
      // params; this future-proofs server-side narrowing). We ALSO filter the
      // returned hits to the project client-side so scoping works today against a
      // server that doesn't yet narrow.
      const url =
        `/api/search?q=${encodeURIComponent(term)}&limit=30` +
        (effectiveProject ? `&projectId=${encodeURIComponent(effectiveProject)}` : "");
      fetch(url, { headers: { accept: "application/json" } })
        .then((r) => (r.ok ? (r.json() as Promise<SearchHitWithSeq[]>) : []))
        .then((res) => {
          if (cancelled) return;
          const scoped = effectiveProject
            ? res.filter((h) => h.projectId === effectiveProject)
            : res;
          setHits(scoped);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, effectiveProject]);

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, hits]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[active];
      if (hit) onPick(hit);
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
          <Search className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              effectiveProject
                ? `Search ${activeProjectName || "this project"}…`
                : "Search all sessions…"
            }
            className="w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          {loading && <Spinner className="h-3.5 w-3.5" />}
        </div>

        {/* Scope toggle (Global vs. Project) + date-range facet. Scope is remembered
            across opens; "Project" is disabled with no active project. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 px-4 py-2">
          <div className="inline-flex items-center rounded-lg bg-zinc-950 p-0.5 ring-1 ring-zinc-800">
            <button
              type="button"
              onClick={() => setScopePersisted("global")}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition",
                scope === "global"
                  ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
              title="Search across every project"
            >
              <Globe className="h-3 w-3" />
              Global
            </button>
            <button
              type="button"
              onClick={() => setScopePersisted("project")}
              disabled={!activeProjectId}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-40",
                scope === "project" && activeProjectId
                  ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                  : "text-zinc-500 hover:text-zinc-300 disabled:hover:text-zinc-500",
              )}
              title={
                activeProjectId
                  ? "Search only the active project"
                  : "Select a project to scope the search to it"
              }
            >
              <Folder className="h-3 w-3" />
              <span className="max-w-[10rem] truncate">
                {activeProjectName || "Project"}
              </span>
            </button>
          </div>
          {/* Date-range facet: writes after:/before: tokens into the query, which the
              engine query-parser lifts into search facets (no separate API param). */}
          <div className="min-w-0 flex-1">
            <SearchDateFilter query={q} onChange={setQ} />
          </div>
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-1.5">
          {hits.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-zinc-600">
              {q.trim() ? (loading ? "Searching…" : "No results") : "Type to search"}
            </div>
          ) : (
            hits.map((hit, i) => {
              const isActive = i === active;
              return (
                <button
                  key={`${hit.sessionId}-${i}`}
                  data-row={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onPick(hit)}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-2 text-left transition",
                    isActive ? "bg-clay-500/10" : "hover:bg-zinc-800/50",
                  )}
                >
                  <Folder
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      isActive ? "text-clay-400" : "text-zinc-600",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate text-[13px] font-medium",
                          isActive ? "text-clay-100" : "text-zinc-200",
                        )}
                      >
                        {hit.title}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-zinc-600">{hit.projectName}</span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-zinc-500">
                      <Highlighted text={hit.snippet} />
                    </div>
                  </div>
                  {isActive && (
                    <CornerDownLeft className="mt-1 h-3.5 w-3.5 shrink-0 text-zinc-600" />
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-zinc-800 px-4 py-2 text-[10.5px] text-zinc-600">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto inline-flex items-center gap-1">
            {effectiveProject ? (
              <>
                <Folder className="h-3 w-3" />
                {activeProjectName || "project"}
              </>
            ) : (
              <>
                <Globe className="h-3 w-3" />
                all projects
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
