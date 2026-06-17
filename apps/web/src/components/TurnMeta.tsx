import { Clock } from "lucide-react";
import { cn } from "../lib/utils";

/** Format an ISO timestamp as a short wall-clock time, e.g. "10:58 PM". */
function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Format a millisecond gap compactly: "820ms", "4.2s", "1m 12s", "2h 3m". */
function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const s = Math.round(sec % 60);
    return s > 0 ? `${min}m ${s}s` : `${min}m`;
  }
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${hr}h ${m}m` : `${hr}h`;
}

/**
 * A subtle per-turn timestamp + duration strip for the transcript/chat header.
 *
 * Plain words: shows the wall-clock time a message happened ("10:58 PM"), and —
 * when this is the assistant's reply right after your prompt — how long Claude
 * took to answer (the gap between your prompt's timestamp and the reply's). Both
 * are read straight from the message timestamps the transcript already carries;
 * nothing is fetched or stored. Renders nothing when there's no usable timestamp.
 *
 * It's deliberately quiet (tiny, muted) so it sits beside the role label without
 * competing with the message content. The duration only shows when `prevTimestamp`
 * is the immediately-preceding message's time AND `showDuration` is set (so a
 * caller renders latency only on an assistant turn that followed a user prompt).
 */
export function TurnMeta({
  timestamp,
  prevTimestamp,
  showDuration = false,
  className,
}: {
  /** This message's ISO timestamp (NormalizedMessage.timestamp), may be null. */
  timestamp: string | null;
  /** The previous message's ISO timestamp, used to derive the turn duration. */
  prevTimestamp?: string | null;
  /**
   * Whether to show the duration gap (prev → this). Callers set this only on an
   * assistant turn whose previous message was the user prompt, so the gap reads
   * as "how long the reply took" rather than an arbitrary inter-message pause.
   */
  showDuration?: boolean;
  className?: string;
}) {
  if (!timestamp) return null;
  const time = clockTime(timestamp);
  if (!time) return null;

  // Duration = gap between the previous message and this one, when asked for and
  // both timestamps parse and run forward. Guards against clock-skew (negative)
  // and absurd gaps so a session left open for hours doesn't show "3h" latency.
  let gap: string | null = null;
  if (showDuration && prevTimestamp) {
    const a = new Date(prevTimestamp).getTime();
    const b = new Date(timestamp).getTime();
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const ms = b - a;
      if (ms >= 0 && ms < 6 * 60 * 60 * 1000) gap = formatGap(ms);
    }
  }

  const full = new Date(timestamp).toLocaleString();

  return (
    <span
      className={cn("inline-flex items-center gap-1 text-[10px] text-zinc-600", className)}
      title={gap ? `${full} · responded in ${gap}` : full}
    >
      <span className="tabular-nums">{time}</span>
      {gap ? (
        <span className="inline-flex items-center gap-0.5 text-zinc-500">
          <Clock className="h-2.5 w-2.5" />
          <span className="tabular-nums">{gap}</span>
        </span>
      ) : null}
    </span>
  );
}
