/**
 * Stop a running Claude process. The ONE place in this package that signals a
 * foreign OS process, so it is deliberately narrow and guarded:
 *
 *   POST /api/running/stop  { pid, confirm:true }  -> SIGTERM that pid
 *
 * SECURITY — allowlist + confirm:
 *   • The pid is honored ONLY when it currently appears in
 *     `engine.getRunningSessions()` AND that session is `alive` (a real live OS
 *     process, not a stale `<pid>.json`). A pid that isn't a known live session
 *     is rejected — we never let this become a kill-any-process primitive:
 *       - unknown pid (no matching session file)      -> 404
 *       - known session but already dead/stale         -> 404
 *   • Destructive, so it requires an explicit `{ confirm: true }` (mirrors the
 *     discard route in git-actions.ts); anything else is a 400.
 *
 * We send SIGTERM (graceful: ask the process to exit, let it clean up its
 * `<pid>.json`), never SIGKILL — stopping a Claude session, not force-killing it.
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/** Body for the stop: a positive integer `pid` and a required `confirm` flag. */
const stopSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pid", "confirm"],
  properties: {
    pid: { type: "integer", minimum: 1 },
    confirm: { type: "boolean" },
  },
} as const;

/** Wire POST /api/running/stop onto an app. */
export function registerRunningRoutes(app: FastifyInstance, engine: Engine): void {
  app.post<{ Body: { pid: number; confirm: boolean } }>(
    "/api/running/stop",
    { schema: { body: stopSchema } },
    async (req, reply) => {
      const { pid, confirm } = req.body;
      if (confirm !== true) {
        return reply.code(400).send({ error: "confirm:true required" });
      }

      // The pid must match a CURRENTLY-running session. Re-read live (cheap) so a
      // session that started/exited at runtime is reflected without a restart.
      const sessions = await engine.getRunningSessions();
      const match = sessions.find((s) => s.pid === pid);
      if (!match) {
        return reply.code(404).send({ error: "no such running session" });
      }
      // A known-but-dead entry is a stale `<pid>.json`; the OS process is gone, so
      // there is nothing to signal (and signaling a recycled pid would be wrong).
      if (!match.alive) {
        return reply.code(404).send({ error: "session not alive" });
      }

      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Raced: the process exited between our liveness check and the signal.
        if (code === "ESRCH") {
          return reply.code(404).send({ error: "session not alive" });
        }
        return reply.code(400).send({ error: (err as Error).message });
      }

      return { ok: true, pid, signal: "SIGTERM" };
    },
  );
}
