import { useMemo, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * SearchDateFilter — a compact date-range facet for the search box.
 *
 * The engine query-parser understands inline `after:YYYY-MM-DD` / `before:YYYY-MM-DD`
 * tokens (see packages/engine/src/query-parser.ts), so rather than thread a separate
 * facet object through `/api/search`, this control simply *edits those tokens into the
 * query string*. Picking a preset rewrites the after:/before: tokens in place and leaves
 * the rest of the query (free text + other facets) untouched; clearing strips them.
 *
 * Quick presets — Today / 7d / 30d / 90d / Custom. "Custom" reveals two native date
 * inputs. The component is controlled: it derives its active state from the tokens
 * already present in `query`, so it stays in sync if the user types tokens by hand.
 */

/** ISO date (YYYY-MM-DD) in the user's local timezone for `d` days ago (0 = today). */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  // Local Y-M-D (not toISOString, which is UTC and can roll the day boundary).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const TODAY = isoDaysAgo(0);

type PresetId = "today" | "7d" | "30d" | "90d" | "custom";

const PRESETS: { id: Exclude<PresetId, "custom">; label: string; days: number }[] = [
  { id: "today", label: "Today", days: 0 },
  { id: "7d", label: "7d", days: 7 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read the `after:`/`before:` tokens out of a query. Mirrors the engine tokenizer's
 * shape (key:value, whitespace-separated) closely enough to round-trip the tokens
 * THIS component writes; tokens the user types by hand are also picked up. The
 * `since`/`until` aliases are recognized too so we don't double-write them.
 */
function readRange(query: string): { after: string; before: string } {
  let after = "";
  let before = "";
  for (const tok of query.split(/\s+/)) {
    const m = /^(after|since|before|until):(.+)$/i.exec(tok);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!;
    if (key === "after" || key === "since") after = val;
    else before = val;
  }
  return { after, before };
}

/** Strip every after/before/since/until token from a query, collapsing whitespace. */
function stripRange(query: string): string {
  return query
    .split(/\s+/)
    .filter((tok) => !/^(after|since|before|until):/i.test(tok))
    .join(" ")
    .trim();
}

/**
 * Build the new query: free text (range tokens stripped) + the supplied after/before
 * tokens appended. Empty after/before are simply omitted, so clearing the range
 * returns the query to plain text. The free text keeps leading position so the
 * search input reads naturally ("foo after:… before:…").
 */
function withRange(query: string, after: string, before: string): string {
  const base = stripRange(query);
  const parts = [base];
  if (after) parts.push(`after:${after}`);
  if (before) parts.push(`before:${before}`);
  return parts.filter(Boolean).join(" ");
}

export function SearchDateFilter({
  query,
  onChange,
  className,
}: {
  /** The current search query (the source of truth for the active range). */
  query: string;
  /** Emit a new query with the after:/before: tokens rewritten. */
  onChange: (next: string) => void;
  className?: string;
}) {
  const { after, before } = useMemo(() => readRange(query), [query]);
  const hasRange = Boolean(after || before);

  // "Custom" is sticky once opened, or implied when the active tokens don't match
  // any preset's exact (after=today-Nd, before=today) shape.
  const [customOpen, setCustomOpen] = useState(false);

  const activePreset: PresetId | null = useMemo(() => {
    if (!hasRange) return null;
    // A preset writes after=today-Nd and before=today (today's preset writes both = today).
    if (before === TODAY) {
      for (const p of PRESETS) {
        if (after === isoDaysAgo(p.days)) return p.id;
      }
    }
    return "custom";
  }, [after, before, hasRange]);

  const showCustom = customOpen || activePreset === "custom";

  const pickPreset = (days: number) => {
    setCustomOpen(false);
    onChange(withRange(query, isoDaysAgo(days), TODAY));
  };

  const clear = () => {
    setCustomOpen(false);
    onChange(stripRange(query));
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <CalendarDays className="mr-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" />
      {PRESETS.map((p) => {
        const isActive = activePreset === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => pickPreset(p.days)}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] font-medium transition",
              isActive
                ? "bg-clay-500/20 text-clay-200 ring-1 ring-clay-500/40"
                : "text-zinc-500 ring-1 ring-zinc-800 hover:bg-zinc-800/60 hover:text-zinc-300",
            )}
          >
            {p.label}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setCustomOpen((v) => !v)}
        className={cn(
          "rounded-md px-2 py-0.5 text-[11px] font-medium transition",
          showCustom
            ? "bg-clay-500/20 text-clay-200 ring-1 ring-clay-500/40"
            : "text-zinc-500 ring-1 ring-zinc-800 hover:bg-zinc-800/60 hover:text-zinc-300",
        )}
      >
        Custom
      </button>

      {showCustom ? (
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={DATE_RE.test(after) ? after : ""}
            max={before && DATE_RE.test(before) ? before : undefined}
            onChange={(e) => onChange(withRange(query, e.target.value, before))}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300 [color-scheme:dark] focus:border-clay-500/50 focus:outline-none"
            aria-label="After date"
          />
          <span className="text-[11px] text-zinc-600">–</span>
          <input
            type="date"
            value={DATE_RE.test(before) ? before : ""}
            min={after && DATE_RE.test(after) ? after : undefined}
            onChange={(e) => onChange(withRange(query, after, e.target.value))}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300 [color-scheme:dark] focus:border-clay-500/50 focus:outline-none"
            aria-label="Before date"
          />
        </div>
      ) : null}

      {hasRange ? (
        <button
          type="button"
          onClick={clear}
          className="ml-0.5 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-300"
          title="Clear date range"
        >
          <X className="h-3 w-3" />
          clear
        </button>
      ) : null}
    </div>
  );
}
