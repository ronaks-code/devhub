/**
 * Live-chat WebSocket. One connection drives at most one turn at a time; the
 * engine's driver does the real work and we just relay its events to the socket
 * as ServerMsg JSON. Interrupting (explicit message or socket close) cancels the
 * running turn so we never leak a child process.
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
 * Runtime guard for a parsed frame. JSON.parse gives us `any`-shaped data, so we
 * verify the discriminant and required fields before driving a turn — a malformed
 * "prompt" (missing/blank cwd or prompt) must never reach the engine with
 * undefined values. Returns a narrowed ClientMsg or null for anything invalid.
 */
function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m.t === "interrupt") return { t: "interrupt" };
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
    let activeTurn: RunningTurn | null = null;

    const send = (msg: ServerMsg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
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
          send({ t: "error", message: "busy" });
          return;
        }
        const turn = createDriver().runTurn(
          {
            cwd: msg.cwd,
            prompt: msg.prompt,
            sessionId: msg.sessionId,
            model: msg.model,
            permissionMode: msg.permissionMode ?? "acceptEdits",
          },
          {
            onSession: (sessionId, init) => send({ t: "session", sessionId, init }),
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
        });
      } else if (msg.t === "interrupt") {
        activeTurn?.interrupt();
      }
    });

    socket.on("close", () => {
      activeTurn?.interrupt();
    });
  });
}
