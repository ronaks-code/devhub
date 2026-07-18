import { useEffect, useMemo, useRef, useState } from "react";
import {
  GitCompareArrows,
  X,
  Coins,
  MessageSquare,
  DollarSign,
  Clock,
  Cpu,
  Wrench,
  ChevronDown,
} from "lucide-react";
import { api } from "../lib/api";
import type { ContentBlock, NormalizedMessage, SessionMessagesPage, SessionSummary } from "../lib/types";
import { displaySessionTitle } from "../lib/session-title";
import { MessageView } from "./MessageView";
import { Spinner } from "./ui";
import { compactNumber, formatUsd, totalTokens } from "../lib/format";
import { costUsd } from "../lib/pricing";
import { pairToolResults } from "../lib/transcript";
import { cn } from "../lib/utils";

/**
 * Side-by-side comparison of TWO sessions, opened from the sessions list or the
 * transcript header. The LEFT column is the session you came from; the RIGHT one
 * you pick from the same project (or any loaded session). Each column renders the
 * real transcript via {@link MessageView} — exactly like the Browse viewer, so
 * nothing here re-implements message rendering — under a stats strip that diffs
 * the two at a glance: model, message count, tokens, est. cost, duration, and the
 * distinct tools each used.
 *
 * Plain words: a split screen to put two chats next to each other. Handy for
 * "did the rerun behave differently?" or "how did two approaches to the same task
 * diverge?". It's strictly READ-ONLY — no edits, no resume, no writes.
 *
 * It's a self-contained modal (its own fetches + Escape/backdrop close, focus
 * restore), so the host only has to mount it with the left session + the candidate
 * list. Both pages load on demand and tail-paired so tool cards render as one unit.
 */

/** Selector matching every focusable node, for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A compact roll-up of one session's transcript, for the diff strip. */
interface ColumnStats {
  model: string | null;
  messageCount: number;
  tokens: number;
  costUsd: number;
  /** Wall-clock span first→last message, in ms (null when undatable). */
  durationMs: number | null;
  /** Distinct tool names used, sorted. */
  tools: string[];
}

/** Format a duration (ms) compactly: "—" / "42s" / "5m" / "1h 3m". */
function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/** Distinct tool names used across a message list (tool_use blocks), sorted. */
function toolsUsed(messages: NormalizedMessage[]): string[] {
  const names = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_use") {
        const name = (b as Extract<ContentBlock, { type: "tool_use" }>).name;
        if (name) names.add(name);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Wall-clock span between the first and last datable message in the page. */
function durationMs(messages: NormalizedMessage[]): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const m of messages) {
    if (!m.timestamp) continue;
    const t = new Date(m.timestamp).getTime();
    if (Number.isNaN(t)) continue;
    if (first == null || t < first) first = t;
    if (last == null || t > last) last = t;
  }
  return first != null && last != null ? last - first : null;
}

/** Roll up a loaded page into the stats the diff strip shows. */
function statsFor(page: SessionMessagesPage): ColumnStats {
  const s = page.session;
  return {
    model: s.model,
    messageCount: s.messageCount,
    tokens: totalTokens(s.usage),
    costUsd: s.costUsd || costUsd(s.model, s.usage),
    durationMs: durationMs(page.messages),
    tools: toolsUsed(page.messages),
  };
}

/** One transcript column: header + scrollable, tail-paired MessageView list. */
function TranscriptColumn({
  page,
  loading,
  side,
}: {
  page: SessionMessagesPage | null;
  loading: boolean;
  /** "left" | "right" — only affects the divider so the two columns read as a pair. */
  side: "left" | "right";
}) {
  // Pair tool_use ⇄ tool_result so each tool call renders as one card, exactly
  // like the Browse viewer does.
  const messages = useMemo(() => pairToolResults(page?.messages ?? []), [page?.messages]);
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col", side === "left" && "border-r border-zinc-800")}>
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      ) : !page ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] text-zinc-600">
          Pick a session to compare.
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] text-zinc-600">
          No messages in this session.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {messages.map((m, i) => (
            <div key={m.uuid ?? m.seq} className="border-b border-zinc-900/70">
              <MessageView m={m} prevTimestamp={messages[i - 1]?.timestamp ?? null} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A single stat cell shown twice (one per column) in the diff strip. */
function StatCell({
  icon,
  left,
  right,
  diff,
}: {
  icon: React.ReactNode;
  left: React.ReactNode;
  right: React.ReactNode;
  /** Highlight clay when the two sides differ, to draw the eye to what changed. */
  diff: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[11.5px]">
      <span className="text-zinc-600">{icon}</span>
      <span className={cn("tabular-nums", diff ? "text-clay-300" : "text-zinc-300")}>{left}</span>
      <span className="text-zinc-700">vs</span>
      <span className={cn("tabular-nums", diff ? "text-clay-300" : "text-zinc-300")}>{right}</span>
    </div>
  );
}

export function SessionCompare({
  /** The session the user came from (the left column). */
  baseSession,
  /** Candidate sessions to compare against (e.g. the active project's list). */
  sessions,
  onClose,
}: {
  baseSession: SessionSummary;
  sessions: SessionSummary[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const [leftPage, setLeftPage] = useState<SessionMessagesPage | null>(null);
  const [leftLoading, setLeftLoading] = useState(true);
  // The picked right-hand session id (default: the first OTHER session, if any).
  const otherSessions = useMemo(
    () => sessions.filter((s) => s.sessionId !== baseSession.sessionId),
    [sessions, baseSession.sessionId],
  );
  const [rightId, setRightId] = useState<string | null>(() => otherSessions[0]?.sessionId ?? null);
  const [rightPage, setRightPage] = useState<SessionMessagesPage | null>(null);
  const [rightLoading, setRightLoading] = useState(false);

  // Load the base (left) transcript once on mount.
  useEffect(() => {
    let cancelled = false;
    setLeftLoading(true);
    api
      .messages(baseSession.sessionId)
      .then((p) => {
        if (!cancelled) setLeftPage(p);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLeftLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseSession.sessionId]);

  // Load the picked (right) transcript whenever the selection changes.
  useEffect(() => {
    if (!rightId) {
      setRightPage(null);
      return;
    }
    let cancelled = false;
    setRightLoading(true);
    setRightPage(null);
    api
      .messages(rightId)
      .then((p) => {
        if (!cancelled) setRightPage(p);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRightLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rightId]);

  // Focus management: remember prior focus, move into the dialog, restore on close.
  useEffect(() => {
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    const raf = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      restoreRef.current?.focus?.();
    };
  }, []);

  // Escape to close + a focus trap that keeps Tab cycling within the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const leftStats = leftPage ? statsFor(leftPage) : null;
  const rightStats = rightPage ? statsFor(rightPage) : null;

  // The set of tools used by exactly one side, to label the "tools" diff usefully.
  const toolsDiffer =
    !!leftStats &&
    !!rightStats &&
    (leftStats.tools.length !== rightStats.tools.length ||
      leftStats.tools.some((t, i) => t !== rightStats.tools[i]));

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-compare-title"
        className="flex h-full w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-5 py-3">
          <GitCompareArrows className="h-4 w-4 text-clay-400" />
          <h2 id="session-compare-title" className="text-[14px] font-semibold text-zinc-100">
            Compare sessions
          </h2>
          <span className="text-[11px] text-zinc-600">read-only</span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
            aria-label="Close comparison"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Title row: the base session (left) and the picker (right). */}
        <div className="flex shrink-0 items-stretch border-b border-zinc-800">
          <div className="min-w-0 flex-1 border-r border-zinc-800 px-5 py-2.5">
            <div
              className="truncate text-[13px] font-medium text-zinc-200"
              title={displaySessionTitle(baseSession)}
            >
              {displaySessionTitle(baseSession)}
            </div>
          </div>
          <div className="min-w-0 flex-1 px-5 py-2.5">
            {otherSessions.length === 0 ? (
              <div className="text-[12.5px] text-zinc-600">No other session in this project to compare.</div>
            ) : (
              <div className="relative inline-flex w-full items-center">
                <select
                  value={rightId ?? ""}
                  onChange={(e) => setRightId(e.target.value || null)}
                  className="w-full appearance-none truncate rounded-lg bg-zinc-900 py-1.5 pl-2.5 pr-8 text-[13px] font-medium text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
                  aria-label="Session to compare against"
                >
                  {otherSessions.map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {displaySessionTitle(s)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-zinc-500" />
              </div>
            )}
          </div>
        </div>

        {/* Diff strip — model / counts / tokens / cost / duration / tools, two-up. */}
        {leftStats && rightStats ? (
          <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1.5 border-b border-zinc-800 bg-zinc-900/30 px-5 py-3 sm:grid-cols-3">
            <StatCell
              icon={<Cpu className="h-3.5 w-3.5" />}
              left={leftStats.model ?? "—"}
              right={rightStats.model ?? "—"}
              diff={leftStats.model !== rightStats.model}
            />
            <StatCell
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              left={`${leftStats.messageCount} msgs`}
              right={`${rightStats.messageCount} msgs`}
              diff={leftStats.messageCount !== rightStats.messageCount}
            />
            <StatCell
              icon={<Coins className="h-3.5 w-3.5" />}
              left={`${compactNumber(leftStats.tokens)} tok`}
              right={`${compactNumber(rightStats.tokens)} tok`}
              diff={leftStats.tokens !== rightStats.tokens}
            />
            <StatCell
              icon={<DollarSign className="h-3.5 w-3.5" />}
              left={formatUsd(leftStats.costUsd)}
              right={formatUsd(rightStats.costUsd)}
              diff={Math.abs(leftStats.costUsd - rightStats.costUsd) > 0.0001}
            />
            <StatCell
              icon={<Clock className="h-3.5 w-3.5" />}
              left={formatDuration(leftStats.durationMs)}
              right={formatDuration(rightStats.durationMs)}
              diff={leftStats.durationMs !== rightStats.durationMs}
            />
            <StatCell
              icon={<Wrench className="h-3.5 w-3.5" />}
              left={`${leftStats.tools.length} tools`}
              right={`${rightStats.tools.length} tools`}
              diff={toolsDiffer}
            />
          </div>
        ) : null}

        {/* The two transcripts, side by side. */}
        <div className="flex min-h-0 flex-1">
          <TranscriptColumn page={leftPage} loading={leftLoading} side="left" />
          <TranscriptColumn page={rightPage} loading={rightLoading} side="right" />
        </div>
      </div>
    </div>
  );
}
