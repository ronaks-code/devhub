/**
 * Session-scoped full-text search.
 *
 *   GET /api/search/session?sessionId=&q=&limit=
 *     → ALL matching rows WITHIN one session, for the "expand to see every match
 *       in this session" affordance in the UI.
 *
 * This complements the cross-project `/api/search` (left untouched in app.ts),
 * which returns only the single BEST hit per session (deduped). Here we want the
 * full set of matches inside a chosen session, so it is backed by a distinct
 * engine method: `engine.searchInSession(sessionId, query, { limit })`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOL: `Engine.searchInSession` is not yet declared on the
 * exported `Engine` type. Per package constraints we do NOT edit the engine or
 * add a global `.d.ts` shim for it. Instead we declare the EXPECTED signature as
 * a narrow, in-package structural type (`SessionSearchEngine`) and call through
 * it at the one call site. When the engine adds the method this cast becomes a
 * no-op; until then this is the single, clearly-labelled place that depends on it.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine, SearchHit } from "@devhub/engine";

/**
 * The session-scoped search method we expect the engine to expose. Mirrors the
 * cross-project `search(query, { limit })` contract but pins it to one session
 * and returns EVERY matching row (not deduped to one-per-session).
 */
interface SessionSearchEngine {
  searchInSession(
    sessionId: string,
    query: string,
    opts?: { limit?: number },
  ): SearchHit[];
}

const sessionSearchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "q"],
  properties: {
    sessionId: { type: "string", minLength: 1 },
    q: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
  },
} as const;

interface SessionSearchQuery {
  sessionId: string;
  q: string;
  limit?: number;
}

/**
 * Wire GET /api/search/session onto an app. A bad/unknown session simply yields
 * no hits (the engine returns []), so there is nothing extra to reject here.
 */
export function registerSearchRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Querystring: SessionSearchQuery }>(
    "/api/search/session",
    { schema: { querystring: sessionSearchSchema } },
    async (req) => {
      const { sessionId, q, limit } = req.query;
      // See header note: cast through the expected-method structural type.
      return (engine as unknown as SessionSearchEngine).searchInSession(sessionId, q, {
        limit: limit ?? 100,
      });
    },
  );
}
