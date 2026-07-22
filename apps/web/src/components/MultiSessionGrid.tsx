import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowUpRight, Coins, RadioTower, RefreshCw, XCircle } from "lucide-react";
import type { RunningSession, SessionSummary } from "../lib/types";
import { formatUsd } from "../lib/format";
import { cn } from "../lib/utils";
import { EmptyState, Spinner } from "./ui";
import { StatusDot } from "./ui/StatusDot";
import { ProviderChip } from "./ui/ProviderChip";
import {
  agoMs,
  buildOpsEntries,
  bucketStatusKind,
  filterOpsEntries,
  indexSessions,
  lastSegment,
  type OpsEntry,
  type OpsFilter,
} from "./features/ops/opsHelpers";
import { OpsFilterChips } from "./features/ops/OpsFilterChips";

/**
 * Keep only ONE entry per sessionId (first wins — the server already sorts and
 * dedupes, so this is a defensive mirror for older servers). Cards and counts are
 * keyed by sessionId here, so a duplicated id would produce duplicate React keys
 * and a count that disagrees with the Attention Board. Entries with an empty
 * sessionId aren't identifiable and pass through.
 */
export function dedupeBySessionId(sessions: RunningSession[]): RunningSession[] {
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (!s.sessionId) return true;
    if (seen.has(s.sessionId)) return false;
    seen.add(s.sessionId);
    return true;
  });
}

/** The 3px left edge-light color per bucket (violet=busy, red=dead, amber=needs-you, none=idle). */
const EDGE_LIGHT: Record<OpsEntry["bucket"], string> = {
  running: "linear-gradient(180deg, #818cf8, #6366f1)",
  stale: "linear-gradient(180deg, #ff6b5e, #f2708c)",
  needsYou: "linear-gradient(180deg, #f0b25e, #e59a4e)",
  finished: "transparent",
};

/** The status glow shadow per bucket (busy/dead get a faint colored halo). */
const EDGE_GLOW: Record<OpsEntry["bucket"], string | undefined> = {
  running: "0 0 0 1px rgba(167,139,250,.14), 0 14px 40px -18px rgba(139,108,240,.5)",
  stale: "0 0 0 1px rgba(255,107,94,.18), 0 14px 40px -18px rgba(255,107,94,.4)",
  needsYou: "0 0 0 1px rgba(240,178,94,.2), 0 14px 40px -18px rgba(240,178,94,.35)",
  finished: undefined,
};

/**
 * One Glass-Grid card: a live running session joined to its indexed session for
 * cost/title. Shows a status edge-light + dot + title + provider chip, a status
 * BANNER (not a fake terminal tail — a `RunningSession` carries no output stream),
 * and a footer with the worktree/cwd + cost. The whole card opens the session.
 */
function GlassCard({
  entry,
  nowMs,
  onOpen,
}: {
  entry: OpsEntry;
  nowMs: number;
  onOpen?: (cwd: string | null, sessionId: string) => void;
}) {
  const { running: s, bucket } = entry;
  const project = lastSegment(s.cwd);
  const canOpen = !!onOpen && !!s.sessionId;
  const duration = agoMs(s.startedAt, nowMs);
  const silenceDuration = agoMs(s.statusUpdatedAt ?? s.updatedAt, nowMs);
  const footLabel = entry.branch ?? project;

  return (
    <button
      type="button"
      onClick={() => canOpen && onOpen!(s.cwd, s.sessionId)}
      disabled={!canOpen}
      title={canOpen ? "Open this session" : undefined}
      className={cn(
        "glass-card group relative flex flex-col gap-2.5 overflow-hidden p-3.5 text-left transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dh-focus)] focus-visible:ring-offset-0",
        canOpen && "hover:-translate-y-px",
      )}
      style={EDGE_GLOW[bucket] ? { boxShadow: EDGE_GLOW[bucket] } : undefined}
    >
      {/* Status edge-light. */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-[3px]"
        style={{ background: EDGE_LIGHT[bucket] }}
      />

      {/* Header: dot + title + provider. */}
      <div className="flex items-center gap-2">
        <StatusDot status={bucketStatusKind(bucket)} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--dh-text-strong)]" title={entry.title}>
          {entry.title}
        </span>
        {entry.provider ? <ProviderChip provider={entry.provider} /> : null}
      </div>

      {/* Subline: project · status duration. */}
      <div className="dh-mono-ui truncate text-[var(--dh-text-muted)]">
        {project} · {bucket === "needsYou" ? "waiting" : bucket === "stale" ? "silent" : bucket === "finished" ? "idle" : "running"} {bucket === "stale" ? silenceDuration : duration}
      </div>

      {/* Status banner — the loudest element on the card for anything needing eyes. */}
      {bucket === "needsYou" ? (
        <div className="flex items-center gap-1.5 rounded-[8px] bg-amber-500/12 px-2.5 py-1.5 text-[11.5px] text-amber-300 ring-1 ring-amber-500/25">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={s.waitingFor ?? undefined}>
            {s.waitingFor ?? "waiting on you"}
          </span>
        </div>
      ) : bucket === "stale" ? (
        <div className="flex items-center gap-1.5 rounded-[8px] bg-rose-500/12 px-2.5 py-1.5 text-[11.5px] text-rose-300 ring-1 ring-rose-500/25">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            stale — busy but silent since {silenceDuration}
          </span>
        </div>
      ) : bucket === "finished" ? (
        <div className="rounded-[8px] px-0.5 py-1 text-[11.5px] text-[var(--dh-text-dim)]">
          finished — awaiting review
        </div>
      ) : (
        <div className="dh-mono-ui truncate px-0.5 py-1 text-[var(--dh-text-muted)]">
          {[s.model, s.entrypoint].filter(Boolean).join(" · ") || "working"} · updated {agoMs(s.updatedAt ?? s.startedAt, nowMs)}
        </div>
      )}

      {/* Footer: worktree/cwd + cost. */}
      <div className="mt-auto flex items-center gap-2 pt-0.5">
        <span className="dh-mono-ui min-w-0 flex-1 truncate text-[var(--dh-text-dim)]" title={s.cwd ?? undefined}>
          ⌥ {footLabel}
        </span>
        {entry.costUsd != null ? (
          <span className="dh-mono-ui inline-flex items-center gap-1 text-[var(--dh-text-muted)]" title="Session cost (estimate)">
            <Coins className="h-3 w-3" />
            {formatUsd(entry.costUsd)}
          </span>
        ) : null}
        {canOpen ? (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--dh-text-dim)] transition group-hover:text-[var(--dh-brand)]" />
        ) : null}
      </div>
    </button>
  );
}

/**
 * Live Ops — the Glass Grid (Aurora Cockpit §3.7). A dense 3-up grid of the
 * currently-running Claude/Codex sessions, each a glass card with a status
 * edge-light, dot, provider chip, and a status banner (needs-you / stale / busy /
 * finished). Reads the SAME app-root running poll the shell already runs (no
 * competing poll), joined to the indexed sessions for cost/title. Clicking a card
 * opens that session.
 *
 * The old "watch & drive N panels over live websockets" grid is retired here: in
 * the redesigned shell you drive a session by opening it as a chat tab (full
 * transcript + composer), so the Ops grid is a pure monitoring surface.
 */
export function MultiSessionGrid({
  running,
  sessions,
  onOpenSession,
  onRefresh,
}: {
  /** Live running sessions from the app-root poll (`useStatsPolling`). Null = still loading. */
  running?: RunningSession[] | null;
  /** Indexed sessions, joined by sessionId for cost/title/branch. */
  sessions?: readonly SessionSummary[];
  /** Open a running session, given its cwd + session id. */
  onOpenSession?: (cwd: string | null, sessionId: string) => void;
  /** Force an immediate refresh of the app-root poll. */
  onRefresh?: () => void;
} = {}) {
  // A ticking "now" so duration labels advance smoothly between polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [filter, setFilter] = useState<OpsFilter>("all");

  const sessionsById = useMemo(() => indexSessions(sessions), [sessions]);
  const entries = useMemo(() => buildOpsEntries(running, sessionsById), [running, sessionsById]);
  const visible = useMemo(() => filterOpsEntries(entries, filter), [entries, filter]);

  // Head counts stay backed by the FULL entry list (not the filtered view) so the
  // meta line always agrees with the sidebar tiers / STALE badge.
  const runningCount = entries.filter((e) => e.bucket === "running").length;
  const needsYouCount = entries.filter((e) => e.bucket === "needsYou").length;
  const staleCount = entries.filter((e) => e.bucket === "stale").length;

  return (
    <div className="dh-aurora-bg--soft min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-[17px] font-[680] tracking-[-0.01em] text-[var(--dh-text-strong)]">
            <RadioTower className="h-4 w-4 text-[var(--dh-brand)]" />
            Live Ops
          </h1>
          {entries.length > 0 ? (
            <span className="dh-mono-ui text-[var(--dh-text-muted)]">
              {entries.length} sessions · {runningCount} running · {needsYouCount} waiting on you · {staleCount} stale
            </span>
          ) : null}
          {entries.length > 0 ? (
            <OpsFilterChips entries={entries} filter={filter} onFilterChange={setFilter} />
          ) : null}
          {onRefresh ? (
            <button
              onClick={onRefresh}
              className="glass-card ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] text-[var(--dh-text-muted)] transition hover:text-[var(--dh-text)]"
              title="Refresh now"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          ) : null}
        </div>

        {running == null ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : entries.length === 0 ? (
          <div className="glass-card py-14">
            <EmptyState
              icon={<RadioTower className="h-10 w-10" />}
              title="No sessions running right now"
              hint="Live Claude Code and Codex sessions show up here the moment they start — busy, waiting, or needing your input."
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="glass-card px-4 py-10 text-center text-[12px] text-[var(--dh-text-dim)]">
            No sessions match this filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((entry) => (
              <GlassCard
                key={`${entry.running.pid}:${entry.running.sessionId}`}
                entry={entry}
                nowMs={nowMs}
                onOpen={onOpenSession}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
