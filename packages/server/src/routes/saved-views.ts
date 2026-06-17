/**
 * Saved views ("smart folders") — a user's named, re-runnable search (a query
 * string + the search facets to AND onto it).
 *
 *   GET    /api/saved-views        → list every saved view (newest first)
 *   POST   /api/saved-views        → create one { name, query, facets }
 *   DELETE /api/saved-views/:id     → remove one by numeric id
 *
 * These are thin pass-throughs to the engine's saved-views surface
 * (`listSavedViews` / `saveView` / `deleteView`), which persists them in the
 * index DB (never a transcript). Re-running a view is just
 * `engine.search(view.query, view.facets)`, so a view is exactly what `search`
 * already understands.
 */
import type { FastifyInstance } from "fastify";
import type { Engine, SearchFacets } from "@claude-ui/engine";

/**
 * Body for create: a non-empty `name`, a `query` (may be empty for a facet-only
 * view), and the `facets` object. `facets` is validated only as an object here —
 * the engine + search own the exact facet-key contract.
 */
const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "query", "facets"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    query: { type: "string" },
    facets: { type: "object" },
  },
} as const;

/** Param schema: a numeric id (digits only — coerced to a number below). */
const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: "^\\d+$" } },
} as const;

interface CreateBody {
  name: string;
  query: string;
  facets: SearchFacets;
}

/** Wire the saved-views CRUD routes onto an app, backed by the engine. */
export function registerSavedViewsRoutes(app: FastifyInstance, engine: Engine): void {
  app.get("/api/saved-views", async () => engine.listSavedViews());

  app.post<{ Body: CreateBody }>(
    "/api/saved-views",
    { schema: { body: createSchema } },
    async (req, reply) => {
      const { name, query, facets } = req.body;
      // Schema enforces minLength on name, but a whitespace-only value would slip
      // through — reject it so we never create a blank-labelled folder. (The engine
      // also guards this; we surface a clean 400 rather than a thrown 500.)
      if (name.trim().length === 0) {
        return reply.code(400).send({ error: "name must not be blank" });
      }
      return engine.saveView({ name, query, facets });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/saved-views/:id",
    { schema: { params: idParamSchema } },
    async (req) => {
      // The pattern guarantees digits-only; Number() yields a finite integer id.
      const removed = engine.deleteView(Number(req.params.id));
      return { ok: true, removed };
    },
  );
}
