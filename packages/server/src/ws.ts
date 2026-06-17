/**
 * Live-chat WebSocket. One connection drives at most one turn at a time; the
 * engine's driver does the real work and we just relay its events to the socket
 * as ServerMsg JSON. Interrupting (explicit message or socket close) cancels the
 * running turn so we never leak a child process.
 *
 * MESSAGE QUEUE: a `{t:"prompt"}` that arrives while a turn is running is no
 * longer rejected as "busy" — it is appended to a FIFO queue and run as soon as
 * the current turn ends. Turns run strictly one-at-a-time and resume the same
 * session each time (the freshly-minted sessionId from the first turn flows into
 * every queued turn, so context carries forward). The pending count is surfaced
 * to the client via the existing `{t:"status"}` frame as `kind:"queued:N"`.
 *
 * The `socket` param type is supplied by @fastify/websocket's `{ websocket: true }`
 * route overload (it's a `ws` WebSocket), so we let it be inferred here.
 */
import type { FastifyInstance } from "fastify";
import { createDriver, type Engine } from "@claude-ui/engine";
import { PERMISSION_MODES } from "@claude-ui/engine/driver";
import type {
  ClientMsg,
  PermissionMode,
  RunningTurn,
  ServerMsg,
} from "@claude-ui/engine/driver";

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
 * the `interrupt` variant, and a `{ t: "clear-queue" }` variant. Until then they
 * live here.
 */
type IncomingMsg =
  // Engine frames minus the bare interrupt, which we re-add below with an
  // optional `keepQueue` so a single narrowed interrupt shape carries the field.
  | Exclude<ClientMsg, { t: "interrupt" }>
  | { t: "interrupt"; keepQueue?: boolean }
  | { t: "clear-queue" };

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

export function registerWs(app: FastifyInstance, _engine: Engine): void {
  app.get("/api/ws/session", { websocket: true }, (socket) => {
    /** The turn currently being driven, or null when idle. */
    let activeTurn: RunningTurn | null = null;
    /** Pending prompts, oldest first. Drained one-at-a-time on turn-end. */
    const queue: PromptMsg[] = [];
    /**
     * The session to resume for the next turn. Seeded from the engine's
     * `onSession` callback so every queued prompt continues the same context,
     * even if the client's queued frames carried no (or a stale) sessionId.
     */
    let resumeSessionId: string | undefined;

    const send = (msg: ServerMsg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    /** Reflect the current pending count to the client via the status frame. */
    const emitQueued = () => send({ t: "status", kind: `queued:${queue.length}` });

    /**
     * Start driving `msg` as the active turn. Prefers the live `resumeSessionId`
     * (so the conversation stays one thread) and falls back to whatever the
     * client supplied. On completion, emits turn-end and pulls the next prompt.
     */
    const startTurn = (msg: PromptMsg) => {
      const turn = createDriver().runTurn(
        {
          cwd: msg.cwd,
          prompt: msg.prompt,
          sessionId: resumeSessionId ?? msg.sessionId,
          model: msg.model,
          permissionMode: msg.permissionMode ?? "acceptEdits",
        },
        {
          onSession: (sessionId, init) => {
            // Resume this same session for every subsequent queued turn.
            resumeSessionId = sessionId;
            send({ t: "session", sessionId, init });
          },
          onMessage: (message) => send({ t: "message", message }),
          onDelta: (text) => send({ t: "delta", text }),
          onStatus: ({ kind }) => send({ t: "status", kind }),
          onResult: (result) => send({ t: "result", result }),
          onError: (message) => send({ t: "error", message }),
        },
      );
      activeTurn = turn;
      void turn.done.finally(() => {
        send({ t: "turn-end" });
        activeTurn = null;
        drainQueue();
      });
    };

    /** Run the next queued prompt, if any, and update the pending count. */
    const drainQueue = () => {
      if (activeTurn) return; // a turn is already running; it will drain on end
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
        if (activeTurn) {
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
        activeTurn?.interrupt();
      } else if (msg.t === "clear-queue") {
        // Drop pending prompts; leave the active turn running.
        if (queue.length > 0) {
          queue.length = 0;
          emitQueued();
        }
      }
    });

    socket.on("close", () => {
      // No more turns can be driven on a dead socket; drop the queue too so
      // drainQueue (were it somehow reached) has nothing to start.
      queue.length = 0;
      activeTurn?.interrupt();
    });
  });
}
