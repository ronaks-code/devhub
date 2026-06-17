import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Command as CommandIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** A single runnable action shown in the command palette. */
export interface Command {
  /** Stable id (used as React key). */
  id: string;
  /** Primary label, e.g. "Switch to Chat". */
  title: string;
  /** Optional group, e.g. "Navigate", "Model", "Project". */
  group?: string;
  /** Optional trailing hint, e.g. a shortcut or current value. */
  hint?: string;
  /** Leading icon. */
  icon?: ReactNode;
  /** Extra terms folded into the match text but not displayed. */
  keywords?: string;
  /** Invoked on Enter / click. The palette closes itself afterward. */
  run: () => void;
}

/**
 * Subsequence fuzzy match (same idea as editor command palettes): every char of
 * the query must appear in order somewhere in the haystack. Returns a rough
 * score (lower = better, earlier/tighter matches win) or null when no match.
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
      // Penalize gaps between matched chars so contiguous hits rank higher.
      if (lastIndex >= 0) score += hi - lastIndex;
      lastIndex = hi;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
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

  // Filter + rank by fuzzy score, preserving original order on ties.
  const filtered = useMemo(() => {
    const term = q.trim();
    if (!term) return commands;
    const scored: Array<{ cmd: Command; score: number; idx: number }> = [];
    commands.forEach((cmd, idx) => {
      const hay = `${cmd.title} ${cmd.group ?? ""} ${cmd.keywords ?? ""}`;
      const score = fuzzyScore(term, hay);
      if (score != null) scored.push({ cmd, score, idx });
    });
    scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
    return scored.map((s) => s.cmd);
  }, [q, commands]);

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

  const choose = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    // Defer so the palette unmounts before the action mutates app state.
    requestAnimationFrame(() => cmd.run());
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
          <CommandIcon className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Run a command…"
            className="w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-zinc-600">No commands</div>
          ) : (
            filtered.map((cmd, i) => {
              const isActive = i === active;
              return (
                <button
                  key={cmd.id}
                  data-row={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(cmd)}
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
                    {cmd.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "truncate text-[13px] font-medium",
                        isActive ? "text-clay-100" : "text-zinc-200",
                      )}
                    >
                      {cmd.title}
                    </span>
                  </div>
                  {cmd.group ? (
                    <span className="shrink-0 text-[10.5px] text-zinc-600">{cmd.group}</span>
                  ) : null}
                  {cmd.hint ? (
                    <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      {cmd.hint}
                    </span>
                  ) : null}
                  {isActive && !cmd.hint ? (
                    <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-zinc-800 px-4 py-2 text-[10.5px] text-zinc-600">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
