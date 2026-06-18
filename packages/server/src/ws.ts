/**
 * Live-chat WebSocket. One connection drives at most one turn at a time; the
 * engine's driver does the real work and we just relay its events to the socket
 * as ServerMsg JSON. An EXPLICIT interrupt cancels the running turn so we never
 * leak a child process.
 *
 * MESSAGE QUEUE: a `{t:"prompt"}` that arrives while a turn is running is no
 * longer rejected as "busy" — it is appended to a FIFO queue and run as soon as
 * the current turn ends. Turns run strictly one-at-a-time and resume the same
 * session each time (the freshly-minted sessionId from the first turn flows into
 * every queued turn, so context carries forward). The pending count is surfaced
 * to the client via the existing `{t:"status"}` frame as `kind:"queued:N"`.
 *
 * REATTACH ACROSS RELOAD: a socket `close` no longer always interrupts the active
 * turn. If the turn has a resolved sessionId we DETACH it into a server-side
 * {@link LiveTurnRegistry} that keeps the child alive and buffers its streamed
 * events. A reconnecting client sends `{ t: "attach", sessionId }`; we replay the
 * buffered events and resume the live stream — so a browser reload no longer kills
 * an in-progress turn. A turn with no sessionId yet (or an explicit interrupt) is
 * still cancelled as before. See live-turns.ts.
 *
 * The `socket` param type is supplied by @fastify/websocket's `{ websocket: true }`
 * route overload (it's a `ws` WebSocket), so we let it be inferred here.
 */
import type { FastifyInstance } from "fastify";
import { createDriver, type Engine } from "@claude-ui/engine";
import { PERMISSION_MODES } from "@claude-ui/engine/driver";
import type {
  ClientMsg,
  PermissionDenial,
  PermissionMode,
  RunningTurn,
  ServerMsg,
  TurnHandlers,
  TurnResult,
} from "@claude-ui/engine/driver";
import { LiveTurnRegistry } from "./live-turns.js";

type PromptMsg = Extract<ClientMsg, { t: "prompt" }>;

/**
 * Frames the server accepts. The engine's `ClientMsg` union is the source of
 * truth, but it doesn't yet carry the queue-control frames (an optional
 * `keepQueue` on interrupt, and the `clear-queue` message). We can't edit that
 * package, so — mirroring the web client's `OutgoingMsg` boundary widening — we
 * widen the type locally. A server/engine that ignores the extra field/frame is
 * unharmed; this one honors them.
 *
 * NOTE (missing engine symbols): if these become first-class, add to
 * `@claude-ui/engine/driver` `ClientMsg`: an optional `keepQueue?: boolean` on
 * the `interrupt` variant, a `{ t: "clear-queue" }` variant, and a
 * `{ t: "attach"; sessionId: string }` variant (reattach to a detached turn).
 * Until then they live here.
 */
type IncomingMsg =
  // Engine frames minus the bare interrupt, which we re-add below with an
  // optional `keepQueue` so a single narrowed interrupt shape carries the field.
  | Exclude<ClientMsg, { t: "interrupt" }>
  | { t: "interrupt"; keepQueue?: boolean }
  | { t: "clear-queue" }
  // Opt-in reattach to a turn left running on the server after this client's prior
  // socket closed (e.g. a browser reload). Carries the sessionId to reattach to.
  | { t: "attach"; sessionId: string };

/**
 * Frames the server emits. The engine's `ServerMsg` is the source of truth but
 * does not yet carry a thinking (extended-reasoning) frame, so — mirroring the
 * `IncomingMsg` widening above — we widen the outgoing type locally to add it.
 * Clients that don't understand `thinking-delta` simply ignore it.
 *
 * NOTE (missing engine symbols): if this becomes first-class, add a
 * `{ t: "thinking-delta"; text: string }` variant to `@claude-ui/engine/driver`
 * `ServerMsg` (and an `onThinkingDelta?: (text: string) => void` on
 * `TurnHandlers`, see below), then drop this widening.
 */
type OutgoingMsg = ServerMsg | { t: "thinking-delta"; text: string };

/**
 * Local widening of `TurnHandlers` to carry the thinking-delta callback the
 * engine streams from `thinking_delta` blocks. `TurnHandlers` doesn't declare it
 * yet; once it does (`onThinkingDelta?: (text: string) => void`) this alias and
 * the cast at the call site can be removed. Honoring it is a no-op if the engine
 * never invokes it.
 */
type TurnHandlersWithThinking = TurnHandlers & {
  onThinkingDelta?: (text: string) => void;
};

/**
 * Best-effort shape of an engine audit helper for permission denials. The engine
 * does not export this yet; we look it up at runtime and call it only if present
 * (per spec: "best-effort, ignore if absent"). No compile-time dependency on a
 * symbol the engine may not have.
 *
 * NOTE (missing engine symbols): wire `auditPermissionDenials(sessionId, denials)`
 * (or similar) onto `Engine`, then replace this duck-typed lookup with a typed call.
 */
type DenialAuditFn = (sessionId: string | null, denials: PermissionDenial[]) => void;
function resolveDenialAudit(engine: Engine): DenialAuditFn | undefined {
  const candidate = (engine as unknown as Record<string, unknown>)
    .auditPermissionDenials;
  return typeof candidate === "function"
    ? (candidate.bind(engine) as DenialAuditFn)
    : undefined;
}

/**
 * Best-effort shape of the engine's rate-limit retry policy. The engine lane adds
 * `engine.computeRetry(resultOrError, attempt, opts)` THIS wave; we look it up at
 * runtime and call it only if present (per the campaign's duck-type rule). When the
 * symbol is absent we behave exactly as today (a rate-limited turn just ends).
 *
 * We don't depend on the engine's exact return TYPE (a sibling lane owns it), so we
 * read the decision through a small set of tolerated field spellings: a truthy
 * retry flag (`retry` | `retryable` | `shouldRetry`) and a non-negative delay
 * (`delayMs` | `delay`). Anything else — falsy, throwing, or unparseable — is read as
 * "do not retry", so a malformed policy can never start an unwanted re-run.
 *
 * NOTE (missing engine symbols): once `computeRetry(resultOrError, attempt, opts?)`
 * is exported with a typed `RetryDecision` ({ retry; delayMs; maxAttempts? }), replace
 * this duck-typed lookup + `readRetryDecision` with a typed call.
 */
type ComputeRetryFn = (
  resultOrError: TurnResult | string | null | undefined,
  attempt: number,
  opts?: unknown,
) => unknown;
export function resolveComputeRetry(engine: Engine): ComputeRetryFn | undefined {
  const candidate = (engine as unknown as Record<string, unknown>).computeRetry;
  return typeof candidate === "function"
    ? (candidate.bind(engine) as ComputeRetryFn)
    : undefined;
}

/** A normalized retry decision distilled from whatever `computeRetry` returned. */
export interface RetryDecision {
  retry: boolean;
  /** Clamped to a non-negative integer of milliseconds. */
  delayMs: number;
}

/**
 * Hard safety net on auto-retries per turn, independent of the engine policy's own
 * `maxAttempts`. The policy is authoritative (it stops by returning a non-retry
 * decision), but this caps us even if a misbehaving policy keeps saying "retry", so
 * we can never loop unboundedly. Large enough not to clip a sane policy.
 */
const MAX_AUTO_RETRIES = 8;

/**
 * Upper bound on a single retry delay (10 min) so a bogus/huge `delayMs` from the
 * policy can't park a turn effectively forever. Defensive clamp only.
 */
const MAX_RETRY_DELAY_MS = 10 * 60_000;

/**
 * Distill the engine policy's opaque return value into a {@link RetryDecision}.
 * Tolerant by design: only a truthy retry flag AND a finite, non-negative delay
 * yield `retry: true`; everything else (null, a plain boolean, a missing/NaN delay)
 * reads as "do not retry" so we never schedule a re-run on a shape we don't trust.
 */
export function readRetryDecision(raw: unknown): RetryDecision {
  if (raw == null || typeof raw !== "object") return { retry: false, delayMs: 0 };
  const d = raw as Record<string, unknown>;
  const flag = d.retry ?? d.retryable ?? d.shouldRetry;
  if (flag !== true) return { retry: false, delayMs: 0 };
  const rawDelay = d.delayMs ?? d.delay;
  const delay = typeof rawDelay === "number" ? rawDelay : NaN;
  if (!Number.isFinite(delay) || delay < 0) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: Math.min(Math.floor(delay), MAX_RETRY_DELAY_MS) };
}

/**
 * Upper bound on pending prompts so a misbehaving (or malicious) client can't
 * grow the queue without limit. Prompts beyond this are rejected with an error;
 * the active turn and existing queue are untouched.
 */
const MAX_QUEUE = 100;

/**
 * Runtime guard for a parsed frame. JSON.parse gives us `any`-shaped data, so we
 * verify the discriminant and required fields before driving a turn — a malformed
 * "prompt" (missing/blank cwd or prompt) must never reach the engine with
 * undefined values. Returns a narrowed IncomingMsg or null for anything invalid.
 */
function parseClientMsg(raw: unknown): IncomingMsg | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m.t === "interrupt") {
    return { t: "interrupt", keepQueue: m.keepQueue === true };
  }
  if (m.t === "clear-queue") return { t: "clear-queue" };
  if (m.t === "attach") {
    if (typeof m.sessionId !== "string" || m.sessionId.length === 0) return null;
    return { t: "attach", sessionId: m.sessionId };
  }
  if (m.t === "prompt") {
    if (typeof m.cwd !== "string" || m.cwd.length === 0) return null;
    if (typeof m.prompt !== "string" || m.prompt.length === 0) return null;
    if (m.sessionId !== undefined && typeof m.sessionId !== "string") return null;
    if (m.model !== undefined && typeof m.model !== "string") return null;
    if (
      m.permissionMode !== undefined &&
      !PERMISSION_MODES.includes(m.permissionMode as PermissionMode)
    ) {
      return null;
    }
    return {
      t: "prompt",
      cwd: m.cwd,
      prompt: m.prompt,
      sessionId: m.sessionId,
      model: m.model,
      permissionMode: m.permissionMode as PromptMsg["permissionMode"],
    };
  }
  return null;
}

export function registerWs(app: FastifyInstance, engine: Engine, token?: string): void {
  // Resolved once: a best-effort denial-audit helper, if the engine exposes one.
  const auditDenials = resolveDenialAudit(engine);
  // Resolved once: the rate-limit retry policy, if the engine exposes one. Absent =>
  // no auto-retry (behaves exactly as today: a rate-limited turn just ends).
  const computeRetry = resolveComputeRetry(engine);

  // One registry shared by every connection on this plugin: it holds turns whose
  // socket closed but that we keep alive for a reattach (browser reload). Cleaned
  // up with the plugin so parked turns don't outlive the server.
  const liveTurns = new LiveTurnRegistry();
  app.addHook("onClose", async () => liveTurns.shutdown());

  app.get("/api/ws/session", { websocket: true }, (socket, req) => {
    // Auth: when a token is configured, the REST onRequest hook deliberately
    // skips the WS upgrade (browsers can't set an Authorization header on a
    // WebSocket), so the handshake is guarded HERE. The web client appends
    // `?token=<t>` to the URL; we also accept a Bearer header for non-browser
    // clients. On mismatch we close before any turn can be driven. Dormant when
    // no token is set (local-only default).
    if (token) {
      const q = (req.query as Record<string, string> | undefined)?.token;
      const headerOk = req.headers.authorization === `Bearer ${token}`;
      if (q !== token && !headerOk) {
        socket.close(1008, "unauthorized");
        return;
      }
    }

    /** The turn currently being driven, or null when idle. */
    let activeTurn: RunningTurn | null = null;
    /**
     * Resolved sessionId of the ACTIVE turn (from `onSession`), or undefined until
     * it arrives. Distinct from {@link resumeSessionId} (which seeds the NEXT turn):
     * this is the key we detach the *current* turn under on a socket close.
     */
    let activeTurnSessionId: string | undefined;
    /**
     * True once this socket has closed and its active turn was handed to the live-turn
     * registry. While detached, the turn's events route into the registry buffer (for
     * a future reattach) rather than this dead socket.
     */
    let detached = false;
    /** Pending prompts, oldest first. Drained one-at-a-time on turn-end. */
    const queue: PromptMsg[] = [];
    /**
     * The session to resume for the next turn. Seeded from the engine's
     * `onSession` callback so every queued prompt continues the same context,
     * even if the client's queued frames carried no (or a stale) sessionId.
     */
    let resumeSessionId: string | undefined;
    /**
     * A scheduled auto-retry, or null when none is pending. When a turn ends with a
     * rate-limit/overload signal the engine's policy deems retryable, we park the SAME
     * prompt here behind a {@link MAX_RETRY_DELAY_MS}-clamped timer instead of ending
     * the turn. A user interrupt / clear-queue / socket close cancels it (see
     * {@link cancelPendingRetry}) so we never re-run after the user has moved on and
     * never leak the timer. `.unref()`'d so a lone pending retry can't keep the
     * process alive on shutdown.
     */
    let pendingRetry: ReturnType<typeof setTimeout> | null = null;
    /** Drop any scheduled retry timer. Idempotent; safe to call when none is pending. */
    const cancelPendingRetry = () => {
      if (pendingRetry) {
        clearTimeout(pendingRetry);
        pendingRetry = null;
      }
    };

    const send = (msg: OutgoingMsg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    /**
     * Deliver an ACTIVE-TURN event. While the socket is live it goes straight out;
     * once detached (socket closed, turn kept alive) it is routed into the live-turn
     * registry's buffer for the eventual reattach. Control frames unrelated to the
     * turn stream (queue status) keep using {@link send} directly — they are
     * meaningless to a detached, socketless turn.
     */
    const deliver = (msg: OutgoingMsg) => {
      if (detached && activeTurnSessionId) {
        liveTurns.emit(activeTurnSessionId, msg);
        return;
      }
      send(msg);
    };

    /** Reflect the current pending count to the client via the status frame. */
    const emitQueued = () => send({ t: "status", kind: `queued:${queue.length}` });

    /**
     * Start driving `msg` as the active turn. Prefers the live `resumeSessionId`
     * (so the conversation stays one thread) and falls back to whatever the
     * client supplied. On completion, emits turn-end and pulls the next prompt.
     *
     * `attempt` is the auto-retry counter (0 for a fresh, user-sent turn). When a
     * turn ends with a rate-limit/overload signal the engine's `computeRetry` policy
     * deems retryable, we re-invoke `startTurn(msg, attempt + 1)` after the computed
     * delay — the SAME prompt, same cwd/sessionId/model/permissionMode — so the user
     * doesn't have to re-send. A normal/budget completion never retries (unchanged),
     * and an absent policy never retries (unchanged).
     */
    const startTurn = (msg: PromptMsg, attempt = 0) => {
      // Denials reported by the turn's result, kept so we can audit them (best
      // effort) once the turn ends.
      let denials: PermissionDenial[] = [];
      // The terminal result/error of THIS turn, captured so `done.finally` can ask the
      // retry policy whether to re-run. A `result` frame wins over an `onError` string
      // when both arrive (the structured result carries the authoritative subtype).
      let lastResult: TurnResult | undefined;
      let lastError: string | undefined;

      // `onThinkingDelta` isn't on `TurnHandlers` yet; cast through the local
      // widening so the field type-checks. Ignored by an engine that never fires it.
      // All turn-stream events route through `deliver` so they reach the socket while
      // attached and the registry buffer once detached.
      const handlers: TurnHandlersWithThinking = {
        onSession: (sessionId, init) => {
          // Resume this same session for every subsequent queued turn, AND record it
          // as the active turn's key so a socket close can detach THIS turn under it.
          resumeSessionId = sessionId;
          activeTurnSessionId = sessionId;
          deliver({ t: "session", sessionId, init });
        },
        onMessage: (message) => deliver({ t: "message", message }),
        onDelta: (text) => deliver({ t: "delta", text }),
        onThinkingDelta: (text) => deliver({ t: "thinking-delta", text }),
        onStatus: ({ kind }) => deliver({ t: "status", kind }),
        onResult: (result) => {
          denials = result.denials;
          lastResult = result;
          deliver({ t: "result", result });
        },
        onError: (message) => {
          lastError = message;
          deliver({ t: "error", message });
        },
      };

      const turn = createDriver().runTurn(
        {
          cwd: msg.cwd,
          prompt: msg.prompt,
          sessionId: resumeSessionId ?? msg.sessionId,
          model: msg.model,
          permissionMode: msg.permissionMode ?? "acceptEdits",
        },
        handlers as TurnHandlers,
      );
      activeTurn = turn;
      void turn.done.finally(() => {
        // Best-effort: log any tool-permission denials from this turn. Failures
        // here never affect the user's turn; swallow them.
        if (auditDenials && denials.length > 0) {
          try {
            auditDenials(resumeSessionId ?? msg.sessionId ?? null, denials);
          } catch {
            // ignore — auditing is non-essential
          }
        }

        // AUTO-RETRY (opt-in via the engine policy; no-op when the policy is absent).
        // Only while ATTACHED: a detached, socketless turn has no client to show the
        // status to and the registry owns its finalization, so we never retry it. If
        // the policy says this rate-limit/overload result is retryable, re-run the SAME
        // prompt after the computed delay instead of ending the turn — the user doesn't
        // re-send. A normal/budget completion yields a non-retry decision (unchanged).
        if (computeRetry && !detached && attempt < MAX_AUTO_RETRIES) {
          let decision: RetryDecision = { retry: false, delayMs: 0 };
          try {
            // Pass the structured result when we have one (its subtype is
            // authoritative), else the raw error string; `attempt` lets the policy
            // enforce its own maxAttempts and back-off curve.
            decision = readRetryDecision(
              computeRetry(lastResult ?? lastError, attempt, {}),
            );
          } catch {
            // A throwing/half-landed policy must never wedge a turn: treat as no-retry.
            decision = { retry: false, delayMs: 0 };
          }
          if (decision.retry) {
            const nextAttempt = attempt + 1;
            // Mirror the `queued:N` status convention so a client can show a banner.
            send({ t: "status", kind: `retrying:${nextAttempt}:${decision.delayMs}` });
            // Park the SAME prompt behind the delay WITHOUT emitting turn-end: the turn
            // hasn't truly finished from the user's view. The old turn object is done, so
            // null `activeTurn`; `pendingRetry` now signals "in flight" so an incoming
            // prompt still queues, drainQueue still waits, and an interrupt/clear-queue/
            // close can cancel us. `.unref()` so a lone pending retry can't keep the
            // process alive. We deliberately keep `activeTurnSessionId` so the resumed
            // turn continues the same thread.
            activeTurn = null;
            const timer = setTimeout(() => {
              pendingRetry = null;
              startTurn(msg, nextAttempt);
            }, decision.delayMs);
            timer.unref?.();
            pendingRetry = timer;
            return;
          }
        }

        deliver({ t: "turn-end" });
        const endedSessionId = activeTurnSessionId;
        activeTurn = null;
        activeTurnSessionId = undefined;
        if (detached) {
          // Socket is gone: there is nothing to drain to. The turn-end was buffered
          // above; tell the registry the turn is done so it switches to the short
          // result-TTL and the final frames await a reattach (then evict).
          if (endedSessionId) liveTurns.markFinished(endedSessionId);
          return;
        }
        drainQueue();
      });
    };

    /** Run the next queued prompt, if any, and update the pending count. */
    const drainQueue = () => {
      // A running turn OR a scheduled auto-retry is still in flight; either will drain
      // the queue when it truly ends (turn-end / the retry firing then ending).
      if (activeTurn || pendingRetry) return;
      const next = queue.shift();
      if (!next) return;
      emitQueued();
      startTurn(next);
    };

    socket.on("message", (raw: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        send({ t: "error", message: "invalid json" });
        return;
      }

      const msg = parseClientMsg(parsed);
      if (!msg) {
        send({ t: "error", message: "invalid request" });
        return;
      }

      if (msg.t === "prompt") {
        // A pending auto-retry counts as in-flight: the turn hasn't truly ended, so a
        // new prompt queues behind it rather than starting concurrently.
        if (activeTurn || pendingRetry) {
          // Busy: enqueue instead of rejecting, but never grow without bound.
          if (queue.length >= MAX_QUEUE) {
            send({ t: "error", message: "queue full" });
            return;
          }
          queue.push(msg);
          emitQueued();
          return;
        }
        startTurn(msg);
      } else if (msg.t === "interrupt") {
        // Stop the running turn. By default the pending queue is dropped (the
        // user is bailing out); pass keepQueue:true to interrupt only the
        // current turn and let the queue resume on turn-end.
        if (!msg.keepQueue && queue.length > 0) {
          queue.length = 0;
          emitQueued();
        }
        // Cancel any scheduled auto-retry: the user is bailing out, so we must not
        // re-run the parked prompt. If a retry was pending there is no live child to
        // interrupt, but we still drain the (possibly kept) queue as a turn-end would.
        if (pendingRetry) {
          cancelPendingRetry();
          deliver({ t: "turn-end" });
          activeTurnSessionId = undefined;
          drainQueue();
        }
        activeTurn?.interrupt();
      } else if (msg.t === "clear-queue") {
        // Drop pending prompts; leave the active turn running.
        if (queue.length > 0) {
          queue.length = 0;
          emitQueued();
        }
      } else if (msg.t === "attach") {
        // Reattach to a turn this client left running on a prior socket (e.g. a
        // browser reload). Only honored when idle on THIS socket — a connection
        // already driving a turn has nothing to reattach. The registry replays the
        // buffered events to us and, if the turn is still running, streams the rest
        // live; if it already finished we just get the buffered result + replay-done.
        if (activeTurn || pendingRetry) {
          send({ t: "error", message: "busy" });
          return;
        }
        // Raw sender: the replay/marker frames are widened past OutgoingMsg, so we
        // serialize whatever the registry hands us straight to the socket.
        const sink = (m: OutgoingMsg | Record<string, unknown>) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
        };
        // When the adopted turn later ends while we're attached, the registry calls
        // this: resume normal direct delivery and drain anything we queued meanwhile.
        const onAdoptedEnd = () => {
          detached = false;
          activeTurn = null;
          activeTurnSessionId = undefined;
          drainQueue();
        };
        const resumed = liveTurns.attach(msg.sessionId, sink, onAdoptedEnd);
        if (resumed) {
          // Adopt the still-running turn. While it runs, its events (emitted by the
          // ORIGINAL turn's handlers via `deliver`) route through the registry to our
          // `sink`, so we mark this connection detached-routed and point the active
          // keys at the resumed turn. `onAdoptedEnd` flips us back on turn-end.
          activeTurn = resumed;
          activeTurnSessionId = msg.sessionId;
          resumeSessionId = msg.sessionId;
          detached = true;
        } else {
          // The turn was unknown or already finished (its result was just replayed).
          // Nothing is active; resume normal direct delivery and drain any queue.
          detached = false;
          drainQueue();
        }
      }
    });

    socket.on("close", () => {
      // No more turns can be driven on a dead socket; drop the queue too so
      // drainQueue (were it somehow reached) has nothing to start.
      queue.length = 0;
      // Cancel any scheduled auto-retry — the socket is gone, so re-running the parked
      // prompt would stream into a dead connection. The turn already produced its
      // terminal result (we never emit turn-end while a retry is pending), so there is
      // no live child to keep alive or detach; just drop the timer so it can't leak.
      cancelPendingRetry();

      if (detached && activeTurn && activeTurnSessionId) {
        // Already routing the active turn through the registry (this was a reattached
        // connection). The registry still owns it; just sever our sink so the turn's
        // events buffer again until the next reattach. Don't interrupt.
        liveTurns.detach({
          sessionId: activeTurnSessionId,
          turn: activeTurn,
          finished: false,
        });
        return;
      }

      if (activeTurn && activeTurnSessionId) {
        // A turn is running with a resolved sessionId: keep it ALIVE for a reattach
        // (browser reload) instead of interrupting. Hand it to the registry, then
        // flip this connection to detached-routing so the turn's remaining events
        // (still emitted by its handlers via `deliver`) buffer for the next client.
        liveTurns.detach({
          sessionId: activeTurnSessionId,
          turn: activeTurn,
          finished: false,
        });
        detached = true;
        return;
      }

      // No reattachable turn (idle, or a turn whose sessionId never resolved): we
      // can't key a buffer, so fall back to the original behavior — interrupt so we
      // never leak a child process.
      activeTurn?.interrupt();
    });
  });
}
