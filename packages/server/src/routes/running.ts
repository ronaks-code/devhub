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
import type { RunningSession } from "@devhub/engine/types";

/**
 * Collapse duplicate `<pid>.json` entries that share one sessionId into a single
 * session for the GET /api/running payload.
 *
 * WHY: Claude Code can leave more than one live `<pid>.json` pointing at the SAME
 * sessionId (e.g. a session resumed under a new pid while the old process file —
 * or even the old process — lingers). Faces key their cards/panels by sessionId,
 * so serving the same id twice produced duplicate React keys, phantom cards, and
 * contradictory counts ("4 running" vs a grid that can only watch 3 unique
 * sessions). The stop route deliberately keeps using the RAW engine list — it is
 * pid-addressed, so a shadowed pid stays stoppable.
 *
 * Winner per sessionId (first match wins):
 *   1. alive over dead,
 *   2. most recent `updatedAt`,
 *   3. most recent `statusUpdatedAt`,
 *   4. highest pid (newest process, as a final deterministic tiebreak).
 * Entries with an EMPTY sessionId can't be identified as the same session, so they
 * all pass through untouched. Output preserves the input's ordering (each winner
 * sits where that session first appeared).
 */
export function dedupeRunningSessions(sessions: RunningSession[]): RunningSession[] {
  const winners = new Map<string, RunningSession>();
  const order: Array<string | RunningSession> = [];
  const better = (a: RunningSession, b: RunningSession): boolean => {
    if (a.alive !== b.alive) return a.alive;
    const aUpd = a.updatedAt ?? 0;
    const bUpd = b.updatedAt ?? 0;
    if (aUpd !== bUpd) return aUpd > bUpd;
    const aStat = a.statusUpdatedAt ?? 0;
    const bStat = b.statusUpdatedAt ?? 0;
    if (aStat !== bStat) return aStat > bStat;
    return a.pid > b.pid;
  };
  for (const s of sessions) {
    if (!s.sessionId) {
      order.push(s); // unidentifiable — never merged
      continue;
    }
    const seen = winners.get(s.sessionId);
    if (!seen) {
      winners.set(s.sessionId, s);
      order.push(s.sessionId);
    } else if (better(s, seen)) {
      winners.set(s.sessionId, s);
    }
  }
  return order.map((slot) =>
    typeof slot === "string" ? (winners.get(slot) as RunningSession) : slot,
  );
}

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
