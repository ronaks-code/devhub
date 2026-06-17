import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Cpu,
  RadioTower,
  RefreshCw,
} from "lucide-react";
import type { RunningSession } from "../lib/types";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Badge, EmptyState, Spinner } from "./ui";

/** How often to re-poll /api/running (paused while the tab is hidden). */
const POLL_MS = 4000;

/** Last path segment of a working directory (the "project" name). */
function lastSegment(cwd: string | null): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

/**
 * Map a running-session status to a dot/badge/border color. `needsYou` (a stuck
 * waiting session) gets the loudest treatment so it floats to the eye.
 */
function statusStyle(s: RunningSession): {
  dot: string;
  text: string;
  ring: string;
  label: string;
} {
  if (s.needsYou) {
    return {
      dot: "bg-amber-400 animate-pulse",
      text: "text-amber-300",
      ring: "ring-amber-500/40",
      label: "needs you",
    };
  }
  const status = s.status.toLowerCase();
  if (status === "busy") {
    return { dot: "bg-clay-500 animate-pulse", text: "text-clay-300", ring: "ring-zinc-800", label: "busy" };
  }
  if (status === "waiting") {
    return { dot: "bg-amber-400", text: "text-amber-300", ring: "ring-amber-500/20", label: "waiting" };
  }
  if (status === "idle") {
    return { dot: "bg-zinc-500", text: "text-zinc-400", ring: "ring-zinc-800", label: "idle" };
  }
  return { dot: "bg-sky-400", text: "text-sky-300", ring: "ring-zinc-800", label: status || "running" };
}

/** Human "elapsed since" for an epoch-ms timestamp (compact: 5s / 3m / 2h). */
function elapsed(sinceMs: number | null | undefined, nowMs: number): string {
  if (!sinceMs) return "—";
  const sec = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/** A single running-session card. */
function OpsCard({
  s,
  nowMs,
  onOpen,
}: {
  s: RunningSession;
  nowMs: number;
  onOpen?: (cwd: string | null, sessionId: string) => void;
}) {
  const style = statusStyle(s);
  const project = s.name || lastSegment(s.cwd);
  const canOpen = !!onOpen && !!s.sessionId;

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3.5 ring-1 transition",
        style.ring,
        s.needsYou && "bg-amber-500/[0.04]",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", style.dot)} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100" title={project}>
          {project}
        </span>
        <span className={cn("shrink-0 text-[11px] font-medium capitalize", style.text)}>
          {style.label}
        </span>
      </div>

      {s.cwd ? (
        <div className="truncate text-[11px] text-zinc-600" title={s.cwd} dir="rtl">
          {s.cwd}
        </div>
      ) : null}

      {/* What a waiting session is blocked on, when reported. */}
      {s.waitingFor ? (
        <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate" title={s.waitingFor}>
            {s.waitingFor}
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {s.model ? (
          <Badge title="Model">
            <Cpu className="h-3 w-3" />
            {s.model}
          </Badge>
        ) : null}
        <span className="text-[11px] text-zinc-500" title="Elapsed since start">
          {elapsed(s.startedAt, nowMs)} elapsed
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-2">
        <button
          onClick={() => canOpen && onOpen!(s.cwd, s.sessionId)}
          disabled={!canOpen}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11.5px] font-medium text-zinc-200 ring-1 ring-zinc-700 transition hover:bg-zinc-700 hover:text-white disabled:opacity-40"
          title="Open this session in Browse"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          Open session
        </button>
        <span className="ml-auto font-mono text-[10px] text-zinc-700" title="Process id">
          pid {s.pid}
        </span>
      </div>
    </div>
  );
}

/**
 * A dedicated "ops" board: a live grid of currently-running Claude Code sessions
 * (polled from /api/running). Each card shows the project, a color-coded status
 * (busy / idle / waiting / needs-you), the model, elapsed time, and a quick
 * "open session" action. Auto-refreshes on an interval (paused when the tab is
 * hidden) and shows a friendly empty state when nothing is running.
 *
 * "needs you" sessions (stuck waiting on the user) are surfaced loudly and sorted
 * to the front so you notice the ones that won't make progress without you.
 */
export function LiveOpsBoard({
  onOpenSession,
}: {
  /**
   * Open a running session in Browse, given its working dir + session id. The
   * host (App) resolves the cwd to a known project before navigating.
   */
  onOpenSession?: (cwd: string | null, sessionId: string) => void;
}) {
  const [running, setRunning] = useState<RunningSession[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // A ticking "now" so elapsed labels advance smoothly between polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    setRefreshing(true);
    api
      .running()
      .then((r) => {
        if (aliveRef.current) setRunning(r);
      })
      .catch(() => {
        if (aliveRef.current && running == null) setRunning([]);
      })
      .finally(() => {
        if (aliveRef.current) setRefreshing(false);
      });
  }, [running]);

  // Poll on an interval, pausing while hidden and refreshing on return.
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
    // load is stable enough for our purposes; re-running on every `running`
    // change would reset the interval, so we intentionally key on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Advance the "elapsed" clock once a second (cheap; only re-renders this pane).
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Sort: needs-you first, then busy, then waiting, then the rest; newest start
  // breaks ties so the freshest sessions lead each group.
  const sorted = (running ?? []).slice().sort((a, b) => {
    const rank = (s: RunningSession) =>
      s.needsYou ? 0 : s.status.toLowerCase() === "busy" ? 1 : s.status.toLowerCase() === "waiting" ? 2 : 3;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  const needsYouCount = sorted.filter((s) => s.needsYou).length;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-100">
            <RadioTower className="h-4 w-4 text-clay-400" />
            Live ops
          </h1>
          {sorted.length > 0 ? (
            <span className="text-[12px] text-zinc-500">
              {sorted.length} running
              {needsYouCount > 0 ? (
                <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">
                  {needsYouCount} need you
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

        {running == null ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 py-14">
            <EmptyState
              icon={<RadioTower className="h-10 w-10" />}
              title="No sessions running right now"
              hint="Live Claude Code sessions show up here the moment they start — busy, waiting, or needing your input."
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((s) => (
              <OpsCard key={`${s.pid}:${s.sessionId}`} s={s} nowMs={nowMs} onOpen={onOpenSession} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
