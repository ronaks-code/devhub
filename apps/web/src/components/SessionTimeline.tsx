import { useEffect, useMemo, useRef } from "react";
import { Play, Pause, SkipBack, SkipForward, X, AlertCircle, Wrench } from "lucide-react";
import type { NormalizedMessage } from "../lib/types";
import { cn } from "../lib/utils";

/**
 * A turn-by-turn replay scrubber for a transcript. It turns a session into a
 * horizontal timeline whose ticks are message boundaries; dragging the scrubber
 * (or stepping prev/next, or hitting play) reveals the transcript progressively
 * up to that point, so you can "watch" how the session unfolded.
 *
 * Plain words: a scrub bar like a video player, but for a chat. Slide it and the
 * conversation fills in up to where you are. Press play and it walks forward on
 * its own. Little marks on the bar flag where tools ran or something errored, so
 * you can jump straight to the interesting moments.
 *
 * This component owns ONLY the bar UI + the play timer. The host owns the reveal
 * count (`value`) and slices its own message list to it, so the existing full
 * view is preserved untouched — timeline mode is purely additive on top.
 *
 * `value` is a 1-based count of revealed messages (0 = nothing, length = all).
 * The host renders `messages.slice(0, value)`. Markers are derived from the SAME
 * (paired + filtered) list the host renders, so positions line up exactly.
 */

/** How a message reads on the timeline (drives its tick color). */
type TickKind = "user" | "assistant" | "tool" | "error" | "other";

/** Classify a message for its timeline tick. Errors win, then tools, then role. */
function classify(m: NormalizedMessage): TickKind {
  let hasTool = false;
  for (const b of m.blocks) {
    if (b.type === "tool_result" && b.isError) return "error";
    if (b.type === "tool_use") hasTool = true;
    // A paired tool_use carries its result; surface its error too.
    const paired = b as { result?: { isError?: boolean } };
    if (b.type === "tool_use" && paired.result?.isError) return "error";
  }
  if (hasTool) return "tool";
  if (m.role === "user") return "user";
  if (m.role === "assistant") return "assistant";
  return "other";
}

const TICK_COLOR: Record<TickKind, string> = {
  user: "bg-clay-500",
  assistant: "bg-zinc-500",
  tool: "bg-[var(--dh-provider-openai)]",
  error: "bg-red-500",
  other: "bg-zinc-700",
};

/** Default play cadence — one message every 700ms feels like a readable replay. */
const PLAY_INTERVAL_MS = 700;

export function SessionTimeline({
  messages,
  value,
  onChange,
  playing,
  onPlayingChange,
  onClose,
}: {
  /** The SAME paired+filtered list the host renders, so tick positions align. */
  messages: NormalizedMessage[];
  /** 1-based count of revealed messages (host renders messages.slice(0, value)). */
  value: number;
  onChange: (next: number) => void;
  /** Whether the auto-advance "play" is running (host-owned so it can pause it). */
  playing: boolean;
  onPlayingChange: (next: boolean) => void;
  onClose: () => void;
}) {
  const count = messages.length;
  // Clamp the host's value into range so a filter change (shrinking the list)
  // never leaves the scrubber past the end.
  const revealed = Math.max(0, Math.min(value, count));

  // Per-message tick metadata. Memoized so dragging doesn't re-derive each frame.
  const ticks = useMemo(() => messages.map(classify), [messages]);

  // Auto-advance while playing: reveal one more message per tick, stopping (and
  // clearing `playing`) once the whole transcript is shown.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!playing) return;
    // Already at the end → don't start; flip play off so the button resets.
    if (revealed >= count) {
      onPlayingChange(false);
      return;
    }
    intervalRef.current = setInterval(() => {
      onChange(Math.min(revealed + 1, count));
    }, PLAY_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // Re-arm whenever the revealed count advances so the closure reads fresh state.
  }, [playing, revealed, count, onChange, onPlayingChange]);

  // Stop playing the instant we reach the end.
  useEffect(() => {
    if (playing && revealed >= count) onPlayingChange(false);
  }, [playing, revealed, count, onPlayingChange]);

  const atStart = revealed <= 0;
  const atEnd = revealed >= count;

  const step = (delta: number) => {
    onPlayingChange(false);
    onChange(Math.max(0, Math.min(revealed + delta, count)));
  };

  // The label under the scrubber: which turn we're parked on (the last revealed).
  const current = revealed > 0 ? messages[revealed - 1] : null;

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-zinc-800/80 bg-zinc-900/40 px-5 py-2.5">
      <div className="flex items-center gap-1">
        <button
          onClick={() => step(-1)}
          disabled={atStart}
          className="rounded-md p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
          title="Previous message"
          aria-label="Previous message"
        >
          <SkipBack className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => {
            // From the end, replay restarts from the top.
            if (atEnd) onChange(0);
            onPlayingChange(!playing);
          }}
          className={cn(
            "rounded-md p-1 transition",
            playing
              ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
          )}
          title={playing ? "Pause replay" : "Play replay"}
          aria-label={playing ? "Pause replay" : "Play replay"}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={() => step(1)}
          disabled={atEnd}
          className="rounded-md p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
          title="Next message"
          aria-label="Next message"
        >
          <SkipForward className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* The scrubber: a native range over the message index, with a tick strip
          layered behind it so tool/error/role markers show where things happen. */}
      <div className="relative min-w-0 flex-1">
        {/* Tick strip — one colored sliver per message, dimmed past the playhead. */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex h-3 -translate-y-1/2 items-stretch gap-px overflow-hidden rounded">
          {ticks.map((kind, i) => (
            <span
              key={i}
              className={cn(
                "min-w-0 flex-1 transition-opacity",
                TICK_COLOR[kind],
                i < revealed ? "opacity-90" : "opacity-25",
              )}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={count}
          step={1}
          value={revealed}
          onChange={(e) => {
            onPlayingChange(false);
            onChange(Number(e.target.value));
          }}
          className="relative z-10 h-3 w-full cursor-pointer appearance-none bg-transparent accent-clay-500"
          aria-label="Replay position"
          aria-valuetext={`${revealed} of ${count} messages`}
        />
      </div>

      {/* Position read-out + the current turn's role chip. */}
      <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-zinc-500">
        <span className="text-zinc-300">{revealed}</span>
        <span>/</span>
        <span>{count}</span>
        {current ? (
          <span className="inline-flex items-center gap-1 text-zinc-600">
            {classify(current) === "error" ? (
              <AlertCircle className="h-3 w-3 text-red-400" />
            ) : classify(current) === "tool" ? (
              <Wrench className="h-3 w-3 text-[var(--dh-provider-openai)]" />
            ) : null}
            {current.role}
          </span>
        ) : (
          <span className="text-zinc-600">start</span>
        )}
      </div>

      <button
        onClick={onClose}
        className="shrink-0 rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        title="Exit replay (show full transcript)"
        aria-label="Exit replay"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
