import { memo, useEffect, useSyncExternalStore } from "react";
import { Brain } from "lucide-react";
import { Markdown } from "./Markdown";

/** The accumulated streamed state for one in-flight turn (text + thinking). */
interface LiveSnapshot {
  /** Visible assistant answer streamed so far. */
  text: string;
  /** Reasoning/thinking streamed so far (rendered dimmed, above the answer). */
  thinking: string;
  /** Bumped on every mutation so useSyncExternalStore detects a change cheaply. */
  version: number;
}

/**
 * A tiny external store holding the in-flight assistant turn's streamed text AND
 * thinking.
 *
 * Why this exists: streaming a token used to call setItems on ChatPane, which
 * re-rendered the entire (virtualized) message list and every MessageView on
 * every delta. Routing deltas through this store instead means an incoming token
 * only notifies LiveBubble — the finalized messages above it never re-render.
 *
 * The store is intentionally minimal: two accumulated strings (answer + thinking)
 * plus a version counter so useSyncExternalStore can cheaply detect changes.
 * ChatPane owns one instance per pane (in a ref); LiveBubble subscribes to it.
 */
export class LiveStream {
  private text = "";
  private thinking = "";
  private listeners = new Set<() => void>();
  /** Bumped on every mutation so getSnapshot returns a new identity to subscribers. */
  private version = 0;
  private snapshot: LiveSnapshot = { text: "", thinking: "", version: 0 };

  /** Append streamed answer text and notify subscribers. */
  append(chunk: string): void {
    this.text += chunk;
    this.commit();
  }

  /** Append streamed thinking text and notify subscribers. */
  appendThinking(chunk: string): void {
    this.thinking += chunk;
    this.commit();
  }

  /** Reset to empty (start/end of a turn). No-op-cheap when already empty. */
  reset(): void {
    if (this.text === "" && this.thinking === "") return;
    this.text = "";
    this.thinking = "";
    this.commit();
  }

  /** Current accumulated answer text (used by ChatPane when finalizing the bubble). */
  current(): string {
    return this.text;
  }

  private commit(): void {
    this.version++;
    this.snapshot = { text: this.text, thinking: this.thinking, version: this.version };
    for (const l of this.listeners) l();
  }

  // ---- useSyncExternalStore wiring (stable references) ----
  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };
  getSnapshot = (): LiveSnapshot => this.snapshot;
}

/**
 * The streaming assistant bubble, isolated into its own memoized component that
 * subscribes to a {@link LiveStream}. Rendered by ChatPane for the in-flight turn
 * only; finalized messages render as stable MessageViews above it. An incoming
 * token re-renders just this component — not the message list.
 *
 * Mirrors the assistant message chrome in MessageView (label bar + blinking
 * cursor) so the bubble looks identical before and after it finalizes.
 */
export const LiveBubble = memo(function LiveBubble({
  stream,
  onGrow,
}: {
  stream: LiveStream;
  /** Called after each delta renders, so the pane can follow the tail if pinned. */
  onGrow?: () => void;
}) {
  const { text, thinking, version } = useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot,
  );

  // After the new text paints, ask the pane to keep us in view (it no-ops when
  // the user has scrolled up). Keyed on `version` so it fires once per delta.
  useEffect(() => {
    onGrow?.();
  }, [version, onGrow]);

  // While only thinking has streamed (no visible answer yet), the cursor rides
  // the thinking block; once the answer starts it moves down to the answer.
  const answerStarted = text.length > 0;

  return (
    <div className="group flex gap-3 px-4 py-2.5">
      <div className="mt-1 w-0.5 shrink-0 rounded-full bg-zinc-600" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-300">Claude</span>
        </div>
        {/* Live thinking: a dimmed, italic "thinking…" block that streams
            reasoning tokens above the answer. It's replaced by the finalized
            message (which carries its own collapsible thinking block) the moment
            the turn completes — ChatPane resets the stream in the same commit. */}
        {thinking ? (
          <div className="mb-1.5 rounded-lg border border-zinc-800/60 bg-zinc-900/20 px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Brain className="h-3 w-3 animate-pulse" />
              <span className="italic">thinking…</span>
            </div>
            <div className="text-[12.5px] italic leading-relaxed text-zinc-500">
              <Markdown text={thinking} className="text-zinc-500" />
              {!answerStarted ? (
                <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-zinc-600 align-middle" />
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="space-y-0.5">
          {text ? <Markdown text={text} /> : null}
          {answerStarted || !thinking ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-clay-400 align-middle" />
          ) : null}
        </div>
      </div>
    </div>
  );
});
