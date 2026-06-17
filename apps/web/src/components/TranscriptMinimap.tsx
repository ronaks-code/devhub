import { useMemo } from "react";
import type { NormalizedMessage } from "../lib/types";
import { cn } from "../lib/utils";

/**
 * A thin vertical minimap beside the transcript: color ticks laid out
 * proportionally so the whole conversation fits the viewport height. Ticks are
 * colored by role (matching MessageView's accent bars) and click-to-scroll jumps
 * the virtualized list to that message. A highlighted band tracks the currently-
 * active message (the find match / search jump) so the reader sees "where am I".
 *
 * Purely an overview affordance — it never owns scroll state; it calls back into
 * the host's virtualizer (onJump) to move. Errors get a brighter red tick so
 * trouble spots pop out of the overview.
 *
 * For long transcripts we BUCKET messages into at most {@link MAX_TICKS} ticks
 * (each tick covering a contiguous range), so a 5,000-message session renders a
 * fixed, small number of DOM nodes. A bucket is red if ANY message in it errored,
 * and takes the role of its first message; clicking jumps to that first message.
 */

const MAX_TICKS = 240;

const ROLE_TICK: Record<string, string> = {
  user: "bg-clay-500",
  assistant: "bg-zinc-500",
  system: "bg-zinc-700",
  hook: "bg-sky-700",
  queue: "bg-amber-700",
  attachment: "bg-zinc-700",
  meta: "bg-zinc-800",
};

/** True when a message carries an errored tool_result (drives the red tick). */
function hasError(m: NormalizedMessage): boolean {
  return m.blocks.some(
    (b) => b.type === "tool_result" && (b as { isError?: boolean }).isError === true,
  );
}

interface Tick {
  /** Message index this tick jumps to (the bucket's first message). */
  index: number;
  /** Last message index covered (for active-range matching). */
  end: number;
  role: string;
  error: boolean;
}

export function TranscriptMinimap({
  messages,
  activeIndex,
  onJump,
  className,
}: {
  messages: NormalizedMessage[];
  /** The message index to highlight (active find match / search jump), or null. */
  activeIndex?: number | null;
  /** Scroll the transcript to a message by index. */
  onJump: (index: number) => void;
  className?: string;
}) {
  // Build the (possibly bucketed) tick list. One tick per message when small;
  // contiguous buckets when the transcript exceeds MAX_TICKS.
  const ticks = useMemo<Tick[]>(() => {
    const n = messages.length;
    if (n === 0) return [];
    const bucketCount = Math.min(n, MAX_TICKS);
    const per = n / bucketCount;
    const out: Tick[] = [];
    for (let b = 0; b < bucketCount; b++) {
      const start = Math.floor(b * per);
      const end = Math.min(n - 1, Math.floor((b + 1) * per) - 1);
      let error = false;
      for (let i = start; i <= end; i++) {
        if (hasError(messages[i]!)) {
          error = true;
          break;
        }
      }
      out.push({ index: start, end, role: messages[start]!.role, error });
    }
    return out;
  }, [messages]);

  if (ticks.length === 0) return null;

  return (
    <div
      className={cn(
        "flex w-3 shrink-0 flex-col gap-px border-l border-zinc-900/70 bg-zinc-950 py-1",
        className,
      )}
      role="navigation"
      aria-label="Transcript overview"
    >
      {ticks.map((t) => {
        const active =
          activeIndex != null && activeIndex >= t.index && activeIndex <= t.end;
        return (
          <button
            key={t.index}
            onClick={() => onJump(t.index)}
            title={`${t.role}${t.error ? " · error" : ""} — message ${t.index + 1}`}
            aria-label={`Jump to message ${t.index + 1} (${t.role})`}
            className={cn(
              "mx-auto block w-full flex-1 rounded-[1px] transition-opacity hover:opacity-100",
              t.error ? "bg-red-500" : (ROLE_TICK[t.role] ?? "bg-zinc-700"),
              active ? "opacity-100 ring-1 ring-clay-400/70" : "opacity-50",
            )}
            style={{ minHeight: 1 }}
          />
        );
      })}
    </div>
  );
}
