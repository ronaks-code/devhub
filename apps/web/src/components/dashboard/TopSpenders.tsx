import { useEffect, useMemo, useState } from "react";
import { Coins } from "lucide-react";
import type { SessionSummary } from "../../lib/types";
import { api } from "../../lib/api";
import { costUsd } from "../../lib/pricing";
import { compactNumber, formatUsd } from "../../lib/format";
import { Spinner } from "../ui";
import { displaySessionTitle, projectNameFromCwd } from "../../lib/session-title";

/** One session with its estimated USD spend, ready to render + sort. */
interface SpenderRow {
  session: SessionSummary;
  cost: number;
}

/** How many sessions to fetch (by tokens) before re-ranking by cost client-side. */
const FETCH_LIMIT = 100;
/** How many top spenders to show. */
const SHOW = 8;

/**
 * "Most expensive sessions" list for the Dashboard.
 *
 * The engine's /api/all-sessions can't sort by cost (cost isn't a stored column —
 * it's derived per-model from token usage). So we fetch the top sessions by raw
 * TOKENS (a strong proxy), estimate each one's USD with the shared pricing helper,
 * then re-rank by that estimate client-side and show the top few. Clicking a row
 * opens the session in the Browse transcript.
 */
export function TopSpenders({
  onOpenSession,
}: {
  /** Open a session in the Browse view: (projectId, sessionId). */
  onOpenSession?: (projectId: string, sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .allSessions({ sort: "tokens", limit: FETCH_LIMIT })
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

  // Estimate cost per session, then sort by it (desc) and take the top SHOW.
  const rows = useMemo<SpenderRow[]>(() => {
    if (!sessions) return [];
    return sessions
      .map((s) => ({ session: s, cost: costUsd(s.model, s.usage) }))
      .filter((r) => r.cost > 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, SHOW);
  }, [sessions]);

  if (error) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
        Top spenders aren't available on this server yet.
      </div>
    );
  }
  if (sessions === null) {
    return (
      <div className="flex h-24 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/30">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="text-[12px] text-zinc-600">No session spend to show yet.</div>;
  }

  const maxCost = Math.max(...rows.map((r) => r.cost));

  return (
    <div className="flex flex-col divide-y divide-zinc-800/60 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
      {rows.map(({ session: s, cost }) => {
        const project = projectNameFromCwd(s.cwd) ?? "unknown";
        const open = () => onOpenSession?.(s.projectId, s.sessionId);
        return (
          <button
            key={s.sessionId}
            onClick={open}
            disabled={!onOpenSession}
            className="group relative flex items-center gap-3 px-3.5 py-2.5 text-left transition hover:bg-zinc-800/40 disabled:cursor-default"
            title={s.cwd ?? undefined}
          >
            {/* Cost bar behind the row, relative to the priciest session. */}
            <span
              className="pointer-events-none absolute inset-y-0 left-0 bg-violet-500/5"
              style={{ width: `${(cost / maxCost) * 100}%` }}
              aria-hidden
            />
            <Coins className="relative h-3.5 w-3.5 shrink-0 text-violet-400/80" />
            <div className="relative min-w-0 flex-1">
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
                <span className="tabular-nums">{compactNumber(totalUsageTokens(s))} tok</span>
              </div>
            </div>
            <div className="relative shrink-0 text-[13px] font-semibold tabular-nums text-violet-300">
              {formatUsd(cost)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Sum the four token buckets of a session's usage. */
function totalUsageTokens(s: SessionSummary): number {
  const u = s.usage;
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}
