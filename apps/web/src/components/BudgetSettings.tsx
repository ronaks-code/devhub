import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, PiggyBank, Save, TriangleAlert } from "lucide-react";
import { api, NotImplementedError, type BudgetConfig, type BudgetStatus } from "../lib/api";
import { formatUsd } from "../lib/format";
import { cn } from "../lib/utils";
import { Spinner } from "./ui";

// Match the form chrome SettingsPane uses for its other sections (those helpers
// are module-private over there, so we mirror the exact classes here).
const inputCls =
  "rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[13px] text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-zinc-300">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-zinc-600">{hint}</span> : null}
    </label>
  );
}

/** The default warn threshold (% of cap) when the server/config doesn't carry one. */
const DEFAULT_WARN_PCT = 80;

/**
 * Project end-of-period spend from the run rate so far this month. Prefers a
 * server-provided `projectedUsd`; otherwise extrapolates linearly from the elapsed
 * fraction of the current UTC month (month-to-date / fraction-elapsed). Returns
 * `monthToDateUsd` itself near the very start of a month where a projection would
 * be wild noise.
 */
function projectEndOfPeriod(status: BudgetStatus, now: Date = new Date()): number {
  if (typeof status.projectedUsd === "number" && Number.isFinite(status.projectedUsd)) {
    return status.projectedUsd;
  }
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // Day-of-month is 1-based; treat the current (partial) day as elapsed.
  const dayOfMonth = now.getUTCDate();
  const elapsed = dayOfMonth / daysInMonth;
  if (elapsed <= 0) return status.monthToDateUsd;
  return status.monthToDateUsd / elapsed;
}

/** Colors for the spend bar, keyed off the alert level (matches TokenMeter's tones). */
function barColor(alert: BudgetStatus["alert"]): string {
  if (alert === "over") return "bg-red-500";
  if (alert === "warn") return "bg-amber-500";
  return "bg-clay-500";
}

/**
 * Budget configuration panel for Settings. Lets the user set a monthly cap (USD,
 * or "no cap"), a warn threshold (% of the cap), and an enforce toggle — and shows
 * the live status inline: month-to-date spend vs. cap on a progress bar that turns
 * warn/over colors, the projected end-of-period total, and what's remaining.
 *
 * Plain words: decide how much you want to spend each month, and see at a glance
 * how close you are. The bar goes amber when you near your limit and red once you
 * pass it.
 *
 * Loads GET /api/budget and saves PUT /api/budget. Resilient: on a server that
 * hasn't shipped the route (NotImplementedError), it shows a quiet "not available
 * yet" note instead of erroring — exactly like the other forward-wired controls.
 */
export function BudgetSettings() {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  // Editable form fields (kept as strings so partial/empty input is representable).
  const [capStr, setCapStr] = useState("");
  const [warnStr, setWarnStr] = useState(String(DEFAULT_WARN_PCT));
  const [enforce, setEnforce] = useState(false);

  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getBudget()
      .then((b) => {
        if (cancelled) return;
        setStatus(b.status);
        setCapStr(b.config.monthlyBudgetUsd == null ? "" : String(b.config.monthlyBudgetUsd));
        setWarnStr(String(b.config.warnThresholdPct ?? DEFAULT_WARN_PCT));
        setEnforce(b.config.enforce === true);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof NotImplementedError) setUnavailable(true);
        else setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  // Client-side validation: a present cap must be a non-negative finite number;
  // the warn threshold must be 0–100. Blank cap means "no cap" (valid).
  const capError = useMemo(() => {
    const v = capStr.trim();
    if (v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return "Enter a number ≥ 0, or clear for no cap.";
    return null;
  }, [capStr]);

  const warnError = useMemo(() => {
    const v = warnStr.trim();
    if (v === "") return "Enter a percentage 0–100.";
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) return "Enter a percentage 0–100.";
    return null;
  }, [warnStr]);

  const valid = capError == null && warnError == null;

  const save = async () => {
    if (!valid || saving) return;
    const capTrim = capStr.trim();
    const config: BudgetConfig = {
      monthlyBudgetUsd: capTrim === "" ? null : Number(capTrim),
      warnThresholdPct: Number(warnStr.trim()),
      enforce,
    };
    setSaving(true);
    setLoadError(null);
    try {
      const b = await api.putBudget(config);
      setStatus(b.status);
      setCapStr(b.config.monthlyBudgetUsd == null ? "" : String(b.config.monthlyBudgetUsd));
      setWarnStr(String(b.config.warnThresholdPct ?? DEFAULT_WARN_PCT));
      setEnforce(b.config.enforce === true);
      setSavedAt(Date.now());
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedAt(null), 2000);
    } catch (e) {
      if (e instanceof NotImplementedError) setUnavailable(true);
      else setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
        Budget controls aren't available on this server yet.
      </div>
    );
  }

  // Live status read (post-load / post-save). `cap` drives the bar + remaining.
  const cap = status?.monthlyBudgetUsd ?? null;
  const mtd = status?.monthToDateUsd ?? 0;
  const projected = status ? projectEndOfPeriod(status) : 0;
  const remaining = cap != null ? cap - mtd : null;
  const pct = cap && cap > 0 ? Math.min(100, (mtd / cap) * 100) : 0;
  const alert = status?.alert ?? "none";

  return (
    <div className="space-y-6">
      {/* Live status */}
      <section className="space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
        <div className="flex items-center gap-2">
          <PiggyBank className="h-4 w-4 text-zinc-500" />
          <h2 className="text-[13px] font-semibold text-zinc-200">This month</h2>
          {alert !== "none" ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                alert === "over"
                  ? "bg-red-500/15 text-red-300"
                  : "bg-amber-500/15 text-amber-300",
              )}
            >
              <TriangleAlert className="h-3 w-3" />
              {alert === "over" ? "Over budget" : "Nearing budget"}
            </span>
          ) : null}
        </div>

        <div className="flex items-baseline justify-between gap-3 text-[13px]">
          <span className="font-semibold tabular-nums text-zinc-100">{formatUsd(mtd)}</span>
          <span className="text-[12px] tabular-nums text-zinc-500">
            {cap != null ? `of ${formatUsd(cap)}` : "no cap"}
          </span>
        </div>

        {cap != null && cap > 0 ? (
          <div className="h-2.5 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-zinc-800">
            <div
              className={cn("h-full rounded-full transition-all", barColor(alert))}
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-zinc-600">Spent</span>
            <span className="font-medium tabular-nums text-zinc-200">{formatUsd(mtd)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-zinc-600">Projected end of month</span>
            <span className="font-medium tabular-nums text-clay-300">{formatUsd(projected)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-zinc-600">Remaining</span>
            <span
              className={cn(
                "font-medium tabular-nums",
                remaining == null
                  ? "text-zinc-500"
                  : remaining < 0
                    ? "text-red-300"
                    : "text-emerald-300",
              )}
            >
              {remaining == null ? "—" : formatUsd(remaining)}
            </span>
          </div>
        </div>
        <p className="text-[11px] leading-snug text-zinc-600">
          APPROXIMATE — priced from token usage, never billed truth. Projection
          extrapolates this month's run rate.
        </p>
      </section>

      {/* Config */}
      <section className="space-y-5 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Monthly cap (USD)" hint="Blank = no cap.">
            <input
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              placeholder="No cap"
              className={cn(inputCls, capError && "ring-red-500/50 focus:ring-red-500/50")}
              value={capStr}
              onChange={(e) => setCapStr(e.target.value)}
            />
            {capError ? <span className="text-[11px] text-red-400">{capError}</span> : null}
          </Field>

          <Field label="Warn threshold (%)" hint="Turn amber at this share of the cap.">
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              inputMode="numeric"
              className={cn(inputCls, warnError && "ring-red-500/50 focus:ring-red-500/50")}
              value={warnStr}
              onChange={(e) => setWarnStr(e.target.value)}
            />
            {warnError ? <span className="text-[11px] text-red-400">{warnError}</span> : null}
          </Field>
        </div>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={enforce}
            onChange={(e) => setEnforce(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-clay-500 focus:ring-clay-500/40"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[12px] font-medium text-zinc-300">Enforce the cap</span>
            <span className="text-[11px] text-zinc-600">
              When on, the server may block new spend past the cap rather than only warning.
            </span>
          </span>
        </label>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving || !valid}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg bg-clay-500 px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-clay-600 disabled:opacity-50",
            )}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save budget
          </button>
          {savedAt ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          ) : null}
          {loadError ? <span className="text-[12px] text-red-400">{loadError}</span> : null}
        </div>
      </section>
    </div>
  );
}
