import { useEffect, useState } from "react";
import { Activity, Coins, Cpu, FolderGit2, LayoutDashboard, MessagesSquare, Radio } from "lucide-react";
import type { RunningSession, Stats } from "../lib/types";
import { api } from "../lib/api";
import { compactNumber, formatUsd, relativeTime, totalTokens } from "../lib/format";
import { costUsd } from "../lib/pricing";
import { cn } from "../lib/utils";
import { ModelBreakdown } from "./dashboard/ModelBreakdown";
import { Badge, EmptyState, Spinner } from "./ui";

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

const RUNNING_POLL_MS = 4000;

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

export function DashboardPane() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [running, setRunning] = useState<RunningSession[] | null>(null);

  // Stats once on mount; running once on mount, then poll every 4s.
  useEffect(() => {
    let cancelled = false;

    api
      .stats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {});

    const loadRunning = () => {
      api
        .running()
        .then((r) => {
          if (!cancelled) setRunning(r);
        })
        .catch(() => {});
    };
    loadRunning();
    const id = window.setInterval(loadRunning, RUNNING_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!stats) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-zinc-950">
        <Spinner className="h-6 w-6" />
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
