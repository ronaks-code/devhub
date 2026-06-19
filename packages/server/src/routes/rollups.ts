/**
 * Daily usage rollups. A thin pass-through to the engine's `dailyUsage`, which
 * buckets token/cost usage by calendar day. The optional `since`/`until` window
 * (inclusive `YYYY-MM-DD` dates) and `projectId` narrow the result; with no
 * params it returns every day on record.
 *
 * This complements `/api/stats` (corpus-wide totals) and `/api/all-sessions`
 * (per-session listing): here we want the *time series* — usage per day — for a
 * usage/analytics view.
 *
 * NOTE (integration): the engine method `dailyUsage(since?, until?, projectId?)`
 * is not yet present on the published `Engine` surface. Rather than reference a
 * missing symbol (which would break `tsc`) or stub a `.d.ts`, this route resolves
 * the method at runtime through a narrow capability interface. The day the engine
 * exposes `dailyUsage`, this route serves it with no further changes; until then
 * it returns 501 instead of crashing.
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/**
 * The slice of the engine this route needs. Declared locally (not imported) so
 * the route compiles before the engine ships `dailyUsage`. Once the engine adds
 * the method this stays structurally compatible — it's just the same signature.
 */
interface DailyUsageCapable {
  dailyUsage(args: { since?: string; until?: string; projectId?: string }): unknown;
}

/** True when the engine actually implements `dailyUsage` at runtime. */
function hasDailyUsage(engine: Engine): engine is Engine & DailyUsageCapable {
  return typeof (engine as Partial<DailyUsageCapable>).dailyUsage === "function";
}

/**
 * Querystring for the rollups endpoint. Everything is optional. `since`/`until`
 * are inclusive ISO calendar dates (`YYYY-MM-DD`); `projectId` scopes to one
 * project. The date pattern is enforced here so a malformed value is rejected at
 * the boundary rather than reaching the engine.
 */
const ISO_DATE = "^\\d{4}-\\d{2}-\\d{2}$";

const rollupsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    since: { type: "string", pattern: ISO_DATE },
    until: { type: "string", pattern: ISO_DATE },
    projectId: { type: "string", minLength: 1 },
  },
} as const;

interface RollupsQuery {
  since?: string;
  until?: string;
  projectId?: string;
}

/** Wire the daily-usage rollups listing onto an app, backed by the engine. */
export function registerRollupsRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Querystring: RollupsQuery }>(
    "/api/rollups",
    { schema: { querystring: rollupsSchema } },
    async (req, reply) => {
      if (!hasDailyUsage(engine)) {
        return reply.code(501).send({ error: "dailyUsage not implemented by engine" });
      }
      const { since, until, projectId } = req.query;
      return engine.dailyUsage({ since, until, projectId });
    },
  );
}
