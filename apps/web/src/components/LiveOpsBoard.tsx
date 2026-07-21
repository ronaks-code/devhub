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
  indexSessions,
  lastSegment,
  type OpsBucket,
  type OpsEntry,
} from "./features/ops/opsHelpers";

/** The four Attention-Board columns, left→right (the "what needs my eyes" order). */
const COLUMNS: ReadonlyArray<{ bucket: OpsBucket; label: string; tint: string; dot: string }> = [
  { bucket: "needsYou", label: "Needs you", tint: "bg-amber-500/[0.05]", dot: "bg-amber-400" },
  { bucket: "running", label: "Running", tint: "", dot: "bg-[var(--dh-brand)]" },
  { bucket: "stale", label: "Stale · Failed", tint: "bg-rose-500/[0.05]", dot: "bg-rose-400" },
  { bucket: "finished", label: "Recently finished", tint: "", dot: "bg-[var(--dh-text-dim)]" },
];

/** A compact Attention-Board card — the dense form of the Glass-Grid card. */
function BoardCard({
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
  const sub = entry.branch ? `⎇ ${entry.branch}` : project;

  return (
    <div className="glass-card flex flex-col gap-1.5 p-2.5">
      <div className="flex items-center gap-2">
        <StatusDot status={bucketStatusKind(bucket)} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--dh-text-strong)]" title={entry.title}>
          {entry.title}
        </span>
        {entry.provider ? <ProviderChip provider={entry.provider} /> : null}
      </div>

      <div className="dh-mono-ui flex items-center gap-2 text-[var(--dh-text-muted)]">
        <span className="min-w-0 flex-1 truncate" title={s.cwd ?? undefined}>
          {sub}
        </span>
        {entry.costUsd != null ? (
          <span className="inline-flex shrink-0 items-center gap-1" title="Session cost (estimate)">
            <Coins className="h-3 w-3" />
            {formatUsd(entry.costUsd)}
          </span>
        ) : null}
      </div>

      {/* One status line. */}
      {bucket === "needsYou" ? (
        <div className="flex items-center gap-1 text-[11px] text-amber-300">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate" title={s.waitingFor ?? undefined}>
            {s.waitingFor ?? "waiting on you"}
          </span>
        </div>
      ) : bucket === "stale" ? (
        <div className="flex items-center gap-1 text-[11px] text-rose-300">
          <XCircle className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">silent {agoMs(s.statusUpdatedAt ?? s.updatedAt, nowMs)}</span>
        </div>
      ) : bucket === "finished" ? (
        <div className="text-[11px] text-[var(--dh-text-dim)]">awaiting review</div>
      ) : (
        <div className="dh-mono-ui truncate text-[var(--dh-text-muted)]">running {agoMs(s.startedAt, nowMs)}</div>
      )}

      {canOpen ? (
        <button
          type="button"
          onClick={() => onOpen!(s.cwd, s.sessionId)}
          className="mt-0.5 inline-flex items-center gap-1 self-start rounded-[7px] bg-[var(--dh-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--dh-text)] ring-1 ring-[var(--dh-glass-border)] transition hover:ring-[var(--dh-glass-border-hi)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dh-focus)]"
        >
          <ArrowUpRight className="h-3 w-3" />
          Open
        </button>
      ) : null}
    </div>
  );
}

/** One board column: header (dot + label + count) over a stack of compact cards. */
function BoardColumn({
  column,
  entries,
  nowMs,
  onOpen,
}: {
  column: (typeof COLUMNS)[number];
  entries: OpsEntry[];
  nowMs: number;
  onOpen?: (cwd: string | null, sessionId: string) => void;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5 rounded-[16px] p-2.5", column.tint)}>
      <div className="flex items-center gap-2 px-1">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", column.dot)} aria-hidden />
        <span className="dh-label flex-1">{column.label}</span>
        <span className="dh-nums rounded-full bg-[var(--dh-control)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--dh-text-muted)]">
          {entries.length}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {entries.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-[var(--dh-border-subtle)] px-3 py-4 text-center text-[11px] text-[var(--dh-text-dim)]">
            None
          </div>
        ) : (
          entries.map((entry) => (
            <BoardCard
              key={`${entry.running.pid}:${entry.running.sessionId}`}
              entry={entry}
              nowMs={nowMs}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Live Ops — the Attention Board (Aurora Cockpit §3.7): the "what needs my eyes"
 * signal, split into four columns — Needs you / Running / Stale·Failed / Recently
 * finished. Each card is the compact form of the Glass-Grid card. Reads the SAME
 * app-root running poll the shell already runs (no competing poll), joined to the
 * indexed sessions for cost/title/branch. Clicking Open routes to the session.
 */
export function LiveOpsBoard({
  running,
  sessions,
  onOpenSession,
  onRefresh,
}: {
  /** Live running sessions from the app-root poll (`useStatsPolling`). Null = still loading. */
  running?: RunningSession[] | null;
  /** Indexed sessions, joined by sessionId for cost/title/branch. */
  sessions?: readonly SessionSummary[];
  /** Open a running session in Browse, given its cwd + session id. */
  onOpenSession?: (cwd: string | null, sessionId: string) => void;
  /** Force an immediate refresh of the app-root poll. */
  onRefresh?: () => void;
} = {}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const sessionsById = useMemo(() => indexSessions(sessions), [sessions]);
  const entries = useMemo(() => buildOpsEntries(running, sessionsById), [running, sessionsById]);

  const byBucket = useMemo(() => {
    const map: Record<OpsBucket, OpsEntry[]> = { needsYou: [], running: [], stale: [], finished: [] };
    for (const e of entries) map[e.bucket].push(e);
    return map;
  }, [entries]);

  const runningCount = byBucket.running.length;
  const needsYouCount = byBucket.needsYou.length;
  const staleCount = byBucket.stale.length;

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
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {COLUMNS.map((column) => (
              <BoardColumn
                key={column.bucket}
                column={column}
                entries={byBucket[column.bucket]}
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
