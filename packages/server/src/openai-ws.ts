/**
 * Development-only OpenAI Chat WebSocket boundary.
 *
 * Browser WebSocket handshakes cannot safely attach an Authorization header,
 * so authentication is the first application frame. The access token never
 * appears in the URL, and the server does not even look up a session until that
 * frame is accepted. Sessions must already exist through authenticated REST.
 */
import type { FastifyInstance } from "fastify";
import type { OpenAIEvent } from "@devhub/engine";
import {
  isTrustedOpenAIOrigin,
  openAISessions,
  type ManagedOpenAISession,
} from "./routes/openai.js";

interface AuthenticateMessage {
  type: "authenticate";
  token: string;
}

interface SendMessage {
  type: "send";
  text: string;
}

interface StopMessage {
  type: "stop";
}

type ClientMessage = AuthenticateMessage | SendMessage | StopMessage;

export interface OpenAIWsOptions {
  enabled?: boolean;
  token?: string;
}

interface SessionSendLease {
  readonly owner: object;
}

/** One authoritative in-flight owner per shared session object. */
const sessionSendLeases = new WeakMap<ManagedOpenAISession, SessionSendLease>();

function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  if (input.type === "authenticate" && typeof input.token === "string") {
    return { type: "authenticate", token: input.token };
  }
  if (
    input.type === "send" &&
    typeof input.text === "string" &&
    input.text.length > 0 &&
    input.text.length <= 200_000
  ) {
    return { type: "send", text: input.text };
  }
  if (input.type === "stop") return { type: "stop" };
  return null;
}

export function registerOpenAIWs(
  app: FastifyInstance,
  options: OpenAIWsOptions = {},
): void {
  app.get<{ Params: { sessionId: string } }>(
    "/api/ws/openai/:sessionId",
    { websocket: true },
    (socket, request) => {
      if (options.enabled !== true) {
        socket.close(1008, "OpenAI Chat disabled");
        return;
      }
      if (!options.token) {
        socket.close(1011, "OpenAI Chat access token not configured");
        return;
      }
      if (!isTrustedOpenAIOrigin(request.headers.origin, request.headers.host)) {
        socket.close(1008, "untrusted origin");
        return;
      }

      const sessionId = request.params.sessionId;
      const connectionOwner = {};
      let authenticated = false;
      let session: ManagedOpenAISession | undefined;
      let eventListener: ((event: OpenAIEvent) => void) | undefined;
      let stopIssued = false;

      const sendFrame = (frame: Record<string, unknown> | OpenAIEvent): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };

      const stopSession = (allowIdle: boolean): "stopped" | "busy" | "noop" => {
        if (!session || stopIssued) return "noop";
        const lease = sessionSendLeases.get(session);
        if (lease && lease.owner !== connectionOwner) return "busy";
        if (!lease && !allowIdle) return "noop";
        stopIssued = true;
        session.stop();
        return "stopped";
      };

      socket.on("message", (raw: unknown) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(String(raw));
        } catch {
          if (!authenticated) {
            socket.close(1008, "unauthorized");
          } else {
            sendFrame({ type: "error", message: "invalid json" });
          }
          return;
        }

        const message = parseClientMessage(decoded);
        if (!authenticated) {
          if (
            message?.type !== "authenticate" ||
            message.token !== options.token
          ) {
            socket.close(1008, "unauthorized");
            return;
          }

          const existing = openAISessions.get(sessionId);
          if (!existing) {
            sendFrame({ type: "error", message: "session not found" });
            socket.close(1008, "session not found");
            return;
          }

          authenticated = true;
          session = existing;
          eventListener = (event: OpenAIEvent) => sendFrame(event);
          session.on("event", eventListener);
          sendFrame({ type: "authenticated", sessionId });
          return;
        }

        if (!message || message.type === "authenticate") {
          sendFrame({ type: "error", message: "invalid request" });
          return;
        }

        if (message.type === "stop") {
          if (stopSession(true) === "busy") {
            sendFrame({ type: "error", message: "session busy" });
            return;
          }
          sendFrame({ type: "stopped", sessionId });
          return;
        }

        const current = openAISessions.get(sessionId);
        if (!current || current !== session) {
          sendFrame({ type: "error", message: "session not found" });
          socket.close(1011, "session destroyed");
          return;
        }

        if (sessionSendLeases.has(current)) {
          sendFrame({ type: "error", message: "session busy" });
          return;
        }

        const lease: SessionSendLease = { owner: connectionOwner };
        sessionSendLeases.set(current, lease);
        stopIssued = false;
        let sendPromise: Promise<void>;
        try {
          sendPromise = current.send(message.text);
        } catch (error) {
          if (sessionSendLeases.get(current) === lease) {
            sessionSendLeases.delete(current);
          }
          sendFrame({
            type: "error",
            message: String((error as Error)?.message ?? error),
          });
          return;
        }
        void sendPromise
          .catch((error: unknown) => {
            sendFrame({
              type: "error",
              message: String((error as Error)?.message ?? error),
            });
          })
          .finally(() => {
            if (sessionSendLeases.get(current) === lease) {
              sessionSendLeases.delete(current);
            }
          });
      });

      socket.on("close", () => {
        if (session && eventListener) session.off("event", eventListener);
        stopSession(false);
        session = undefined;
        eventListener = undefined;
      });
    },
  );
}
