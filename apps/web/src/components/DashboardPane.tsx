import { useEffect, useMemo, useState } from "react";
import { Activity, CalendarDays, Clock, Coins, Cpu, FolderGit2, LayoutDashboard, MessagesSquare, Radio, TrendingUp } from "lucide-react";
import type { DailyUsage, RunningSession, Stats } from "../lib/types";
import { api } from "../lib/api";
import { compactNumber, formatUsd, relativeTime, totalTokens } from "../lib/format";
import { costUsd } from "../lib/pricing";
import { cn } from "../lib/utils";
import { useStatsPolling } from "../hooks/useStatsPolling";
import { ModelBreakdown } from "./dashboard/ModelBreakdown";
import { PeriodSelector, type PeriodRange } from "./dashboard/PeriodSelector";
import { CalendarHeatmap, type HeatmapMetric } from "./dashboard/CalendarHeatmap";
import { HourHeatmap } from "./dashboard/HourHeatmap";
import { TopSpenders } from "./dashboard/TopSpenders";
import { ProjectLeaderboard } from "./dashboard/ProjectLeaderboard";
import { DirtyRepos } from "./dashboard/DirtyRepos";
import { Badge, EmptyState, Spinner } from "./ui";
import { DashboardSkeleton } from "./Skeleton";

/** `YYYY-MM-DD` exactly one year ago (local), for the heatmap's rollups window. */
function oneYearAgoYmd(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Sum of the four token buckets for one rolled-up day. */
function dayTokens(d: DailyUsage): number {
  return d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens;
}

/**
 * Estimated total $ for the stats window. Prefers a server-provided `costUsd`
 * (added to the engine's Stats later) and otherwise derives an estimate from the
 * aggregate token usage. Stats carries no per-model breakdown, so the fallback
 * uses costUsd's default pricing — clearly an APPROXIMATE display figure.
 */
function totalCostUsd(stats: Stats): number {
  const provided = (stats as { costUsd?: number }).costUsd;
  if (typeof provided === "number" && Number.isFinite(provided)) return provided;
  return costUsd(undefined, stats.totalUsage);
}

/** How often to re-poll running/stats/rollups (paused while the tab is hidden). */
const DASH_POLL_MS = 5000;

/** Last path segment of a working directory (the "project" name). */
function lastSegment(cwd: string | null): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

/** Map a running-session status to a dot/badge color, matching the M1/M2 palette. */
function statusColor(status: string): { dot: string; text: string } {
  const s = status.toLowerCase();
  if (s === "busy") return { dot: "bg-clay-500", text: "text-clay-300" };
  if (s === "waiting") return { dot: "bg-amber-400", text: "text-amber-300" };
  if (s === "idle") return { dot: "bg-zinc-500", text: "text-zinc-400" };
  // Anything else (e.g. "running"/"thinking") leans on the waiting/sky tone.
  return { dot: "bg-sky-400", text: "text-sky-300" };
}

function RunningCard({ s }: { s: RunningSession }) {
  const { dot, text } = statusColor(s.status);
  const project = s.name || lastSegment(s.cwd);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">
          {project}
        </span>
        <span className={cn("text-[11px] font-medium capitalize", text)}>{s.status}</span>
      </div>
      {s.cwd ? (
        <div className="truncate text-[11px] text-zinc-600" title={s.cwd} dir="rtl">
          {s.cwd}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {s.model ? <Badge title="Model">{s.model}</Badge> : null}
        {s.startedAt ? (
          <span className="text-[11px] text-zinc-500">
            started {relativeTime(new Date(s.startedAt).toISOString())}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-1 flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        <span className="text-clay-400">{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums text-zinc-100">{value}</div>
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-zinc-400">
      <span className="text-clay-400">{icon}</span>
      {children}
    </h2>
  );
}

export function DashboardPane({
  onOpenSession,
  onOpenProject,
}: {
  /** Open a session in the Browse view: (projectId, sessionId). From the App. */
  onOpenSession?: (projectId: string, sessionId: string) => void;
  /** Open a project in the Browse view by id. From the App. */
  onOpenProject?: (projectId: string) => void;
} = {}) {
  // Usage-over-time: the chosen period + the rollup days it resolves to. Defaults
  // to a 30-day window (resolved by PeriodSelector's first onChange below).
  const [period, setPeriod] = useState<PeriodRange>({ id: "30d" });
  // What the contribution heatmap colors by (sessions reads cleanest by default).
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>("sessions");

  // Auto-refreshing stats / running / period-rollups. The hook polls on an
  // interval, pauses while the tab is hidden, and refreshes on return — so
  // "running now" and the totals stay fresh without a manual reload.
  const { stats, running, rollups, rollupsError } = useStatsPolling({
    intervalMs: DASH_POLL_MS,
    since: period.since,
    until: period.until,
  });

  // The heatmap always wants ~1 year of daily activity, independent of the
  // period selector above. Fetched once (and on tab return) rather than polled
  // tightly, since a day's activity barely shifts in seconds.
  const [yearRollups, setYearRollups] = useState<DailyUsage[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      api
        .rollups(oneYearAgoYmd())
        .then((r) => {
          if (!cancelled) setYearRollups(r);
        })
        .catch(() => {
          if (!cancelled) setYearRollups([]);
        });
    };
    load();
    const onVisible = () => {
      if (typeof document === "undefined" || !document.hidden) load();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      cancelled = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, []);

  if (!stats) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
        <DashboardSkeleton />
      </div>
    );
  }

  const tokens = totalTokens(stats.totalUsage);
  const estTotalCost = totalCostUsd(stats);
  // Per-project cost estimate. Stats gives only a token count per project (no
  // model/usage split), so we apportion the total estimated cost by each
  // project's share of total tokens — enough for a relative "where the spend
  // goes" read alongside the token bars.
  const totalProjectTokens = stats.topProjects.reduce((n, p) => n + p.tokens, 0);
  const projectCost = (projTokens: number): number =>
    totalProjectTokens > 0 ? estTotalCost * (projTokens / totalProjectTokens) : 0;
  const maxProjectTokens = Math.max(1, ...stats.topProjects.map((p) => p.tokens));
  const maxDaySessions = Math.max(1, ...stats.activity.map((d) => d.sessions));
  const liveSessions = running ?? [];

  return (
    <DashboardBody
      stats={stats}
      tokens={tokens}
      estTotalCost={estTotalCost}
      projectCost={projectCost}
      maxProjectTokens={maxProjectTokens}
      maxDaySessions={maxDaySessions}
      liveSessions={liveSessions}
      period={period}
      onPeriod={setPeriod}
      rollups={rollups}
      rollupsError={rollupsError}
      yearRollups={yearRollups}
      heatmapMetric={heatmapMetric}
      onHeatmapMetric={setHeatmapMetric}
      onOpenSession={onOpenSession}
      onOpenProject={onOpenProject}
    />
  );
}

/**
 * The dashboard layout, split out so the data-loading wrapper above stays small.
 * Pure presentation over the props it's given.
 */
function DashboardBody({
  stats,
  tokens,
  estTotalCost,
  projectCost,
  maxProjectTokens,
  maxDaySessions,
  liveSessions,
  period,
  onPeriod,
  rollups,
  rollupsError,
  yearRollups,
  heatmapMetric,
  onHeatmapMetric,
  onOpenSession,
  onOpenProject,
}: {
  stats: Stats;
  tokens: number;
  estTotalCost: number;
  projectCost: (projTokens: number) => number;
  maxProjectTokens: number;
  maxDaySessions: number;
  liveSessions: RunningSession[];
  period: PeriodRange;
  onPeriod: (range: PeriodRange) => void;
  rollups: DailyUsage[] | null;
  rollupsError: boolean;
  /** ~1 year of daily usage for the contribution heatmap (null while loading). */
  yearRollups: DailyUsage[] | null;
  heatmapMetric: HeatmapMetric;
  onHeatmapMetric: (m: HeatmapMetric) => void;
  /** Open a session in the Browse view: (projectId, sessionId). */
  onOpenSession?: (projectId: string, sessionId: string) => void;
  /** Open a project in the Browse view by id. */
  onOpenProject?: (projectId: string) => void;
}) {
  // Period totals: sum the in-range days client-side. Oldest→newest for the chart.
  const usage = useMemo(() => {
    const days = rollups ? [...rollups].sort((a, b) => a.date.localeCompare(b.date)) : [];
    let tk = 0;
    let cost = 0;
    let sessions = 0;
    let maxTk = 0;
    for (const d of days) {
      const t = dayTokens(d);
      tk += t;
      cost += d.costUsd;
      sessions += d.sessions;
      if (t > maxTk) maxTk = t;
    }
    return { days, tokens: tk, cost, sessions, maxTokens: Math.max(1, maxTk) };
  }, [rollups]);

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-6">
        {/* Running now */}
        <section>
          <SectionTitle icon={<Radio className="h-3.5 w-3.5" />}>Running now</SectionTitle>
          {liveSessions.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {liveSessions.map((s) => (
                <RunningCard key={`${s.pid}:${s.sessionId}`} s={s} />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 py-10">
              <EmptyState
                icon={<MessagesSquare className="h-10 w-10" />}
                title="No sessions running right now"
                hint="Live Claude Code sessions will show up here as they start."
              />
            </div>
          )}
        </section>

        {/* Stat cards */}
        <section className="flex flex-col gap-3 sm:flex-row">
          <StatCard
            icon={<LayoutDashboard className="h-3.5 w-3.5" />}
            label="Total sessions"
            value={stats.totalSessions.toLocaleString()}
          />
          <StatCard
            icon={<FolderGit2 className="h-3.5 w-3.5" />}
            label="Projects"
            value={stats.totalProjects.toLocaleString()}
          />
          <StatCard
            icon={<Activity className="h-3.5 w-3.5" />}
            label="Total tokens"
            value={compactNumber(tokens)}
          />
          <StatCard
            icon={<Coins className="h-3.5 w-3.5" />}
            label="Est. cost"
            value={formatUsd(estTotalCost)}
          />
        </section>

        {/* Usage over time — period selector drives the rollups query + totals */}
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <SectionTitle icon={<TrendingUp className="h-3.5 w-3.5" />}>Usage over time</SectionTitle>
            <PeriodSelector value={period.id} onChange={onPeriod} />
          </div>

          {/* Period totals (summed client-side from the in-range days). */}
          <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px]">
            <span className="flex items-baseline gap-1.5">
              <span className="text-zinc-500">Tokens</span>
              <span className="font-semibold tabular-nums text-zinc-100">
                {compactNumber(usage.tokens)}
              </span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="text-zinc-500">Est. cost</span>
              <span className="font-semibold tabular-nums text-clay-300">
                {formatUsd(usage.cost)}
              </span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="text-zinc-500">Sessions</span>
              <span className="font-semibold tabular-nums text-zinc-100">
                {usage.sessions.toLocaleString()}
              </span>
            </span>
          </div>

          {rollupsError ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
              Usage rollups aren't available on this server yet.
            </div>
          ) : rollups === null ? (
            <div className="flex h-28 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/30">
              <Spinner className="h-5 w-5" />
            </div>
          ) : usage.days.length > 0 ? (
            <div className="flex h-28 items-end gap-0.5 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
              {usage.days.map((d) => {
                const t = dayTokens(d);
                return (
                  <div
                    key={d.date}
                    className="group flex h-full min-w-0 flex-1 items-end"
                    title={`${d.date}: ${compactNumber(t)} tokens · ${formatUsd(d.costUsd)} · ${d.sessions} session${d.sessions === 1 ? "" : "s"}`}
                  >
                    <div
                      className="w-full rounded-sm bg-clay-500/70 transition group-hover:bg-clay-400"
                      style={{ height: `${Math.max(t > 0 ? 6 : 2, (t / usage.maxTokens) * 100)}%` }}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
              No usage in this period.
            </div>
          )}
        </section>

        {/* Contribution heatmap — 12 months of daily activity, GitHub-style. */}
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <SectionTitle icon={<CalendarDays className="h-3.5 w-3.5" />}>Activity heatmap</SectionTitle>
            <div className="inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800">
              {(["sessions", "tokens"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => onHeatmapMetric(m)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition",
                    heatmapMetric === m
                      ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                      : "text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          {yearRollups === null ? (
            <div className="flex h-32 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/30">
              <Spinner className="h-5 w-5" />
            </div>
          ) : (
            <CalendarHeatmap days={yearRollups} metric={heatmapMetric} />
          )}
        </section>

        {/* When you work — time-of-day × day-of-week session heatmap. Self-loads
            its own recent-session sample (rollups only know calendar days, not
            the hour), bucketed in the browser's local timezone. */}
        <section>
          <SectionTitle icon={<Clock className="h-3.5 w-3.5" />}>When you work</SectionTitle>
          <HourHeatmap />
        </section>

        {/* Per-model breakdown */}
        <section>
          <SectionTitle icon={<Cpu className="h-3.5 w-3.5" />}>By model</SectionTitle>
          <ModelBreakdown models={stats.byModel} />
        </section>

        {/* Top projects */}
        <section>
          <SectionTitle icon={<FolderGit2 className="h-3.5 w-3.5" />}>Top projects</SectionTitle>
          {stats.topProjects.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              {stats.topProjects.map((p) => (
                <div key={p.projectId} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className="min-w-0 truncate font-medium text-zinc-200">{p.name}</span>
                    <span className="flex shrink-0 items-baseline gap-2 tabular-nums text-zinc-500">
                      <span className="text-clay-300/90" title="estimated cost">
                        {formatUsd(projectCost(p.tokens))}
                      </span>
                      <span>{compactNumber(p.tokens)}</span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-zinc-800">
                    <div
                      className="h-full rounded-full bg-clay-500"
                      style={{ width: `${(p.tokens / maxProjectTokens) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-zinc-600">No project usage yet.</div>
          )}
        </section>

        {/* Project leaderboard — sortable table (cost / tokens / sessions /
            last active) across every project; click a row to open it. */}
        <section>
          <SectionTitle icon={<FolderGit2 className="h-3.5 w-3.5" />}>Project leaderboard</SectionTitle>
          <ProjectLeaderboard onOpenProject={onOpenProject} />
        </section>

        {/* Dirty repos — projects with uncommitted git changes, most-changed
            first; click a row to open it. Queries each project's git status with
            capped concurrency and skips non-repos. */}
        <section>
          <SectionTitle icon={<FolderGit2 className="h-3.5 w-3.5" />}>Uncommitted changes</SectionTitle>
          <DirtyRepos onOpenProject={onOpenProject} />
        </section>

        {/* Top spenders — most expensive sessions (est. cost, click to open) */}
        <section>
          <SectionTitle icon={<Coins className="h-3.5 w-3.5" />}>Top spenders</SectionTitle>
          <TopSpenders onOpenSession={onOpenSession} />
        </section>

        {/* Activity (30 days) */}
        <section>
          <SectionTitle icon={<Activity className="h-3.5 w-3.5" />}>Activity (30 days)</SectionTitle>
          {stats.activity.length > 0 ? (
            <div className="flex h-28 items-end gap-1 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
              {stats.activity.map((d) => (
                <div
                  key={d.date}
                  className="group flex h-full min-w-0 flex-1 items-end"
                  title={`${d.date}: ${d.sessions} session${d.sessions === 1 ? "" : "s"}`}
                >
                  <div
                    className="w-full rounded-sm bg-clay-500/70 transition group-hover:bg-clay-400"
                    style={{
                      height: `${Math.max(d.sessions > 0 ? 6 : 2, (d.sessions / maxDaySessions) * 100)}%`,
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-zinc-600">No recent activity.</div>
          )}
        </section>
      </div>
    </div>
  );
}
