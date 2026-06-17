/**
 * Read-only git REST surface. Each route is a thin pass-through to the engine's
 * GitService for a project working directory: status / diff / branches / log.
 *
 * SECURITY — cwd allowlist: a `cwd` is only honored when it exactly matches a
 * known project's cwd from the engine (archived included). This is the whole
 * point of the gate: without it, anyone hitting these endpoints could run git
 * in an arbitrary directory on the host. An unknown cwd is rejected with 400.
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";

/** Querystring requiring only a `cwd` (status / branches). */
const cwdSchema = {
  type: "object",
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
  },
} as const;

/** Querystring for diff: a required `cwd` plus an optional `file` to scope it. */
const diffSchema = {
  type: "object",
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    file: { type: "string" },
  },
} as const;

/** Querystring for log: a required `cwd` plus an optional commit `limit`. */
const logSchema = {
  type: "object",
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 20 },
  },
} as const;

/**
 * Wire the read-only git routes onto an app, backed by the engine. The allowlist
 * is recomputed per request (cheap, in-memory) so a project added at runtime is
 * immediately reachable without a server restart.
 */
export function registerGitRoutes(app: FastifyInstance, engine: Engine): void {
  /** True when `cwd` is a known project path (archived projects included). */
  const isKnownCwd = (cwd: string): boolean =>
    engine.getProjects({ includeArchived: true }).some((p) => p.cwd === cwd);

  app.get<{ Querystring: { cwd: string } }>(
    "/api/git/status",
    { schema: { querystring: cwdSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).status();
    },
  );

  app.get<{ Querystring: { cwd: string; file?: string } }>(
    "/api/git/diff",
    { schema: { querystring: diffSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).diff(req.query.file);
    },
  );

  app.get<{ Querystring: { cwd: string } }>(
    "/api/git/branches",
    { schema: { querystring: cwdSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).branchList();
    },
  );

  app.get<{ Querystring: { cwd: string; limit?: number } }>(
    "/api/git/log",
    { schema: { querystring: logSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).log(req.query.limit ?? 20);
    },
  );
}
