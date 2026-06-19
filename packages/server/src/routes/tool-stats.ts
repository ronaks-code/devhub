/**
 * Per-tool analytics: GET /api/stats/tools
 *
 *   GET /api/stats/tools?projectId=&sessionId=&limit=
 *     → usage stats per tool (e.g. how often each tool was invoked), ranked
 *       best-first, for a "which tools do I lean on" affordance in the UI.
 *
 * The optional `projectId`/`sessionId` narrow the scope (one project / one
 * session); `limit` caps how many tools come back. With no params it summarizes
 * the whole corpus.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOL: `Engine.toolStats` is being added by the engine lane
 * THIS SAME WAVE, so it is not yet declared on the exported `Engine` type. Per
 * package constraints we do NOT edit the engine or add a global `.d.ts` shim for
 * it. Instead we declare the EXPECTED signature as a narrow, in-package
 * structural type (`ToolStatsEngine`) and probe for it at runtime: when the
 * engine adds the method this becomes ranked results; until then a MISSING
 * method (typeof guard) — or a method that's only HALF-landed and throws (e.g.
 * the Engine wrapper exists but its index backing doesn't yet) — both degrade to
 * `{ tools: [] }` (200, never a 500), so the route is safe to ship at any point
 * along the engine lane's landing.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/**
 * The per-tool analytics method we expect the engine to expose. We keep the
 * return type deliberately loose (`unknown` / a thenable of one) so we don't pin
 * the engine's exact result shape from this lane — the route just forwards
 * whatever ranked summary the engine returns. May be sync or async; we `await`
 * either way.
 */
interface ToolStatsEngine {
  toolStats(
    opts?: { projectId?: string; sessionId?: string; limit?: number },
  ): unknown | Promise<unknown>;
}

const toolStatsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
} as const;

interface ToolStatsQuery {
  projectId?: string;
  sessionId?: string;
  limit?: number;
}

/**
 * Wire GET /api/stats/tools onto an app. The engine method may not exist at
 * runtime yet (it lands this same wave); when absent we return an empty result
 * rather than erroring, so the route is harmless until the engine catches up.
 */
export function registerToolStatsRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Querystring: ToolStatsQuery }>(
    "/api/stats/tools",
    { schema: { querystring: toolStatsSchema } },
    async (req) => {
      const { projectId, sessionId } = req.query;
      const limit = req.query.limit ?? 50;
      // See header note: probe for the expected method at runtime; degrade to an
      // empty result when the engine hasn't added it yet (typeof guard) OR when a
      // half-landed engine exposes the method but it throws (try/catch) — never
      // surface a 500 here.
      const fn = (engine as unknown as Partial<ToolStatsEngine>).toolStats;
      if (typeof fn !== "function") return { tools: [] };
      try {
        return (await fn.call(engine, { projectId, sessionId, limit })) ?? { tools: [] };
      } catch {
        return { tools: [] };
      }
    },
  );
}
