import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, RefreshCw, Timer } from "lucide-react";
import type { AutomationJob, AutomationsGroup, AutomationsResponse } from "../lib/types";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/utils";
import { EmptyState, LoadErrorState, Spinner } from "./ui";

/** How often to re-poll /api/automations (paused while the tab is hidden).
 * The server caches for 45s server-side, so polling faster than that just
 * re-serves the same cached payload — 30s keeps the UI feeling live without
 * adding real load. */
const POLL_MS = 30_000;

/** Future-facing counterpart to lib/format.ts's `relativeTime` (which only
 * speaks in the past — "3m ago"). Same compact style, but for "in 42m". */
function relativeFuture(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = then - nowMs;
  if (diff <= 0) return "due now";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  return `in ${day}d`;
}

/** Status dot + label styling, mirroring LiveOpsBoard's `statusStyle`. */
function statusStyle(status: AutomationJob["status"]): { dot: string; text: string; label: string } {
  switch (status) {
    case "active":
      return { dot: "bg-clay-500 animate-pulse", text: "text-clay-300", label: "active" };
    case "failed":
      return { dot: "bg-red-500", text: "text-red-300", label: "failed" };
    case "staged":
      return { dot: "bg-amber-400", text: "text-amber-300", label: "staged" };
    case "enabled":
      return { dot: "bg-emerald-500", text: "text-emerald-300", label: "enabled" };
    default:
      return { dot: "bg-zinc-500", text: "text-zinc-400", label: status || "unknown" };
  }
}

/** One job row: status dot, name, purpose, schedule, next/last run. Skimmable
 * in one glance — no click needed to see whether a job is healthy. */
/** The server's placeholder for a job with no description comment. Swapped for
 * a friendlier label — "(undocumented)" reads like a raw internal marker. */
const NO_PURPOSE = "(undocumented)";

function JobRow({ job, nowMs }: { job: AutomationJob; nowMs: number }) {
  const style = statusStyle(job.status);
  const purpose = job.purpose && job.purpose !== NO_PURPOSE ? job.purpose : "No description";
  return (
    <div
      className={cn(
        // NOTE: CSS grid-template-columns takes a SPACE-separated track list, not
        // comma-separated — `grid-cols-[a,b,c]` compiles to an invalid value that
        // the browser drops entirely, silently falling back to a single column
        // (every child stacks full-width, ~200px tall for one job). Tailwind's
        // arbitrary-value syntax uses `_` for a literal space.
        "grid grid-cols-[auto_1.4fr_1.6fr_1fr_0.9fr_0.9fr] items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2.5",
        job.status === "failed" && "bg-red-500/[0.04] ring-1 ring-red-500/20",
      )}
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", style.dot)} title={style.label} />

      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium text-zinc-100" title={job.id}>
          {job.id}
        </div>
        <div className={cn("text-[10.5px] capitalize", style.text)}>{style.label}</div>
      </div>

      <div className="min-w-0 truncate text-[12px] text-zinc-400" title={purpose}>
        {purpose}
      </div>

      <div className="truncate text-[11.5px] text-zinc-500" title={job.schedule_human ?? undefined}>
        {job.schedule_human ?? "—"}
      </div>

      <div className="flex items-center gap-1 text-[11.5px] text-zinc-400" title={job.next_run ?? undefined}>
        <Timer className="h-3 w-3 shrink-0 text-zinc-600" />
        {relativeFuture(job.next_run, nowMs)}
      </div>

      <div className="flex items-center gap-1 text-[11.5px] text-zinc-500" title={job.last_run ?? undefined}>
        <Clock className="h-3 w-3 shrink-0 text-zinc-700" />
        {relativeTime(job.last_run)}
      </div>
    </div>
  );
}

/** One host's section: a header (host badge + reachability) and its sorted
 * job rows, or an "unreachable" empty state when the host couldn't be probed
 * (e.g. M1 asleep, Tailscale down, generator not installed there yet). */
function HostSection({ group, nowMs }: { group: AutomationsGroup; nowMs: number }) {
  // next_run ascending; jobs with no next_run (no schedule info) sort last.
  const sorted = group.jobs.slice().sort((a, b) => {
    const ta = a.next_run ? new Date(a.next_run).getTime() : Infinity;
    const tb = b.next_run ? new Date(b.next_run).getTime() : Infinity;
    return ta - tb;
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] font-semibold text-zinc-300">
          {group.host}
        </span>
        {group.reachable ? (
          <span className="text-[11px] text-zinc-500">{sorted.length} jobs</span>
        ) : (
          <span
            className="flex items-center gap-1 text-[11px] text-amber-300"
            // Humanize: the raw probe failure (e.g. a `zsh: … bad interpreter`
            // shell error) is kept in the tooltip, never dumped verbatim inline.
            title={group.error ? `Automation host unavailable: ${group.error}` : "Automation host unavailable"}
          >
            <AlertTriangle className="h-3 w-3" />
            unreachable
          </span>
        )}
      </div>

      {group.reachable && sorted.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 py-6 text-center text-[12px] text-zinc-500">
          No automations found on {group.host}.
        </div>
      ) : group.reachable ? (
        <div className="flex flex-col gap-1.5">
          {sorted.map((job) => (
            <JobRow key={job.id} job={job} nowMs={nowMs} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Scheduled Jobs / Automations dashboard: every launchd automation across the
 * fleet (M5 = this DevHub host, M1 = OpenClaw), grouped by host, sorted by
 * how soon each fires next. A status dot makes health skimmable at a glance:
 * green = enabled and idle, clay/pulsing = actively running, amber = staged
 * (not yet wired up), red = its last run failed.
 *
 * Auto-refreshes on an interval (paused while the tab is hidden, matching
 * LiveOpsBoard's pattern) since the server-side cache makes frequent polling
 * cheap.
 */
export function AutomationsBoard() {
  const [data, setData] = useState<AutomationsResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    setRefreshing(true);
    setLoadError(false);
    api
      .automations()
      .then((r) => {
        if (aliveRef.current) {
          setData(r);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (aliveRef.current) setLoadError(true);
      })
      .finally(() => {
        if (aliveRef.current) setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      load();
    };
    const start = () => {
      if (timer != null) return;
      tick();
      timer = setInterval(tick, POLL_MS);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Advance the relative-time clock once every 10s (cheap; keeps "in 42m"
  // labels from going stale between polls without re-rendering every second).
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const totalJobs = (data?.groups ?? []).reduce((n, g) => n + g.jobs.length, 0);
  const failedCount = (data?.groups ?? []).reduce(
    (n, g) => n + g.jobs.filter((j) => j.status === "failed").length,
    0,
  );

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-100">
            <Timer className="h-4 w-4 text-clay-400" />
            Scheduled Jobs
          </h1>
          {data ? (
            <span className="text-[12px] text-zinc-500">
              {totalJobs} automations
              {failedCount > 0 ? (
                <span className="ml-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-300">
                  {failedCount} failed
                </span>
              ) : null}
            </span>
          ) : null}
          <button
            onClick={load}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-200"
            title="Refresh now"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>

        {loadError ? (
          <LoadErrorState
            message="Couldn't load scheduled jobs."
            onRetry={load}
            retrying={refreshing}
          />
        ) : data == null ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : totalJobs === 0 && data.groups.every((g) => g.reachable) ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 py-14">
            <EmptyState
              icon={<Timer className="h-10 w-10" />}
              title="No automations found"
              hint="launchd jobs matching ai.6thsense.*, com.ronak.*, dev.6thsense.*, dev.ronak.*, or ai.openclaw.* show up here."
            />
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {data.groups.map((group) => (
              <HostSection key={group.host} group={group} nowMs={nowMs} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
