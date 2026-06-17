import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { DailyUsage, RunningSession, Stats } from "../lib/types";

export interface StatsPollingData {
  stats: Stats | null;
  running: RunningSession[] | null;
  rollups: DailyUsage[] | null;
  /** True when the rollups endpoint isn't available on this server (404/501). */
  rollupsError: boolean;
}

export interface UseStatsPollingOptions {
  /** Poll interval in ms for the fast-moving data (running/stats). Default 5000. */
  intervalMs?: number;
  /** Inclusive `YYYY-MM-DD` window for the rollups query (omit for full history). */
  since?: string;
  until?: string;
  /** When false, no fetching happens at all (e.g. dashboard not visible). */
  enabled?: boolean;
}

export interface UseStatsPollingResult extends StatsPollingData {
  /** Force an immediate refresh of all three datasets. */
  refresh: () => void;
  /** True while the very first load is in flight (no data yet). */
  loading: boolean;
}

/**
 * Auto-refreshing dashboard data: stats, running sessions, and per-day rollups.
 *
 * Plain words: this keeps the dashboard "live" — it re-asks the server for the
 * numbers every few seconds so "running now" and the totals don't go stale. It's
 * polite about it: when you switch to another browser tab it STOPS polling (no
 * point burning requests on a hidden page), and the moment you come back it does
 * one immediate refresh so you see current data right away.
 *
 * Stats + running are polled on `intervalMs`. Rollups are re-fetched whenever the
 * window (since/until) changes and on the same interval, but a failure there is
 * isolated into `rollupsError` so the rest of the dashboard still updates if the
 * /api/rollups route isn't available on this server.
 */
export function useStatsPolling(options: UseStatsPollingOptions = {}): UseStatsPollingResult {
  const { intervalMs = 5000, since, until, enabled = true } = options;

  const [data, setData] = useState<StatsPollingData>({
    stats: null,
    running: null,
    rollups: null,
    rollupsError: false,
  });
  const [loading, setLoading] = useState(true);

  // Latest window values kept in a ref so the polling loop reads current bounds
  // without resubscribing the interval on every change.
  const sinceRef = useRef(since);
  const untilRef = useRef(until);
  sinceRef.current = since;
  untilRef.current = until;

  // Guards so an unmount (or a disabled toggle) can drop in-flight responses.
  const aliveRef = useRef(true);

  const loadStatsAndRunning = useCallback(() => {
    api
      .stats()
      .then((s) => {
        if (aliveRef.current) setData((d) => ({ ...d, stats: s }));
      })
      .catch(() => {})
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
    api
      .running()
      .then((r) => {
        if (aliveRef.current) setData((d) => ({ ...d, running: r }));
      })
      .catch(() => {});
  }, []);

  const loadRollups = useCallback(() => {
    api
      .rollups(sinceRef.current, untilRef.current)
      .then((r) => {
        if (aliveRef.current) setData((d) => ({ ...d, rollups: r, rollupsError: false }));
      })
      .catch(() => {
        // Any failure (incl. NotImplementedError) flags the rollups area only.
        if (aliveRef.current) setData((d) => ({ ...d, rollupsError: true }));
      });
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return;
    loadStatsAndRunning();
    loadRollups();
  }, [enabled, loadStatsAndRunning, loadRollups]);

  // Re-fetch rollups when the window changes (and we're enabled). Clearing to
  // null first shows the loading state in the consumer.
  useEffect(() => {
    if (!enabled) return;
    setData((d) => ({ ...d, rollups: null, rollupsError: false }));
    loadRollups();
  }, [enabled, since, until, loadRollups]);

  // The polling loop: fetch immediately, then on the interval — but only while
  // the tab is visible. Going hidden clears the timer; becoming visible again
  // does one immediate refresh and restarts it.
  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      // Skip work while hidden (visibilitychange restarts us when we return).
      if (typeof document !== "undefined" && document.hidden) return;
      loadStatsAndRunning();
      loadRollups();
    };

    const start = () => {
      if (timer != null) return;
      tick(); // immediate, so coming back from a hidden tab refreshes at once
      timer = setInterval(tick, intervalMs);
    };

    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (typeof document !== "undefined" && document.hidden) stop();
      else start();
    };

    // Start only if currently visible; otherwise wait for the tab to surface.
    if (typeof document === "undefined" || !document.hidden) start();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      aliveRef.current = false;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [enabled, intervalMs, loadStatsAndRunning, loadRollups]);

  return { ...data, refresh, loading };
}
