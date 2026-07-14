/**
 * OpenAI session REST routes.
 *
 * GET    /api/openai/models   — list available OpenAI models
 * GET    /api/openai/sessions — list all tracked sessions (in-memory)
 * POST   /api/openai/sessions — create a new OpenAI session
 * DELETE /api/openai/sessions/:id — destroy a session
 *
 * The session Map is exported so openai-ws.ts can share the same store without
 * duplicating state.
 */
import type { FastifyInstance } from "fastify";
import { OpenAISession } from "@devhub/engine";
import type { OpenAIModel, OpenAISessionOptions } from "@devhub/engine";

// ---------------------------------------------------------------------------
// Shared session store (REST + WS share the same Map)
// ---------------------------------------------------------------------------

export const openAISessions = new Map<string, OpenAISession>();

let _sessionCounter = 0;
function newSessionId(): string {
  return `oai-${Date.now()}-${++_sessionCounter}`;
}

// ---------------------------------------------------------------------------
// Available models (kept in sync with OpenAIModel type)
// ---------------------------------------------------------------------------

const MODELS: OpenAIModel[] = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o3",
  "o4-mini",
];

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** Register OpenAI REST routes on the Fastify app. */
export function registerOpenAIRoutes(app: FastifyInstance): void {
  // GET /api/openai/models — list available models
  app.get("/api/openai/models", async (_req, reply) => {
    return reply.send(MODELS);
  });

  // GET /api/openai/sessions — list all in-memory sessions (metadata only)
  app.get("/api/openai/sessions", async (_req, reply) => {
    const list = [...openAISessions.entries()].map(([id, session]) => ({
      sessionId: id,
      model: session.model,
      cwd: session.cwd,
      messageCount: session.messages.length,
    }));
    return reply.send(list);
  });

  // POST /api/openai/sessions — create a new session
  app.post<{ Body: OpenAISessionOptions }>(
    "/api/openai/sessions",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string" },
            cwd: { type: "string" },
            systemPrompt: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const sessionId = newSessionId();
      const session = new OpenAISession(req.body ?? {});
      openAISessions.set(sessionId, session);
      return reply.code(201).send({ sessionId });
    },
  );

  // DELETE /api/openai/sessions/:id — destroy a session
  app.delete<{ Params: { id: string } }>(
    "/api/openai/sessions/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const session = openAISessions.get(req.params.id);
      if (!session) return reply.code(404).send({ error: "session not found" });
      session.stop();
      openAISessions.delete(req.params.id);
      return reply.code(204).send();
    },
  );
}
