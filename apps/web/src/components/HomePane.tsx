import { useEffect, useState } from "react";
import { Bot, Cpu, MessageSquarePlus } from "lucide-react";
import { api, codexApi } from "../lib/api";
import type { SessionSummary } from "../lib/types";
import type { CodexSession, CodexStats } from "../lib/types";
import { Spinner } from "./ui";

/** Last path segment of a working directory path. */
function lastSegment(cwd: string | null | undefined): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

/** Simple relative-time helper — no external deps. */
function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Count sessions whose last activity falls in the last N days. */
function countRecent(sessions: SessionSummary[], days: number): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return sessions.filter((s) => {
    const t = s.lastTimestamp ? new Date(s.lastTimestamp).getTime() : 0;
    return t >= cutoff;
  }).length;
}

interface UnifiedItem {
  kind: "claude" | "codex";
  id: string;
  cwd: string | null;
  startedAt: string | null;
  model: string | null;
}

interface StatCardProps {
  label: string;
  value: number | string;
  sub?: string;
}

function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-zinc-100">{value}</span>
      {sub ? <span className="text-[11px] text-zinc-500">{sub}</span> : null}
    </div>
  );
}

export function HomePane({ onNewChat }: { onNewChat: () => void }) {
  const [claudeSessions, setClaudeSessions] = useState<SessionSummary[]>([]);
  const [codexSessions, setCodexSessions] = useState<CodexSession[]>([]);
  const [codexStats, setCodexStats] = useState<CodexStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.allSettled([
      // Fetch all sessions across projects for Claude stats
      api.projects().then(async (projects) => {
        const all: SessionSummary[] = [];
        await Promise.allSettled(
          projects.map((p) =>
            api.sessions(p.id).then((ss) => {
              all.push(...ss);
            }),
          ),
        );
        return all;
      }),
      codexApi.sessions(),
      codexApi.stats(),
    ]).then(([claudeResult, codexResult, statsResult]) => {
      if (cancelled) return;
      if (claudeResult.status === "fulfilled") setClaudeSessions(claudeResult.value);
      if (codexResult.status === "fulfilled" && !(codexResult.value instanceof Error)) {
        setCodexSessions(codexResult.value as CodexSession[]);
      }
      if (statsResult.status === "fulfilled" && !(statsResult.value instanceof Error)) {
        setCodexStats(statsResult.value as CodexStats);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Build unified timeline: last 20 items interleaved by date
  const unified: UnifiedItem[] = [
    ...claudeSessions.map((s): UnifiedItem => ({
      kind: "claude",
      id: s.sessionId,
      cwd: s.projectId ?? null,
      startedAt: s.lastTimestamp ?? null,
      model: s.model ?? null,
    })),
    ...codexSessions.map((s): UnifiedItem => ({
      kind: "codex",
      id: s.id,
      cwd: s.cwd,
      startedAt: s.startedAt,
      model: s.model,
    })),
  ]
    .sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 20);

  const claudeThisMonth = countRecent(claudeSessions, 30);
  const codexThisMonth = codexStats?.last30Days ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950 px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Home</h1>
        <p className="mt-1 text-sm text-zinc-500">Your AI coding workspace</p>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {/* Stats row */}
          <div>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wide text-zinc-500">
              Overview
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Claude — this month"
                value={claudeThisMonth}
                sub="sessions"
              />
              <StatCard
                label="Codex — this month"
                value={codexThisMonth}
                sub="sessions"
              />
              <StatCard
                label="Total Claude"
                value={claudeSessions.length}
                sub="all time"
              />
              <StatCard
                label="Total Codex"
                value={codexStats?.totalSessions ?? codexSessions.length}
                sub="all time"
              />
            </div>
          </div>

          {/* Recent Activity */}
          <div>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wide text-zinc-500">
              Recent Activity
            </h2>
            {unified.length === 0 ? (
              <p className="text-sm text-zinc-600">No recent activity yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-zinc-800/60 rounded-xl border border-zinc-800 bg-zinc-900/20">
                {unified.map((item) => {
                  const isClaude = item.kind === "claude";
                  return (
                    <div
                      key={`${item.kind}-${item.id}`}
                      className="flex items-center gap-3 px-4 py-3"
                    >
                      {/* Icon */}
                      {isClaude ? (
                        <Bot className="h-4 w-4 shrink-0 text-clay-400" />
                      ) : (
                        <Cpu className="h-4 w-4 shrink-0 text-sky-400" />
                      )}

                      {/* Tool badge */}
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          isClaude
                            ? "bg-clay-500/15 text-clay-300"
                            : "bg-sky-500/15 text-sky-300"
                        }`}
                      >
                        {isClaude ? "Claude" : "Codex"}
                      </span>

                      {/* cwd */}
                      <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">
                        {lastSegment(item.cwd)}
                      </span>

                      {/* Model */}
                      {item.model ? (
                        <span className="shrink-0 text-[11px] text-zinc-600 hidden sm:block">
                          {item.model}
                        </span>
                      ) : null}

                      {/* Time */}
                      <span className="shrink-0 text-[11px] text-zinc-500">
                        {relTime(item.startedAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick Start */}
          <div>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wide text-zinc-500">
              Quick Start
            </h2>
            <button
              onClick={onNewChat}
              className="inline-flex items-center gap-2 rounded-lg bg-clay-500/15 px-4 py-2.5 text-[13px] font-medium text-clay-300 ring-1 ring-clay-500/30 transition hover:bg-clay-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
            >
              <MessageSquarePlus className="h-4 w-4" />
              New Claude Session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
