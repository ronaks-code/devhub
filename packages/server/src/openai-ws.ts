/**
 * OpenAI live-chat WebSocket handler.
 *
 * /api/ws/openai/:sessionId
 *
 * Mirrors the Claude WS handler in ws.ts but drives an OpenAISession from the
 * engine instead of the Claude CLI driver. The session Map is shared with the
 * REST layer (routes/openai.ts) so a session created via POST is immediately
 * available for WS connection, and a session destroyed via DELETE stops
 * streaming.
 *
 * Client → server message: { type: "send"; text: string; cwd?: string; model?: string }
 *
 * Server → client events (each JSON-stringified):
 *   { type: "token";     token: string }
 *   { type: "tool_start"; id: string; name: string; args: string }
 *   { type: "tool_end";   id: string; result: string; error?: boolean }
 *   { type: "turn_done";  turn: OpenAITurn }
 *   { type: "error";      message: string }
 */
import type { FastifyInstance } from "fastify";
import { OpenAISession } from "@devhub/engine";
import type { OpenAIEvent, OpenAIModel } from "@devhub/engine";
import { openAISessions } from "./routes/openai.js";

// ---------------------------------------------------------------------------
// Client message shape
// ---------------------------------------------------------------------------

interface SendMsg {
  type: "send";
  text: string;
  cwd?: string;
  model?: OpenAIModel;
}

function parseSendMsg(raw: unknown): SendMsg | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== "send") return null;
  if (typeof m.text !== "string" || m.text.length === 0) return null;
  return {
    type: "send",
    text: m.text,
    cwd: typeof m.cwd === "string" ? m.cwd : undefined,
    model: typeof m.model === "string" ? (m.model as OpenAIModel) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOpenAIWs(app: FastifyInstance, token?: string): void {
  app.get<{ Params: { sessionId: string } }>(
    "/api/ws/openai/:sessionId",
    { websocket: true },
    (socket, req) => {
      // Auth: mirror the Claude WS auth guard.
      if (token) {
        const q = (req.query as Record<string, string> | undefined)?.token;
        const headerOk = req.headers.authorization === `Bearer ${token}`;
        if (q !== token && !headerOk) {
          socket.close(1008, "unauthorized");
          return;
        }
      }

      const { sessionId } = req.params;

      // Look up or lazily create the session.
      let session = openAISessions.get(sessionId);
      if (!session) {
        // Auto-create with defaults so the client can connect before POST.
        session = new OpenAISession();
        openAISessions.set(sessionId, session);
      }

      const send = (event: OpenAIEvent) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(event));
        }
      };

      // Forward all engine events to the WebSocket.
      const onEvent = (event: OpenAIEvent) => send(event);
      session.on("event", onEvent);

      socket.on("message", (raw: unknown) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          send({ type: "error", message: "invalid json" });
          return;
        }

        const msg = parseSendMsg(parsed);
        if (!msg) {
          send({ type: "error", message: "invalid request — expected { type: 'send', text }" });
          return;
        }

        // Re-look up session each message so a concurrent DELETE is respected.
        const currentSession = openAISessions.get(sessionId);
        if (!currentSession) {
          send({ type: "error", message: "session not found" });
          socket.close(1011, "session destroyed");
          return;
        }

        // If the client supplied a one-shot cwd/model override, apply them only when
        // the session is brand-new (no messages yet) — otherwise silently ignore
        // to keep the session's established context intact.
        void currentSession.send(msg.text).catch((err: unknown) => {
          send({ type: "error", message: String((err as Error)?.message ?? err) });
        });
      });

      socket.on("close", () => {
        // Remove our event listener; leave the session alive in the Map so the
        // REST layer or a reconnecting client can still reference it.
        const currentSession = openAISessions.get(sessionId);
        if (currentSession) {
          currentSession.off("event", onEvent);
        }
      });
    },
  );
}
