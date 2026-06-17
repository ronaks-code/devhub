/**
 * Server-side LIVE-TURN registry — keeps an in-flight Claude turn alive across a
 * browser reload.
 *
 * THE PROBLEM (see ws.ts): each WebSocket owns its turn, and a socket `close`
 * interrupts the running turn so we never leak a child process. That is correct
 * for a real disconnect, but a browser RELOAD also closes the socket — which today
 * kills a turn the user is still waiting on.
 *
 * THE FIX: when a socket carrying a running turn closes, ws.ts hands the turn to
 * this registry (DETACH) instead of interrupting it. The turn keeps running; the
 * events it emits while detached (deltas/messages/results/status) are appended to a
 * capped ring buffer keyed by `sessionId`. A reconnecting client for the SAME
 * sessionId sends `{ t: "attach", sessionId }`; ws.ts calls {@link LiveTurnRegistry.attach},
 * which REPLAYS the buffered events (bracketed by `replay` boundary frames) and then
 * wires the live sink so streaming resumes seamlessly.
 *
 * SAFETY:
 *  - The buffer is capped ({@link MAX_BUFFER}); the oldest events are dropped first
 *    (a `replay-truncated` marker is surfaced on attach so a face knows it missed a
 *    prefix). It can never grow without bound.
 *  - A detached turn that ENDS keeps only its final frames buffered, then evicts
 *    itself after {@link DETACHED_TTL_MS} so a never-returning client can't pin the
 *    entry (and its buffer) in memory forever.
 *  - A detached turn that is still RUNNING is given a hard {@link DETACHED_RUN_TTL_MS}
 *    budget; if no client reattaches in that window we interrupt it (same
 *    no-leaked-child guarantee as a plain close, just deferred to allow a reload).
 *
 * This is purely additive: a turn that is never detached behaves exactly as before
 * (ws.ts still drives it directly). Nothing here touches transcripts or config.
 */
import type { RunningTurn } from "@claude-ui/engine/driver";
import type { ServerMsg } from "@claude-ui/engine/driver";

/**
 * The frames the server emits. Mirrors the `OutgoingMsg` widening in ws.ts (the
 * engine's `ServerMsg` plus the not-yet-first-class `thinking-delta`) so the buffer
 * and sink here carry exactly what ws.ts sends. Clients that don't understand
 * `thinking-delta` ignore it.
 *
 * NOTE (missing engine symbols): once `{ t: "thinking-delta"; text: string }` lands
 * on `@claude-ui/engine/driver` `ServerMsg`, this widening (and the twin in ws.ts)
 * can drop the extra arm.
 */
export type OutgoingMsg = ServerMsg | { t: "thinking-delta"; text: string };

/**
 * Boundary/notice frames the registry injects around a replay so a reconnecting
 * face can tell replayed history from fresh live events. Additive: a client that
 * doesn't recognize them simply ignores them (they are inert status-like markers).
 *
 * NOTE (missing engine symbols): if these graduate to first-class protocol frames,
 * add the three variants to `@claude-ui/engine/driver` `ServerMsg`.
 */
export type ReplayMsg =
  | { t: "replay-start"; sessionId: string; count: number; truncated: boolean }
  | { t: "replay-end"; sessionId: string }
  // The turn already finished while detached; after replay there is no live stream
  // to resume. Lets a face stop showing a spinner immediately on attach.
  | { t: "replay-done"; sessionId: string };

/** Anything the registry can push to an attached socket: a real frame or a marker. */
type SinkMsg = OutgoingMsg | ReplayMsg;

/** Where a live turn fans its events: the currently-attached socket, or null. */
type Sink = (msg: SinkMsg) => void;

/**
 * Hard cap on buffered events for ONE detached turn. A long detach (e.g. a tab left
 * closed) can stream a lot of deltas; we keep only the most recent {@link MAX_BUFFER}
 * and drop the oldest, flagging the loss on attach. Sized generously enough that a
 * normal reload loses nothing, but bounded so memory can't run away.
 */
const MAX_BUFFER = 5000;

/**
 * How long a FINISHED-while-detached turn lingers (holding its final result) before
 * eviction. Long enough for a reload round-trip to grab the result; short enough that
 * an abandoned turn's buffer is reclaimed promptly.
 */
const DETACHED_TTL_MS = 5 * 60 * 1000;

/**
 * How long a STILL-RUNNING detached turn may run with no attached client before we
 * interrupt it (defending the no-leaked-child guarantee). Generous enough to cover a
 * slow reload; bounded so a closed-and-forgotten tab can't keep a child alive forever.
 */
const DETACHED_RUN_TTL_MS = 10 * 60 * 1000;

/** One live turn the registry is keeping alive on behalf of a (possibly absent) client. */
interface LiveTurn {
  sessionId: string;
  /** The underlying driver turn, so a reattaching client can still interrupt it. */
  turn: RunningTurn;
  /** Ring buffer of events emitted while detached (capped at MAX_BUFFER). */
  buffer: SinkMsg[];
  /** True once we've dropped at least one event off the front of `buffer`. */
  truncated: boolean;
  /** The attached socket's sink, or null while detached. */
  sink: Sink | null;
  /** Set once the turn's `done` promise settles (turn-end emitted). */
  finished: boolean;
  /**
   * Invoked (once) when the turn finishes WHILE a client is attached — so the
   * reattached connection can run its own end-of-turn logic (e.g. drain its queue).
   * Cleared on detach (the now-gone connection's callback is no longer valid).
   */
  onEnd: (() => void) | null;
  /** Eviction timer (run-TTL while live, result-TTL once finished). */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Keeps detached-but-running turns alive and lets a reconnecting client reattach.
 * One instance per WS plugin registration (created in ws.ts). Not shared across
 * engines; it owns only transient in-memory turn state.
 */
export class LiveTurnRegistry {
  /** Detached turns awaiting reattach or eviction, keyed by resolved sessionId. */
  private readonly turns = new Map<string, LiveTurn>();

  /**
   * Park a still-running (or just-finished) turn whose socket has gone away. Called
   * from ws.ts on socket close when a turn is active. From here on the turn fans its
   * events into the ring buffer until a client {@link attach}es or it is evicted.
   *
   * `finished` reflects whether the turn already settled at detach time (a turn can
   * end in the same tick its socket closes); if so we go straight to result-TTL.
   * Re-detaching the same sessionId (e.g. attach-then-close-again) replaces the prior
   * entry's sink/timer and keeps its buffer.
   */
  detach(opts: {
    sessionId: string;
    turn: RunningTurn;
    finished: boolean;
    /** Final frames (e.g. the buffered result + turn-end) to seed/append on detach. */
    seed?: SinkMsg[];
  }): void {
    const { sessionId, turn, finished, seed } = opts;
    const existing = this.turns.get(sessionId);
    const live: LiveTurn = existing ?? {
      sessionId,
      turn,
      buffer: [],
      truncated: false,
      sink: null,
      finished: false,
      onEnd: null,
      timer: null,
    };
    // A re-detach updates the turn handle + drops the now-dead sink/onEnd (they
    // belonged to a connection that has gone away).
    live.turn = turn;
    live.sink = null;
    live.onEnd = null;
    if (seed) for (const m of seed) this.push(live, m);
    live.finished = finished;
    this.turns.set(sessionId, live);
    this.arm(live);
  }

  /**
   * Route a live event for `sessionId` into its detached buffer (or straight to an
   * attached sink). Returns true if a live turn owns this sessionId (so ws.ts knows
   * the event was accepted by the registry), false otherwise. Used while a turn runs
   * detached: ws.ts keeps emitting through here so the buffer stays current.
   */
  emit(sessionId: string, msg: OutgoingMsg): boolean {
    const live = this.turns.get(sessionId);
    if (!live) return false;
    this.push(live, msg);
    return true;
  }

  /**
   * Mark the turn for `sessionId` as finished (turn-end emitted). Two cases:
   *  - A client is ATTACHED (reattached and resumed): the turn ran to completion
   *    for a live socket, so we fire its {@link LiveTurn.onEnd} (letting ws.ts drain
   *    its queue) and evict — the registry's job is done.
   *  - DETACHED: switch eviction from the run-TTL to the shorter result-TTL so the
   *    buffered final frames linger just long enough for a reload to collect them.
   * No-op if not tracked.
   */
  markFinished(sessionId: string): void {
    const live = this.turns.get(sessionId);
    if (!live) return;
    live.finished = true;
    if (live.sink) {
      const onEnd = live.onEnd;
      this.evict(sessionId);
      onEnd?.();
      return;
    }
    this.arm(live);
  }

  /** Is there a live (detached) turn for this sessionId? */
  has(sessionId: string): boolean {
    return this.turns.has(sessionId);
  }

  /**
   * Reattach a freshly-connected socket to the live turn for `sessionId`. Replays the
   * buffered events (bracketed by `replay-start`/`replay-end`, with a `replay-done`
   * when the turn already finished) and — for a STILL-RUNNING turn — wires `sink` as
   * the live destination so further events stream straight to the new socket.
   *
   * Returns the still-running `RunningTurn` so ws.ts can adopt it as its active turn
   * (honoring interrupts and end-of-turn drain); null when the turn already finished
   * (the buffer was replayed but there is nothing live to resume) or no such turn
   * exists.
   *
   * `onEnd` is invoked once if/when the adopted (running) turn later finishes while
   * still attached, so ws.ts can drain its queue. A finished-at-attach turn is EVICTED
   * right after its replay (its job — handing the late client the result — is done).
   * The registry keeps OWNING delivery for a resumed turn; the same connection should
   * re-{@link detach} it on its own socket close.
   */
  attach(sessionId: string, sink: Sink, onEnd?: () => void): RunningTurn | null {
    const live = this.turns.get(sessionId);
    if (!live) return null;

    // Replay the buffered history. The boundary frames let a face visually separate
    // replayed events from the fresh live stream that follows.
    sink({
      t: "replay-start",
      sessionId,
      count: live.buffer.length,
      truncated: live.truncated,
    });
    for (const m of live.buffer) sink(m);
    sink({ t: "replay-end", sessionId });

    if (live.finished) {
      // Nothing live to resume: the turn ended while detached. Tell the client, then
      // evict — the buffered result has now been delivered.
      sink({ t: "replay-done", sessionId });
      this.evict(sessionId);
      return null;
    }

    // Live resume: future events flow straight to this socket (no longer buffered),
    // and the run-TTL is cleared now that someone is listening again. The entry stays
    // in the registry so the turn's events (still routed through `emit`) keep flowing
    // to the new sink and a later close can re-detach cleanly.
    live.sink = sink;
    live.onEnd = onEnd ?? null;
    live.buffer.length = 0;
    live.truncated = false;
    this.clearTimer(live);
    return live.turn;
  }

  /**
   * Interrupt + evict a tracked turn (e.g. an explicit interrupt that arrives for a
   * detached session). Safe to call for an unknown sessionId.
   */
  interrupt(sessionId: string): void {
    const live = this.turns.get(sessionId);
    if (!live) return;
    try {
      live.turn.interrupt();
    } catch {
      // ignore — the turn may have already settled
    }
    this.evict(sessionId);
  }

  /** Interrupt every tracked turn and clear the registry (server shutdown / cleanup). */
  shutdown(): void {
    for (const sessionId of [...this.turns.keys()]) this.interrupt(sessionId);
  }

  // ---- internals ----------------------------------------------------------

  /** Append to the ring buffer, dropping the oldest when over {@link MAX_BUFFER}. */
  private push(live: LiveTurn, msg: SinkMsg): void {
    // While attached we shouldn't be buffering, but guard anyway: if a sink is
    // present, deliver live; otherwise buffer.
    if (live.sink) {
      live.sink(msg);
      return;
    }
    live.buffer.push(msg);
    if (live.buffer.length > MAX_BUFFER) {
      live.buffer.shift();
      live.truncated = true;
    }
  }

  /** (Re)arm the eviction timer appropriate to the turn's current state. */
  private arm(live: LiveTurn): void {
    this.clearTimer(live);
    const ttl = live.finished ? DETACHED_TTL_MS : DETACHED_RUN_TTL_MS;
    live.timer = setTimeout(() => {
      // On the run-TTL we must interrupt the orphaned child; on the result-TTL the
      // turn is already done, so a plain evict suffices.
      if (live.finished) this.evict(live.sessionId);
      else this.interrupt(live.sessionId);
    }, ttl);
    // Don't keep the event loop alive solely for a parked turn.
    live.timer.unref?.();
  }

  private clearTimer(live: LiveTurn): void {
    if (live.timer) {
      clearTimeout(live.timer);
      live.timer = null;
    }
  }

  /** Drop a tracked turn and free its buffer/timer (does NOT interrupt). */
  private evict(sessionId: string): void {
    const live = this.turns.get(sessionId);
    if (!live) return;
    this.clearTimer(live);
    live.buffer.length = 0;
    this.turns.delete(sessionId);
  }
}
