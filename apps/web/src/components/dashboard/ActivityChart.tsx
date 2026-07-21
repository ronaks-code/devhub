import { useEffect, useMemo, useState } from "react";
import { Calendar, X } from "lucide-react";
import type { DailyUsage, SessionSummary } from "../../lib/types";
import { api } from "../../lib/api";
import { compactNumber, formatUsd, relativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";
import { displaySessionTitle, projectNameFromCwd } from "../../lib/session-title";

/** Sum of the four token buckets for one rolled-up day. */
function dayTokens(d: DailyUsage): number {
  return d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens;
}

/**
 * UTC `YYYY-MM-DD` for an ISO timestamp (or null when unparseable). Rollup days
 * are UTC calendar days, so a session is matched to a bar by its UTC last-activity
 * day — keeping the drill-down consistent with the bar it was clicked from.
 */
function utcDay(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** How many recent sessions to pull when drilling into a day (filtered client-side). */
const DRILL_FETCH_LIMIT = 500;

/**
 * The usage-over-time bar chart for the Dashboard. Renders one bar per in-range
 * rolled-up day (oldest→newest), heights scaled to the period's busiest day. Each
 * bar is a focusable button: clicking it (or pressing Enter/Space while focused)
 * drills into that day, opening a modal that lists the sessions whose last activity
 * fell on it — each row opens the session in the Browse transcript.
 *
 * The day's session list is fetched lazily via /api/all-sessions (sorted by
 * recent, filtered to the day in the browser by UTC last-activity), so no new
 * endpoint is needed and it degrades to an empty list if the server can't list
 * sessions. Pure presentation over the `days` it's given (the in-range DailyUsage
 * series the host already loads for the period totals).
 */
export function ActivityChart({
  days,
  maxTokens,
  onOpenSession,
}: {
  /** In-range daily usage, oldest→newest (the same series the host sums for totals). */
  days: DailyUsage[];
  /** The busiest day's token total, for scaling bar heights (host-computed, ≥1). */
  maxTokens: number;
  /** Open a session in the Browse view: (projectId, sessionId). From the Dashboard. */
  onOpenSession?: (projectId: string, sessionId: string) => void;
}) {
  // The day a bar drilled into (its DailyUsage), or null when no modal is open.
  const [drill, setDrill] = useState<DailyUsage | null>(null);

  return (
    <>
      <div className="flex h-28 items-end gap-0.5 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
        {days.map((d) => {
          const t = dayTokens(d);
          const tip = `${d.date}: ${compactNumber(t)} tokens · ${formatUsd(d.costUsd)} · ${d.sessions} session${d.sessions === 1 ? "" : "s"} — click to view`;
          return (
            <button
              key={d.date}
              type="button"
              onClick={() => setDrill(d)}
              className="group flex h-full min-w-0 flex-1 items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
              title={tip}
              aria-label={tip}
            >
              <div
                className="w-full rounded-sm bg-violet-500/70 transition group-hover:bg-violet-400 group-focus-visible:bg-violet-400"
                style={{ height: `${Math.max(t > 0 ? 6 : 2, (t / maxTokens) * 100)}%` }}
              />
            </button>
          );
        })}
      </div>

      {drill ? (
        <DayDrilldown
          day={drill}
          onClose={() => setDrill(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </>
  );
}

/**
 * Modal listing the sessions whose last activity fell on `day.date`. Fetches the
 * most-recent sessions once and filters to the day in the browser (rollups know
 * only calendar days, not which sessions land on them), then lets the user open
 * any one in the Browse transcript. Closes on Escape or a backdrop click.
 */
function DayDrilldown({
  day,
  onClose,
  onOpenSession,
}: {
  day: DailyUsage;
  onClose: () => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState(false);

  // Pull recent sessions once, then narrow to this day client-side. Sorting by
  // "recent" keeps the busiest/most-recent days within the fetch window.
  useEffect(() => {
    let cancelled = false;
    api
      .allSessions({ sort: "recent", limit: DRILL_FETCH_LIMIT })
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on Escape, matching the app's other overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo<SessionSummary[]>(() => {
    if (!sessions) return [];
    return sessions.filter((s) => utcDay(s.lastTimestamp) === day.date);
  }, [sessions, day.date]);

  const tokens = dayTokens(day);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Sessions on ${day.date}`}
      >
        {/* Header: the day + its rolled-up totals. */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Calendar className="h-4 w-4 text-violet-400" />
          <span className="text-[13px] font-semibold text-zinc-100">{day.date}</span>
          <span className="text-[11px] tabular-nums text-zinc-600">
            {compactNumber(tokens)} tok · {formatUsd(day.costUsd)} · {day.sessions} session
            {day.sessions === 1 ? "" : "s"}
          </span>
          <button
            onClick={onClose}
            className="ml-auto inline-flex items-center justify-center rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body: the day's sessions, or the appropriate loading/empty/error state. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="px-4 py-8 text-center text-[12px] text-zinc-600">
              Session listing isn't available on this server.
            </div>
          ) : sessions === null ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner className="h-5 w-5" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-zinc-600">
              No sessions landed on this day{" "}
              {day.sessions > 0 ? "(older than the recent window)" : ""}.
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-zinc-800/60">
              {rows.map((s) => {
                const project = projectNameFromCwd(s.cwd) ?? "unknown";
                const open = () => {
                  onOpenSession?.(s.projectId, s.sessionId);
                  onClose();
                };
                return (
                  <button
                    key={s.sessionId}
                    onClick={open}
                    disabled={!onOpenSession}
                    className={cn(
                      "group flex items-center gap-3 px-4 py-2.5 text-left transition hover:bg-zinc-800/40 disabled:cursor-default",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/50",
                    )}
                    title={s.cwd ?? undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-zinc-200 group-hover:text-zinc-100">
                        {displaySessionTitle(s)}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-600">
                        <span className="truncate">{project}</span>
                        {s.model ? (
                          <>
                            <span>·</span>
                            <span className="truncate">{s.model}</span>
                          </>
                        ) : null}
                        <span>·</span>
                        <span className="tabular-nums">{s.messageCount} msg</span>
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
                      {relativeTime(s.lastTimestamp)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
