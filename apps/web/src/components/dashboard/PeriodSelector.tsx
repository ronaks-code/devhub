import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";

/** A named usage window. "custom" reveals two date inputs; the rest are spans. */
export type PeriodId = "7d" | "30d" | "90d" | "all" | "custom";

/**
 * The resolved `since`/`until` (inclusive `YYYY-MM-DD`) for the chosen period.
 * Both are undefined for "all" (the whole history). For a span period `until` is
 * today and `since` is N-1 days back, so a "7d" window covers today + 6 prior days.
 */
export interface PeriodRange {
  id: PeriodId;
  since?: string;
  until?: string;
}

const PRESETS: { id: Exclude<PeriodId, "custom">; label: string; days: number | null }[] = [
  { id: "7d", label: "7d", days: 7 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
  { id: "all", label: "All", days: null },
];

/** UTC `YYYY-MM-DD` for a Date — matches the engine's calendar-day bucketing. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve a span preset to a {@link PeriodRange} ending today (UTC). */
function presetRange(id: Exclude<PeriodId, "custom">, days: number | null): PeriodRange {
  if (days == null) return { id };
  const until = new Date();
  const since = new Date();
  // N days inclusive of today → go back N-1 days for the lower bound.
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { id, since: isoDay(since), until: isoDay(until) };
}

/**
 * Resolve a preset id to its full {@link PeriodRange} (dates included). Hosts use
 * this for their INITIAL period state: a bare `{ id: "30d" }` with no since/until
 * queries the WHOLE history, so a dashboard that defaulted to it showed all-time
 * totals under a "30d" label until the user first clicked the selector.
 */
export function resolvePresetRange(id: Exclude<PeriodId, "custom">): PeriodRange {
  const preset = PRESETS.find((p) => p.id === id);
  return presetRange(id, preset?.days ?? null);
}

const btnCls =
  "rounded-md px-2.5 py-1 text-[12px] font-medium transition focus:outline-none";
const dateInputCls =
  "rounded-md bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 [color-scheme:dark] focus:outline-none focus:ring-clay-500/40";

/**
 * Period selector for the Dashboard. Emits a resolved {@link PeriodRange} via
 * `onChange` whenever the selection changes; the host re-queries
 * GET /api/rollups?since=&until= and sums the in-range days for period totals.
 * No engine change is needed — the window is computed entirely client-side.
 */
export function PeriodSelector({
  value,
  onChange,
}: {
  value: PeriodId;
  onChange: (range: PeriodRange) => void;
}) {
  // Custom-range drafts. Default to a 30-day window ending today so the inputs
  // start populated when the user first opens "Custom".
  const today = useMemo(() => isoDay(new Date()), []);
  const monthAgo = useMemo(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 29);
    return isoDay(d);
  }, []);
  const [customSince, setCustomSince] = useState(monthAgo);
  const [customUntil, setCustomUntil] = useState(today);

  const pickPreset = (id: Exclude<PeriodId, "custom">, days: number | null) =>
    onChange(presetRange(id, days));

  const applyCustom = (since: string, until: string) => {
    // Keep the bounds ordered so a backwards range still queries sensibly.
    const [lo, hi] = since <= until ? [since, until] : [until, since];
    onChange({ id: "custom", since: lo, until: hi });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => pickPreset(p.id, p.days)}
            className={cn(
              btnCls,
              value === p.id
                ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                : "text-zinc-500 hover:text-zinc-300",
            )}
            aria-pressed={value === p.id}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => applyCustom(customSince, customUntil)}
          className={cn(
            btnCls,
            value === "custom"
              ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
              : "text-zinc-500 hover:text-zinc-300",
          )}
          aria-pressed={value === "custom"}
        >
          Custom
        </button>
      </div>

      {value === "custom" && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={customSince}
            max={customUntil}
            onChange={(e) => {
              setCustomSince(e.target.value);
              if (e.target.value) applyCustom(e.target.value, customUntil);
            }}
            className={dateInputCls}
            aria-label="From date"
          />
          <span className="text-[11px] text-zinc-600">to</span>
          <input
            type="date"
            value={customUntil}
            min={customSince}
            max={today}
            onChange={(e) => {
              setCustomUntil(e.target.value);
              if (e.target.value) applyCustom(customSince, e.target.value);
            }}
            className={dateInputCls}
            aria-label="To date"
          />
        </div>
      )}
    </div>
  );
}
