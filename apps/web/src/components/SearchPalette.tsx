import { useEffect, useRef, useState } from "react";
import { Search, CornerDownLeft, Folder } from "lucide-react";
import type { SearchHit } from "@claude-ui/engine/types";
import { cn } from "../lib/utils";
import { Spinner } from "./ui";

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
}: {
  open: boolean;
  onClose: () => void;
  onPick: (hit: SearchHit) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
      fetch(`/api/search?q=${encodeURIComponent(term)}&limit=30`, {
        headers: { accept: "application/json" },
      })
        .then((r) => (r.ok ? (r.json() as Promise<SearchHit[]>) : []))
        .then((res) => {
          if (cancelled) return;
          setHits(res);
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
  }, [q, open]);

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
            placeholder="Search all sessions…"
            className="w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          {loading && <Spinner className="h-3.5 w-3.5" />}
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
        </div>
      </div>
    </div>
  );
}
