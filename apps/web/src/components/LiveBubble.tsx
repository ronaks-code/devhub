import { memo, useEffect, useSyncExternalStore } from "react";
import { Markdown } from "./Markdown";

/**
 * A tiny external store holding the in-flight assistant turn's streamed text.
 *
 * Why this exists: streaming a token used to call setItems on ChatPane, which
 * re-rendered the entire (virtualized) message list and every MessageView on
 * every delta. Routing deltas through this store instead means an incoming token
 * only notifies LiveBubble — the finalized messages above it never re-render.
 *
 * The store is intentionally minimal: one accumulated string + a version counter
 * so useSyncExternalStore can cheaply detect changes. ChatPane owns one instance
 * per pane (in a ref); LiveBubble subscribes to it.
 */
export class LiveStream {
  private text = "";
  private listeners = new Set<() => void>();
  /** Bumped on every mutation so getSnapshot returns a new identity to subscribers. */
  private version = 0;
  private snapshot: { text: string; version: number } = { text: "", version: 0 };

  /** Append streamed text and notify subscribers. */
  append(chunk: string): void {
    this.text += chunk;
    this.commit();
  }

  /** Reset to empty (start/end of a turn). No-op-cheap when already empty. */
  reset(): void {
    if (this.text === "") return;
    this.text = "";
    this.commit();
  }

  /** Current accumulated text (used by ChatPane when finalizing the bubble). */
  current(): string {
    return this.text;
  }

  private commit(): void {
    this.version++;
    this.snapshot = { text: this.text, version: this.version };
    for (const l of this.listeners) l();
  }

  // ---- useSyncExternalStore wiring (stable references) ----
  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };
  getSnapshot = (): { text: string; version: number } => this.snapshot;
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
  const { text, version } = useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot,
  );

  // After the new text paints, ask the pane to keep us in view (it no-ops when
  // the user has scrolled up). Keyed on `version` so it fires once per delta.
  useEffect(() => {
    onGrow?.();
  }, [version, onGrow]);

  return (
    <div className="group flex gap-3 px-4 py-2.5">
      <div className="mt-1 w-0.5 shrink-0 rounded-full bg-zinc-600" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-300">Claude</span>
        </div>
        <div className="space-y-0.5">
          {text ? <Markdown text={text} /> : null}
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-clay-400 align-middle" />
        </div>
      </div>
    </div>
  );
});
