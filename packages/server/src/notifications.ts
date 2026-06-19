/**
 * Session notifications watcher.
 *
 * Polls the engine for currently-running sessions on a fixed interval and detects
 * two state transitions worth telling the user about:
 *
 *  - "finished": a session that was actively WORKING (status "busy"/"running") and
 *    is now gone (process exited / file removed) or has gone idle. i.e. "your task
 *    is done".
 *  - "stalled":  a session that is BLOCKED ON THE USER (status "waiting" past the
 *    engine's staleness threshold — surfaced as `needsYou`). i.e. "it needs you".
 *
 * Transitions are emitted on a server-local EventEmitter as {@link NotifyEvent}s.
 * The /api/events SSE handler forwards them to browsers as `kind: "notify"` data
 * lines; the FACE turns those into OS notifications. We deliberately add NO
 * OS-notification dependency here.
 *
 * Spam control:
 *  - Each transition fires AT MOST ONCE per session per state. We remember which
 *    sessions are currently "working" and which we've already flagged "stalled",
 *    and only emit on the edge (false -> true). A session can re-notify only after
 *    it leaves the state and re-enters it.
 *  - A global per-tick cap bounds how many events a single poll can emit, so a
 *    burst (e.g. dozens of sessions ending at once) can't flood clients.
 *  - Dead/zombie entries (`alive: false`) are ignored for "working" tracking, but a
 *    previously-working session that has gone dead counts as "finished".
 */
import type { Engine } from "@devhub/engine";
import type { RunningSession } from "@devhub/engine/types";
import { EventEmitter } from "node:events";

/**
 * A notification pushed to faces over SSE. Shaped to be JSON-forwarded verbatim as
 * an SSE `data:` line: `{ kind: "notify", event, sessionId, cwd, title?, ts }`.
 */
export interface NotifyEvent {
  kind: "notify";
  /** "finished" = was working, now done/gone. "stalled" = waiting on the user. */
  event: "finished" | "stalled";
  sessionId: string;
  /** The session's working directory (for grouping/labelling), or null if unknown. */
  cwd: string | null;
  /** Best-effort human label (the session's `name`), when the file reported one. */
  title?: string;
  /** When the watcher detected the transition (epoch ms). */
  ts: number;
}

/** How often to poll the engine for running sessions. */
export const DEFAULT_POLL_MS = 5_000;

/**
 * Most notifications a single poll may emit. A guard against a burst (e.g. many
 * sessions ending at once) flooding every connected client in one tick.
 */
export const MAX_EVENTS_PER_TICK = 20;

/** A session is "actively working" when it's alive and busy/running. */
function isWorking(s: RunningSession): boolean {
  return s.alive && (s.status === "busy" || s.status === "running");
}

/** A session is "stalled" when the engine flags it as blocked on the user. */
function isStalled(s: RunningSession): boolean {
  return s.alive && s.needsYou === true && s.status === "waiting";
}

export interface NotificationsWatcher {
  /** Server-local bus that emits "notify" with a {@link NotifyEvent} payload. */
  emitter: EventEmitter;
  /** Subscribe to notification events. Returns an unsubscribe fn. */
  on(fn: (e: NotifyEvent) => void): () => void;
  /** Stop polling and remove the interval. Safe to call more than once. */
  stop(): void;
}

/**
 * Start watching `engine.getRunningSessions()` for finished/stalled transitions.
 *
 * Returns a {@link NotificationsWatcher}: subscribe with `.on(fn)` (or listen on
 * `.emitter` for the `"notify"` event) and `.stop()` when done. The first poll only
 * SEEDS the baseline (it does not emit), so sessions already running when the server
 * starts don't all fire spurious "finished"/"stalled" notifications on boot.
 */
export function startNotificationsWatcher(
  engine: Engine,
  opts: { pollMs?: number; needsYouThresholdMs?: number } = {},
): NotificationsWatcher {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  // Sessions we last saw actively working — the set we watch for "finished".
  let working = new Set<string>();
  // Sessions we've already flagged "stalled" — so we notify only on the edge.
  const stalled = new Set<string>();
  // Last known cwd/title per session, so a "finished" event (where the session has
  // since vanished from the running list) can still carry its cwd/title.
  const lastInfo = new Map<string, { cwd: string | null; title?: string }>();
  // First poll seeds state without emitting (avoids a boot-time notification storm).
  let seeded = false;
  let stopped = false;

  const emit = (e: NotifyEvent) => emitter.emit("notify", e);

  async function tick(): Promise<void> {
    if (stopped) return;
    let sessions: RunningSession[];
    try {
      sessions = await engine.getRunningSessions(
        opts.needsYouThresholdMs !== undefined
          ? { needsYouThresholdMs: opts.needsYouThresholdMs }
          : {},
      );
    } catch {
      return; // transient read error: skip this tick, try again next interval
    }
    if (stopped) return;

    const nowWorking = new Set<string>();
    const seen = new Set<string>();
    const now = Date.now();
    let budget = MAX_EVENTS_PER_TICK;

    for (const s of sessions) {
      const id = s.sessionId;
      if (!id) continue; // can't track a session with no id
      seen.add(id);
      lastInfo.set(id, { cwd: s.cwd, title: s.name ?? undefined });

      if (isWorking(s)) nowWorking.add(id);

      // STALLED edge: not previously flagged, now blocked on the user.
      if (isStalled(s)) {
        if (!stalled.has(id)) {
          stalled.add(id);
          if (seeded && budget > 0) {
            budget--;
            emit({
              kind: "notify",
              event: "stalled",
              sessionId: id,
              cwd: s.cwd,
              title: s.name ?? undefined,
              ts: now,
            });
          }
        }
      } else {
        // No longer stalled — allow it to re-notify if it stalls again later.
        stalled.delete(id);
      }
    }

    // FINISHED edge: a session that WAS working and is now either gone from the list
    // or present-but-no-longer-working (idle/dead/waiting).
    if (seeded) {
      for (const id of working) {
        if (nowWorking.has(id)) continue; // still working, no transition
        if (budget <= 0) break;
        budget--;
        const info = lastInfo.get(id);
        emit({
          kind: "notify",
          event: "finished",
          sessionId: id,
          cwd: info?.cwd ?? null,
          title: info?.title,
          ts: now,
        });
      }
    }

    // Drop bookkeeping for sessions that have fully disappeared, so the maps don't
    // grow without bound across a long-lived server. (A finished session's id is in
    // `working` but not `seen`; we keep `lastInfo` only for sessions still present.)
    for (const id of lastInfo.keys()) {
      if (!seen.has(id)) lastInfo.delete(id);
    }

    working = nowWorking;
    seeded = true;
  }

  // Kick off immediately to seed, then on an interval. `unref()` so the timer never
  // keeps the process alive on its own (server shutdown isn't blocked by us).
  void tick();
  const timer = setInterval(() => void tick(), pollMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    emitter,
    on(fn: (e: NotifyEvent) => void) {
      emitter.on("notify", fn);
      return () => emitter.off("notify", fn);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      emitter.removeAllListeners();
    },
  };
}
