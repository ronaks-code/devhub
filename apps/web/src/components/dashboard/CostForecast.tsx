import { useEffect, useMemo, useState } from "react";
import { Coins, TrendingUp, TriangleAlert } from "lucide-react";
import type { BudgetStatus, SessionSummary } from "../../lib/types";
import { api, NotImplementedError } from "../../lib/api";
import { costUsd } from "../../lib/pricing";
import { formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

/** Last path segment of a working directory (the "project" name). */
function lastSegment(cwd: string | null): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

/** How many sessions to sample (by tokens) before re-ranking by cost client-side. */
const FETCH_LIMIT = 100;
/** A session must cost at least this multiple of the median to count as an anomaly. */
const ANOMALY_MULT = 3;
/** Never flag spend below this (cents) — keeps noise out on a cheap month. */
const ANOMALY_FLOOR_USD = 0.5;
/** Cap how many anomalies we surface so the callout stays a glance, not a list. */
const MAX_ANOMALIES = 3;

/** One unusually-expensive session, ready to render. */
interface Anomaly {
  session: SessionSummary;
  cost: number;
  /** How many times the median this session cost (for the "Nx median" chip). */
  xMedian: number;
}

/** Median of a numeric array (0 for empty). Does not mutate the input. */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  if (sorted.length % 2 !== 0) return hi;
  const lo = sorted[mid - 1] ?? hi;
  return (lo + hi) / 2;
}

/**
 * Project end-of-period spend from the run rate so far this month. Prefers a
 * server-provided `projectedUsd`; otherwise extrapolates linearly from the elapsed
 * fraction of the current UTC month. Mirrors BudgetSettings' projection so the two
 * surfaces agree.
 */
function projectEndOfPeriod(status: BudgetStatus, now: Date = new Date()): number {
  if (typeof status.projectedUsd === "number" && Number.isFinite(status.projectedUsd)) {
    return status.projectedUsd;
  }
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const elapsed = now.getUTCDate() / daysInMonth;
  if (elapsed <= 0) return status.monthToDateUsd;
  return status.monthToDateUsd / elapsed;
}

/**
 * Dashboard widget: month-to-date spend, the projected end-of-month total, the
 * cap line (when one is set), and an ANOMALY callout flagging the few unusually
 * expensive sessions — those whose estimated cost is well above the median (and
 * above a small floor, so a cheap month stays quiet).
 *
 * Plain words: a quick "how's my spend trending, and did any session blow the
 * budget?" read. The projection is your current run rate stretched to the end of
 * the month; the anomaly chips point at the sessions worth a second look.
 *
 * Resilient by design: the budget status comes from GET /api/budget, but on an
 * older server that 404s we degrade to a tokens-only view (anomalies still work
 * off per-session costUsd, which the index already has). Loading + empty states
 * are handled so the widget never renders broken chrome.
 */
export function CostForecast({
  onOpenSession,
}: {
  /** Open a session in the Browse view: (projectId, sessionId). */
  onOpenSession?: (projectId: string, sessionId: string) => void;
}) {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  // null = loading, [] = loaded-empty, otherwise the sampled sessions.
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState(false);

  // Budget status (MTD / projection / cap). A 404 just leaves `status` null —
  // we still render the anomaly view from per-session costs.
  useEffect(() => {
    let cancelled = false;
    api
      .getBudget()
      .then((b) => {
        if (!cancelled) setStatus(b.status);
      })
      .catch((e) => {
        // NotImplementedError (older server) is expected — degrade quietly. Any
        // other error also just drops the budget panel; the anomaly view stays.
        if (!cancelled && !(e instanceof NotImplementedError)) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sessions sample for the anomaly scan (reuses the same source TopSpenders uses).
  useEffect(() => {
    let cancelled = false;
    api
      .allSessions({ sort: "tokens", limit: FETCH_LIMIT })
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch(() => {
        if (!cancelled) setSessionsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Estimate each session's cost, then flag the ones well above the median.
  const anomalies = useMemo<Anomaly[]>(() => {
    if (!sessions) return [];
    const priced = sessions
      .map((s) => ({ session: s, cost: costUsd(s.model, s.usage) }))
      .filter((r) => r.cost > 0);
    if (priced.length < 4) return []; // too few to call anything "unusual"
    const med = median(priced.map((r) => r.cost));
    if (med <= 0) return [];
    const threshold = Math.max(med * ANOMALY_MULT, ANOMALY_FLOOR_USD);
    return priced
      .filter((r) => r.cost >= threshold)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, MAX_ANOMALIES)
      .map((r) => ({ ...r, xMedian: r.cost / med }));
  }, [sessions]);

  // Loading: still waiting on the sessions sample (the only data we strictly need).
  if (sessions === null && !sessionsError) {
    return (
      <div className="flex h-24 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/30">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  const mtd = status?.monthToDateUsd ?? null;
  const projected = status ? projectEndOfPeriod(status) : null;
  const cap = status?.monthlyBudgetUsd ?? null;
  const overProjected = cap != null && projected != null && projected > cap;

  // Nothing to show at all (no budget status AND no anomalies AND no sessions).
  const hasBudget = status != null && (mtd ?? 0) > 0;
  if (!hasBudget && anomalies.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
        No spend to forecast yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Spend summary — only when the budget route gave us a status. */}
      {hasBudget ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3.5">
            <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              <Coins className="h-3 w-3 text-clay-400" />
              Month to date
            </span>
            <span className="text-lg font-semibold tabular-nums text-zinc-100">
              {formatUsd(mtd ?? 0)}
            </span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3.5">
            <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              <TrendingUp className="h-3 w-3 text-clay-400" />
              Projected
            </span>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                overProjected ? "text-red-300" : "text-clay-300",
              )}
            >
              {formatUsd(projected ?? 0)}
            </span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Cap
            </span>
            <span className="text-lg font-semibold tabular-nums text-zinc-400">
              {cap != null ? formatUsd(cap) : "—"}
            </span>
          </div>
        </div>
      ) : null}

      {overProjected ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-300">
          <TrendingUp className="h-3.5 w-3.5 shrink-0" />
          <span>
            On track to spend {formatUsd(projected ?? 0)} this month — past your{" "}
            {formatUsd(cap ?? 0)} cap.
          </span>
        </div>
      ) : null}

      {/* Anomaly callout — unusually expensive sessions. */}
      {anomalies.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-amber-500/25 bg-amber-500/[0.04]">
          <div className="flex items-center gap-1.5 border-b border-amber-500/15 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-amber-300/90">
            <TriangleAlert className="h-3.5 w-3.5" />
            Unusually expensive sessions
          </div>
          <div className="flex flex-col divide-y divide-zinc-800/60">
            {anomalies.map(({ session: s, cost, xMedian }) => {
              const open = () => onOpenSession?.(s.projectId, s.sessionId);
              return (
                <button
                  key={s.sessionId}
                  onClick={open}
                  disabled={!onOpenSession}
                  className="group flex items-center gap-3 px-3.5 py-2.5 text-left transition hover:bg-amber-500/[0.06] disabled:cursor-default"
                  title={s.cwd ?? undefined}
                >
                  <Coins className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-zinc-200 group-hover:text-zinc-100">
                      {s.title || "(untitled session)"}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-600">
                      <span className="truncate">{lastSegment(s.cwd)}</span>
                      <span>·</span>
                      <span className="shrink-0 tabular-nums text-amber-300/70">
                        {Math.round(xMedian)}× median
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-[13px] font-semibold tabular-nums text-amber-300">
                    {formatUsd(cost)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
