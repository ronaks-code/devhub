/**
 * Codex session routes — exposes the Codex CLI session data (from
 * ~/.codex/sessions) over HTTP. These are standalone engine functions that
 * do not require an Engine instance.
 *
 * GET /api/codex/sessions — list the most recent 200 Codex sessions
 * GET /api/codex/stats    — aggregate stats (total, last 30/7 days, top cwds)
 */
import type { FastifyInstance } from "fastify";
import { listCodexSessions, getCodexStats } from "@devhub/engine";

/** Register Codex routes on the Fastify app. */
export function registerCodexRoutes(app: FastifyInstance): void {
  // GET /api/codex/sessions — list all Codex sessions (newest first, max 200)
  app.get("/api/codex/sessions", async (_req, reply) => {
    const sessions = await listCodexSessions();
    return reply.send(sessions);
  });

  // GET /api/codex/stats — aggregate stats across all Codex sessions
  app.get("/api/codex/stats", async (_req, reply) => {
    const stats = await getCodexStats();
    return reply.send(stats);
  });
}
