/**
 * Code-symbol search within a project working directory:
 *
 *   GET /api/symbols?cwd=&q=&limit= → engine.searchSymbols(cwd, q, { limit })
 *
 * This complements the message FTS (`/api/search`) — that searches what was SAID
 * in transcripts; this searches code SYMBOLS (functions/classes/etc.) under a
 * project's working tree, for an "@-symbol" / jump-to-definition affordance.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SECURITY — cwd allowlist: a `cwd` is only honored when it exactly matches a
 * known project's cwd from the engine (archived included). This mirrors the
 * git/files gate exactly: without it, anyone hitting this endpoint could index
 * an arbitrary directory on the host. An unknown cwd is rejected with 400.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * MISSING ENGINE SYMBOL: `Engine.searchSymbols` is not yet declared on the
 * exported `Engine` type (verified: no definition exists in the engine package).
 * Per package constraints we do NOT edit the engine or add a global `.d.ts` shim.
 * Instead we declare the EXPECTED signature as a narrow, in-package structural
 * type (`SymbolSearchCapable`) and resolve it at runtime: if the engine doesn't
 * implement it yet, the route returns 501 rather than crashing `tsc` or the
 * server. The day the engine ships `searchSymbols`, this route serves it with no
 * further changes.
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/**
 * The symbol-search method we expect the engine to expose. Declared locally (not
 * imported) so the route compiles before the engine ships `searchSymbols`. Once
 * the engine adds the method this stays structurally compatible.
 */
interface SymbolSearchCapable {
  searchSymbols(cwd: string, q: string, opts?: { limit?: number }): unknown;
}

/** True when the engine actually implements `searchSymbols` at runtime. */
function hasSearchSymbols(engine: Engine): engine is Engine & SymbolSearchCapable {
  return typeof (engine as Partial<SymbolSearchCapable>).searchSymbols === "function";
}

const symbolsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd", "q"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    q: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
} as const;

interface SymbolsQuery {
  cwd: string;
  q: string;
  limit?: number;
}

/**
 * Wire GET /api/symbols onto an app, backed by the engine. The allowlist is
 * recomputed per request (cheap, in-memory) so a project added at runtime is
 * immediately reachable without a server restart.
 */
export function registerSymbolsRoutes(app: FastifyInstance, engine: Engine): void {
  /** True when `cwd` is a known project path (archived projects included). */
  const isKnownCwd = (cwd: string): boolean =>
    engine.getProjects({ includeArchived: true }).some((p) => p.cwd === cwd);

  app.get<{ Querystring: SymbolsQuery }>(
    "/api/symbols",
    { schema: { querystring: symbolsSchema } },
    async (req, reply) => {
      const { cwd, q, limit } = req.query;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      if (!hasSearchSymbols(engine)) {
        return reply.code(501).send({ error: "searchSymbols not implemented by engine" });
      }
      return engine.searchSymbols(cwd, q, { limit: limit ?? 50 });
    },
  );
}
