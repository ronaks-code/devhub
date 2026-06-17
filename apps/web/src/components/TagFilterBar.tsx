import { useMemo } from "react";
import { Tag, X } from "lucide-react";
import type { SessionSummary } from "../lib/types";
import { cn } from "../lib/utils";

/**
 * Collect the distinct tags across `sessions` with how many sessions carry each,
 * sorted by count (desc) then name. The counts let the bar surface the most-used
 * tags first and show "(n)" next to each chip.
 */
export function collectTags(sessions: SessionSummary[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Keep only the sessions that carry EVERY selected tag (client-side AND). With
 * no tags selected the list is returned unchanged. Exposed so the host filters
 * with the exact same rule the bar advertises.
 */
export function filterByTags(
  sessions: SessionSummary[],
  selected: ReadonlySet<string>,
): SessionSummary[] {
  if (selected.size === 0) return sessions;
  return sessions.filter((s) => {
    const have = new Set(s.tags);
    for (const t of selected) if (!have.has(t)) return false;
    return true;
  });
}

/**
 * A tag chip filter that sits above the sessions list. Clicking a chip toggles
 * it; selecting multiple narrows the list with AND semantics (a session must
 * carry all selected tags). Renders nothing when no session has any tag, so it
 * stays out of the way until tags exist. The actual filtering lives in the host
 * (SessionsPane) via {@link filterByTags} — this component only owns the chips
 * and the selection it reports through `onChange`.
 */
export function TagFilterBar({
  sessions,
  selected,
  onChange,
}: {
  sessions: SessionSummary[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const tags = useMemo(() => collectTags(sessions), [sessions]);
  if (tags.length === 0) return null;

  const toggle = (tag: string) => {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange(next);
  };

  return (
    <div className="border-b border-zinc-900/80 px-3 pb-2">
      <div className="flex flex-wrap items-center gap-1">
        <Tag className="mr-0.5 h-3 w-3 shrink-0 text-zinc-600" />
        {tags.map(({ tag, count }) => {
          const on = selected.has(tag);
          return (
            <button
              key={tag}
              onClick={() => toggle(tag)}
              aria-pressed={on}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 transition",
                on
                  ? "bg-clay-500/20 text-clay-100 ring-clay-500/40"
                  : "bg-zinc-800/60 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
              )}
              title={on ? `Remove "${tag}" filter` : `Filter by "${tag}"`}
            >
              {tag}
              <span className={cn("tabular-nums", on ? "text-clay-300/80" : "text-zinc-600")}>
                {count}
              </span>
            </button>
          );
        })}
        {selected.size > 0 && (
          <button
            onClick={() => onChange(new Set())}
            className="ml-0.5 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
            title="Clear tag filters"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
