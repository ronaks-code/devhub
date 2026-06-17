/**
 * Cross-project session list. A thin pass-through to the engine's
 * `listAllSessions`, which returns every indexed session (across all projects)
 * with optional sort + facet narrowing (projectId / tag / model) and paging.
 *
 * This complements `/api/projects/:id/sessions` (one project) and `/api/search`
 * (full-text): here we want the *whole* corpus, sorted/filtered, for an
 * all-sessions browser view.
 */
import type { FastifyInstance } from "fastify";
import type { Engine, ListAllSessionsOptions } from "@claude-ui/engine";

/**
 * Sort keys the engine understands. Derived from the engine's own option type so
 * the route's enum can never drift from what `listAllSessions` actually accepts.
 */
type SortKey = NonNullable<ListAllSessionsOptions["sort"]>;
const SORT_VALUES: SortKey[] = ["recent", "tokens", "messages", "cost"];

/**
 * Querystring for the all-sessions listing. Everything is optional: with no
 * params it returns the full corpus, newest-first. `limit`/`offset` page the
 * result; the rest narrow it.
 */
const allSessionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sort: { type: "string", enum: [...SORT_VALUES] },
    projectId: { type: "string", minLength: 1 },
    tag: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

interface AllSessionsQuery {
  sort?: SortKey;
  projectId?: string;
  tag?: string;
  model?: string;
  limit?: number;
  offset?: number;
}

/** Wire the cross-project session listing onto an app, backed by the engine. */
export function registerAllSessionsRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Querystring: AllSessionsQuery }>(
    "/api/all-sessions",
    { schema: { querystring: allSessionsSchema } },
    async (req) => {
      const { sort, projectId, tag, model, limit, offset } = req.query;
      return engine.listAllSessions({
        sort,
        projectId,
        tag,
        model,
        limit: limit ?? 100,
        offset: offset ?? 0,
      });
    },
  );
}
