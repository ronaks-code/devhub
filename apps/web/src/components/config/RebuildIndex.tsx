import { useEffect, useRef, useState } from "react";
import { Check, DatabaseZap, Loader2, RefreshCw } from "lucide-react";
import { api, NotImplementedError, subscribeEvents } from "../../lib/api";
import { cn } from "../../lib/utils";

/**
 * Settings control: force a full re-index of every transcript (POST /api/reindex).
 *
 * Plain words: an everyday index only re-reads files that changed on disk, so the
 * NEW analytics signal (per-tool error rates + durations) and a session's model
 * never get filled in for OLD sessions that haven't changed. This button re-reads
 * everything so those gaps backfill — after it finishes, ToolAnalytics shows real
 * error/duration numbers and older sessions get their model.
 *
 * The server kicks the pass off in the BACKGROUND and acks immediately; the real
 * progress streams over the EXISTING /api/events SSE (`index-progress` / `ready`)
 * that the app already listens to. We subscribe to that same stream here so the
 * button reflects live "indexing N/total" progress, disables itself while a pass
 * is running, and shows a brief "Done" confirmation when the `ready` event lands.
 *
 * Resilient: an older server that hasn't shipped the route 404s, which the
 * api.reindex *Maybe helper maps to a NotImplementedError — we catch it and hide
 * the whole control rather than leaving a button that can't work.
 */
export function RebuildIndex() {
  // True once the route has answered 404/501 — hides the control on older servers.
  const [unavailable, setUnavailable] = useState(false);
  // True from the moment we POST until the index settles (a `ready` SSE arrives).
  // Also flips true if an index-progress event shows up while we're "running", so
  // a reindex someone else kicked off keeps the button honestly disabled.
  const [running, setRunning] = useState(false);
  // Live progress from the SSE, or null when we don't have a number yet.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Set briefly after a reindex WE started finishes, to show a "Done" line.
  const [doneAt, setDoneAt] = useState<number | null>(null);

  // Whether THIS control initiated the in-flight pass — so we only show "Done" for
  // our own reindex, not for an unrelated startup index that happens to finish.
  const startedRef = useRef(false);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Watch the same engine event stream the app uses. `index-progress` carries the
  // live N/total; `ready` means the index settled. Both kinds are in the engine's
  // published EngineEvent union, so this type-checks without any shim.
  useEffect(() => {
    const unsub = subscribeEvents((e) => {
      if (e.kind === "index-progress") {
        setProgress({ done: e.done, total: e.total });
        // A pass is clearly running — reflect it even if we didn't start it.
        setRunning(true);
      } else if (e.kind === "ready") {
        setProgress(null);
        setRunning(false);
        if (startedRef.current) {
          startedRef.current = false;
          setDoneAt(Date.now());
          if (doneTimer.current) clearTimeout(doneTimer.current);
          doneTimer.current = setTimeout(() => setDoneAt(null), 4000);
        }
      }
    });
    return () => {
      unsub();
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
  }, []);

  const onClick = async () => {
    if (running) return;
    setRunning(true);
    setDoneAt(null);
    startedRef.current = true;
    try {
      await api.reindex();
      // The 202 ack only means the pass STARTED; we keep `running` true and let the
      // SSE `ready` event flip it back off (and trigger the "Done" line).
    } catch (err) {
      // Older server without the route → hide the control entirely. Any other
      // failure → don't get stuck "indexing" forever; reset and let the user retry.
      startedRef.current = false;
      setRunning(false);
      if (err instanceof NotImplementedError) setUnavailable(true);
    }
  };

  if (unavailable) return null;

  return (
    <section className="mt-6 space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
      <div className="flex items-center gap-2">
        <DatabaseZap className="h-4 w-4 text-zinc-500" />
        <h2 className="text-[13px] font-semibold text-zinc-200">Search index</h2>
      </div>
      <p className="-mt-1 text-[11.5px] leading-relaxed text-zinc-600">
        Rebuilding re-reads every transcript so newer analytics backfill for older
        sessions: per-tool <span className="text-zinc-400">error rates</span> and{" "}
        <span className="text-zinc-400">durations</span> in the dashboard, plus the
        model on sessions indexed before it was tracked. It runs in the background —
        you can keep working while it indexes.
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={onClick}
          disabled={running}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[13px] font-medium ring-1 transition",
            running
              ? "cursor-not-allowed bg-zinc-900 text-zinc-500 ring-zinc-800"
              : "bg-zinc-900 text-zinc-200 ring-zinc-700 hover:bg-zinc-800 hover:text-zinc-100",
          )}
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {running ? "Indexing…" : "Rebuild index"}
        </button>
        {running && progress ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] tabular-nums text-clay-300">
            {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
          </span>
        ) : null}
        {!running && doneAt ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400">
            <Check className="h-3.5 w-3.5" />
            Index rebuilt
          </span>
        ) : null}
      </div>
    </section>
  );
}
