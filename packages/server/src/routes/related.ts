/**
 * Related sessions: GET /api/sessions/:id/related
 *
 *   GET /api/sessions/:id/related?limit=
 *     → sessions related to the given one (e.g. same project / overlapping content),
 *       ranked best-first, for a "you might also want" affordance in the UI.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOL: `Engine.relatedSessions` is being added by the engine lane
 * THIS SAME WAVE, so it is not yet declared on the exported `Engine` type. Per
 * package constraints we do NOT edit the engine or add a global `.d.ts` shim for it.
 * Instead we declare the EXPECTED signature as a narrow, in-package structural type
 * (`RelatedSessionsEngine`) and probe for it at runtime: when the engine adds the
 * method this becomes ranked results; until then a MISSING method (typeof guard) —
 * or a method that's only HALF-landed and throws (e.g. the Engine wrapper exists but
 * its index backing doesn't yet) — both degrade to `[]` (200, never a 500), so the
 * route is safe to ship at any point along the engine lane's landing.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/**
 * The related-sessions method we expect the engine to expose. We keep the return
 * type deliberately loose (`unknown[]` / a thenable of one) so we don't pin the
 * engine's exact item shape from this lane — the route just forwards whatever ranked
 * list the engine returns. May be sync or async; we `await` either way.
 */
interface RelatedSessionsEngine {
  relatedSessions(
    sessionId: string,
    opts?: { limit?: number },
  ): unknown[] | Promise<unknown[]>;
}

const relatedSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
  },
} as const;

interface RelatedQuery {
  limit?: number;
}

/**
 * Wire GET /api/sessions/:id/related onto an app. The engine method may not exist at
 * runtime yet (it lands this same wave); when absent we return an empty array rather
 * than erroring, so the route is harmless until the engine catches up.
 */
export function registerRelatedRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Params: { id: string }; Querystring: RelatedQuery }>(
    "/api/sessions/:id/related",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        querystring: relatedSchema,
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 10;
      // See header note: probe for the expected method at runtime; degrade to [] when
      // the engine hasn't added it yet (typeof guard) OR when a half-landed engine
      // exposes the method but it throws (try/catch) — never surface a 500 here.
      const fn = (engine as unknown as Partial<RelatedSessionsEngine>).relatedSessions;
      if (typeof fn !== "function") return [];
      try {
        return (await fn.call(engine, req.params.id, { limit })) ?? [];
      } catch {
        return [];
      }
    },
  );
}
