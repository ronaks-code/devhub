/**
 * Dashboard screen for the terminal face. Proves the "one brain, many faces"
 * design once more: it reads everything IN-PROCESS from the SAME
 * `@claude-ui/engine` — no HTTP server.
 *
 * Two panels:
 *   - Running sessions: live `claude` processes (engine.getRunningSessions),
 *     colored by status, with "needs you" floated to the top.
 *   - Headline stats: totals (sessions/projects/tokens), approximate total
 *     spend, and the top projects by token volume (engine.getStats).
 *
 * Keys:
 *   - r  → refresh (re-reads running sessions + stats)
 *   - esc / h → back to browse
 *
 * Running sessions come from ephemeral `<pid>.json` files and are async, so we
 * load them in an effect; stats are computed synchronously from the local
 * index. Both are re-fetched on `r`.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Engine } from "@claude-ui/engine";
import type { RunningSession, Stats } from "@claude-ui/engine/types";

const VISIBLE_RUNNING = 8; // running-sessions window height
const TOP_PROJECTS = 5; // how many top projects to list

/** Status → color. Mirrors the web face's running-session legend. */
function statusColor(s: RunningSession): string {
  if (s.needsYou) return "#d97757"; // blocked on the user — Claude orange, stands out
  switch (s.status) {
    case "busy":
      return "green";
    case "idle":
      return "cyan";
    case "waiting":
      return "yellow";
    case "dead":
      return "red";
    default:
      return "gray";
  }
}

/** Compact token count: 12_345_678 → "12.3M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** USD with two decimals, e.g. "$12.34". */
function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function totalTokens(u: Stats["totalUsage"]): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/** "5m", "2h", "3d" since `ts` (epoch ms); "" when unknown. */
function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function Dashboard({ engine, onExit }: { engine: Engine; onExit: () => void }) {
  const [running, setRunning] = useState<RunningSession[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  // Monotonic counter forces an effect re-run on every `r` press.
  const [tick, setTick] = useState(0);
  // Captured once per load so all "ago" labels share a consistent clock.
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNow(Date.now());
    // Stats are synchronous (local SQLite); running sessions are async (PID files).
    const nextStats = engine.getStats();
    engine
      .getRunningSessions({ needsYouFirst: true })
      .then((sessions) => {
        if (cancelled) return;
        setRunning(sessions);
        setStats(nextStats);
      })
      .catch(() => {
        if (cancelled) return;
        // Even if the PID dir read fails, still show stats with an empty list.
        setRunning([]);
        setStats(nextStats);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, tick]);

  useInput((input, key) => {
    if (key.escape || input === "h") {
      onExit();
      return;
    }
    if (input === "r") refresh();
  });

  const runWindow = running.slice(0, VISIBLE_RUNNING);
  const hiddenRunning = Math.max(0, running.length - VISIBLE_RUNNING);

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        Dashboard
      </Text>

      {/* Running sessions */}
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray" bold>
          Running sessions{loading ? " · loading…" : ` · ${running.length}`}
        </Text>
        {!loading && running.length === 0 ? (
          <Text color="gray">No live sessions.</Text>
        ) : (
          runWindow.map((s) => <RunningRow key={`${s.pid}:${s.sessionId}`} s={s} now={now} />)
        )}
        {hiddenRunning > 0 && <Text color="gray">  …{hiddenRunning} more</Text>}
      </Box>

      {/* Headline stats */}
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray" bold>
          Stats
        </Text>
        {stats === null ? (
          <Text color="gray">loading…</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text color="cyan">{stats.totalSessions}</Text>
              <Text color="gray"> sessions · </Text>
              <Text color="cyan">{stats.totalProjects}</Text>
              <Text color="gray"> projects · </Text>
              <Text color="cyan">{fmtTokens(totalTokens(stats.totalUsage))}</Text>
              <Text color="gray"> tokens · ~</Text>
              <Text color="green">{fmtUsd(stats.totalCostUsd)}</Text>
              <Text color="gray"> (est.)</Text>
            </Text>

            <Box marginTop={1}>
              <Text color="gray">Top projects</Text>
            </Box>
            {stats.topProjects.length === 0 ? (
              <Text color="gray">  —</Text>
            ) : (
              stats.topProjects.slice(0, TOP_PROJECTS).map((p) => (
                <Text key={p.projectId} wrap="truncate-end">
                  <Text color="gray">  </Text>
                  <Text>{p.name.slice(0, 28).padEnd(28)}</Text>
                  <Text color="cyan"> {fmtTokens(p.tokens).padStart(7)}</Text>
                  <Text color="gray"> · </Text>
                  <Text color="green">{fmtUsd(p.costUsd)}</Text>
                </Text>
              ))
            )}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          r refresh · esc/h back · q quit
        </Text>
      </Box>
    </Box>
  );
}

function RunningRow({ s, now }: { s: RunningSession; now: number }) {
  const color = statusColor(s);
  const label = (s.name || s.sessionId).slice(0, 32);
  const cwd = s.cwd ? s.cwd.replace(/^.*\//, "") : "?"; // basename of cwd
  const since = ago(s.statusUpdatedAt ?? s.updatedAt, now);
  const tag = s.needsYou ? "needs you" : s.status;
  const why = s.needsYou && s.waitingFor ? ` (${s.waitingFor})` : "";
  return (
    <Text wrap="truncate-end">
      <Text color={color}>● </Text>
      <Text color={s.needsYou ? "#d97757" : undefined}>{label.padEnd(32)}</Text>
      <Text color="gray"> {cwd.slice(0, 18).padEnd(18)} </Text>
      <Text color={color}>{tag}</Text>
      <Text color="gray">{why}</Text>
      {since ? <Text color="gray"> · {since}</Text> : null}
    </Text>
  );
}
