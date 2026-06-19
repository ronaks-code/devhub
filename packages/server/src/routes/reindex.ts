/**
 * Force a full re-index: POST /api/reindex
 *
 *   POST /api/reindex  ->  { started: true }   (kicked off in the BACKGROUND)
 *
 * Why a forced pass: an incremental `indexAll()` only touches files that are new
 * or changed, so a NEW analytics column/table (e.g. the `tool_calls` table, or a
 * null `sessions.model` left by an older index) is never backfilled for sessions
 * that haven't changed on disk. Forcing re-reads every transcript so those gaps
 * fill in. This is the heavy "rebuild" affordance — POST (not GET), since it's a
 * mutation-ish action that does real work.
 *
 * BACKGROUND + de-dupe: a full reindex of a large corpus is slow, so we never
 * block the HTTP response on it — we fire `engine.indexAll(...)` without awaiting
 * and ack immediately (202). Progress already flows over the existing SSE
 * `/api/events` stream (`index-progress` / `ready` events), so we do NOT duplicate
 * it here — the client watches that stream. A module-local in-flight flag guards
 * against two rapid POSTs starting two concurrent full reindexes; the second is
 * acked as `{ started: true, alreadyRunning: true }` without launching a run.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOL: the `{ force }` option on `Engine.indexAll` is being
 * added by the engine lane THIS SAME WAVE, so the published `indexAll` type still
 * takes no args. Per package constraints we do NOT edit the engine or add a
 * `.d.ts` shim. Instead we probe the arity/behavior at runtime: we always CALL it
 * with `{ force: true }` (the engine ignores unknown args harmlessly when the
 * option hasn't landed), and we treat the call as best-effort. If forcing isn't
 * available the route still works — it just runs an un-forced incremental pass —
 * and a half-landed engine that throws is swallowed (logged) so we never 500.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/**
 * The forced-reindex shape we expect `Engine.indexAll` to grow this wave. Kept as
 * a narrow in-package structural type so we don't pin the engine's exact options
 * object from this lane; the engine ignores `force` when it hasn't landed yet.
 */
interface ForceIndexEngine {
  indexAll(opts?: { force?: boolean }): Promise<void>;
}

/**
 * Module-local guard: true while a reindex this server kicked off is still
 * running, so two rapid POSTs don't launch two concurrent full passes. The engine
 * itself also no-ops a re-entrant `indexAll` (its private `indexing` flag), but we
 * track it here too so the SECOND POST can be acked as `alreadyRunning` instead of
 * silently doing nothing. Scoped per-process (one engine per server), which is all
 * this route needs.
 */
let reindexInFlight = false;

/** Wire POST /api/reindex onto an app. */
export function registerReindexRoutes(app: FastifyInstance, engine: Engine): void {
  app.post("/api/reindex", async (_req, reply) => {
    // De-dupe: a reindex we started is still going — ack without starting a second.
    if (reindexInFlight) {
      reply.code(202);
      return { started: true, alreadyRunning: true };
    }

    reindexInFlight = true;
    // Fire-and-forget: do NOT await — a full reindex of a large corpus is slow and
    // we must not block the response. See header note on the `{ force }` capability
    // guard: we always pass `{ force: true }` (harmlessly ignored when the option
    // hasn't landed), swallow any error from a half-landed engine, and clear the
    // in-flight flag when the pass settles so a later POST can reindex again.
    const indexAll = (engine as unknown as ForceIndexEngine).indexAll.bind(engine);
    void Promise.resolve()
      .then(() => indexAll({ force: true }))
      .catch((err) => {
        console.warn("[server] forced reindex failed:", err);
      })
      .finally(() => {
        reindexInFlight = false;
      });

    // Progress (index-progress / ready) streams over the existing /api/events SSE.
    reply.code(202);
    return { started: true };
  });
}
