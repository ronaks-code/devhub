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
import type { ClientMsg, RunningTurn, ServerMsg } from "@claude-ui/engine/driver";

export function registerWs(app: FastifyInstance, _engine: Engine): void {
  app.get("/api/ws/session", { websocket: true }, (socket) => {
    let activeTurn: RunningTurn | null = null;

    const send = (msg: ServerMsg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    socket.on("message", (raw: unknown) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        send({ t: "error", message: "invalid json" });
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
