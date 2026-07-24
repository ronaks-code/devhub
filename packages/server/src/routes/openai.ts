/**
 * Development-only OpenAI Chat REST boundary.
 *
 * The feature is fail-closed: callers must explicitly enable it, configure the
 * DevHub access token, and present that token in an Authorization header on
 * every session read/mutation. Query-string tokens are deliberately ignored.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OpenAISession } from "@devhub/engine";
import type {
  OpenAIEvent,
  OpenAIModel,
  OpenAISessionOptions,
} from "@devhub/engine";

export interface ManagedOpenAISession {
  readonly model: string;
  readonly cwd: string;
  readonly localToolsEnabled: false;
  readonly messages: readonly unknown[];
  send(text: string): Promise<void>;
  stop(): void;
  on(event: "event", listener: (event: OpenAIEvent) => void): this;
  off(event: "event", listener: (event: OpenAIEvent) => void): this;
}

export type OpenAISessionFactory = (
  options?: OpenAISessionOptions,
) => ManagedOpenAISession;

export interface OpenAIRouteOptions {
  enabled?: boolean;
  token?: string;
  sessionFactory?: OpenAISessionFactory;
}

export interface OpenAIAvailability {
  enabled: boolean;
  authConfigured: boolean;
  models: OpenAIModel[];
  reason?: string;
}

export const openAISessions = new Map<string, ManagedOpenAISession>();

let sessionCounter = 0;
function newSessionId(): string {
  return `oai-${Date.now()}-${++sessionCounter}`;
}

const MODELS: OpenAIModel[] = [
  // Current lineup (GPT-5.6 family, 2026-07-09).
  "gpt-5.6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  // Retained so stored sessions on prior models still validate.
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o3",
  "o4-mini",
];

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

/**
 * Browser calls must come from the same hostname as DevHub. Loopback aliases
 * (`localhost` and `127.0.0.1`) are treated as equivalent so the Vite proxy and
 * packaged local server can use different loopback spellings/ports.
 * Requests without Origin remain available to local non-browser clients.
 */
export function isTrustedOpenAIOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true;
  if (!host || origin === "null") return false;

  try {
    const source = new URL(origin);
    const target = new URL(`http://${host}`);
    if (source.protocol !== "http:" && source.protocol !== "https:") return false;

    const sourceHost = source.hostname.toLowerCase();
    const targetHost = target.hostname.toLowerCase();
    return (
      sourceHost === targetHost ||
      (isLoopbackHostname(sourceHost) && isLoopbackHostname(targetHost))
    );
  } catch {
    return false;
  }
}

function availability(options: OpenAIRouteOptions): OpenAIAvailability {
  const enabled = options.enabled === true;
  const authConfigured = Boolean(options.token);
  if (!enabled) {
    return {
      enabled,
      authConfigured,
      models: [],
      reason:
        "OpenAI Chat is disabled. Start DevHub with DEVHUB_ENABLE_OPENAI_CHAT=1 to opt in.",
    };
  }
  if (!authConfigured) {
    return {
      enabled,
      authConfigured,
      models: [],
      reason:
        "OpenAI Chat requires a configured DevHub access token before it can create sessions.",
    };
  }
  return { enabled, authConfigured, models: [...MODELS] };
}

function sendUnavailable(reply: FastifyReply, options: OpenAIRouteOptions): void {
  const state = availability(options);
  reply.code(503).send({
    error: state.reason,
    enabled: state.enabled,
    authConfigured: state.authConfigured,
  });
}

function authorizeSessionRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OpenAIRouteOptions,
): boolean {
  if (options.enabled !== true || !options.token) {
    sendUnavailable(reply, options);
    return false;
  }

  if (request.headers.authorization !== `Bearer ${options.token}`) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }

  if (!isTrustedOpenAIOrigin(request.headers.origin, request.headers.host)) {
    reply.code(403).send({ error: "untrusted origin" });
    return false;
  }

  return true;
}

/** Register fail-closed OpenAI REST routes on the Fastify app. */
export function registerOpenAIRoutes(
  app: FastifyInstance,
  options: OpenAIRouteOptions = {},
): void {
  const sessionFactory: OpenAISessionFactory =
    options.sessionFactory ?? ((input) => new OpenAISession(input));
  const requireSessionAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorizeSessionRequest(request, reply, options)) return reply;
  };

  app.get("/api/openai/models", async (_request, reply) => {
    return reply.send(availability(options));
  });

  app.get(
    "/api/openai/sessions",
    { onRequest: requireSessionAccess },
    async (_request, reply) => {
      const sessions = [...openAISessions.entries()].map(([sessionId, session]) => ({
        sessionId,
        model: session.model,
        cwd: session.cwd,
        messageCount: session.messages.length,
        localToolsEnabled: session.localToolsEnabled,
      }));
      return reply.send({ sessions });
    },
  );

  app.post<{ Body: OpenAISessionOptions }>(
    "/api/openai/sessions",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string", enum: MODELS },
            cwd: { type: "string", minLength: 1, maxLength: 4096 },
            systemPrompt: { type: "string", maxLength: 100_000 },
          },
        },
      },
      preValidation: async (request, reply) => {
        const body = request.body as unknown as Record<string, unknown> | undefined;
        const attemptedToolOptIn = ["tools", "toolsEnabled", "localToolsEnabled"].some(
          (key) => body != null && Object.prototype.hasOwnProperty.call(body, key),
        );
        if (attemptedToolOptIn) {
          return reply.code(400).send({
            error: "OpenAI Chat is chat-only; local tools cannot be enabled",
          });
        }
      },
      onRequest: requireSessionAccess,
    },
    async (request, reply) => {
      const input = request.body ?? {};
      const sessionId = newSessionId();
      const session = sessionFactory(input);
      openAISessions.set(sessionId, session);
      return reply.code(201).send({
        sessionId,
        localToolsEnabled: session.localToolsEnabled,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/openai/sessions/:id/stop",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 512 } },
        },
      },
      onRequest: requireSessionAccess,
    },
    async (request, reply) => {
      const session = openAISessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "session not found" });
      session.stop();
      return reply.send({ ok: true, sessionId: request.params.id });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/openai/sessions/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 512 } },
        },
      },
      onRequest: requireSessionAccess,
    },
    async (request, reply) => {
      const session = openAISessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "session not found" });
      session.stop();
      openAISessions.delete(request.params.id);
      return reply.code(204).send();
    },
  );
}
