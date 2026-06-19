/**
 * Index integrity check + repair: GET /api/maintenance/integrity, POST /api/maintenance/repair
 *
 *   GET /api/maintenance/integrity
 *     → the engine's integrity report (`engine.checkIntegrity()`): a quick, bounded
 *       audit of OUR index DB (orphaned rows, missing aggregates, schema drift) so a
 *       face can surface "your index looks healthy / has N issues" without the user
 *       guessing. READ-only — it never touches transcripts or rewrites the index.
 *
 *   POST /api/maintenance/repair
 *     → kick off `engine.repairIntegrity()` to fix what the check found. This may
 *       re-derive (reindex) sessions, which can be slow on a large corpus, so we run
 *       it in the BACKGROUND and ack immediately (202) exactly like POST /api/reindex
 *       — progress flows over the existing /api/events SSE. A module-local in-flight
 *       flag de-dupes two rapid POSTs so we never launch two concurrent repairs.
 *
 * SAFETY: repair operates ONLY on our own index DB and prefers RE-DERIVATION
 * (reindex from the on-disk transcripts) over destructive deletes — it never deletes
 * or corrupts user data or ~/.claude transcripts. The check is purely read-only.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOLS: `Engine.checkIntegrity()` and `Engine.repairIntegrity()`
 * are being added by the engine lane THIS SAME WAVE, so neither is declared on the
 * exported `Engine` type yet. Per package constraints we do NOT edit the engine or
 * add a global `.d.ts` shim. Instead we declare the EXPECTED signatures as a narrow,
 * in-package structural type (`IntegrityEngine`) and probe for them at runtime:
 *   - GET degrades to a minimal healthy report `{ ok: true, issues: [], unavailable:
 *     true }` (200) when `checkIntegrity` is absent (typeof guard) or half-landed and
 *     throws (try/catch) — never a 500.
 *   - POST acks `{ started: true, unavailable: true }` (202) when `repairIntegrity`
 *     is absent, and swallows a throwing half-landed engine in the background — never
 *     a 500.
 * Both are safe to ship at any point along the engine lane's landing.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/**
 * The integrity methods we PROBE on the engine, both added by the engine lane this
 * wave. `checkIntegrity()` is read-only and returns a report; `repairIntegrity()`
 * fixes the issues (possibly via reindex). Both are optional here and may be sync or
 * async — we `await` either way. Return types are loose so we don't pin the engine's
 * exact report shape from this lane; the route forwards whatever the engine computes.
 */
interface IntegrityEngine {
  checkIntegrity?: () => unknown | Promise<unknown>;
  repairIntegrity?: () => unknown | Promise<unknown>;
}

/**
 * The minimal report we synthesize when `checkIntegrity` isn't available (absent or
 * half-landed). `unavailable: true` lets a face distinguish "checked, all clear"
 * from "couldn't check yet" while still rendering the healthy/empty state.
 */
interface IntegrityReportShape {
  ok: boolean;
  issues: unknown[];
  unavailable?: boolean;
}

/**
 * Module-local guard: true while a repair this server kicked off is still running, so
 * two rapid POSTs don't launch two concurrent repairs. Mirrors reindex.ts — a repair
 * may reindex many sessions, so it runs in the background and the SECOND POST is acked
 * as `alreadyRunning` instead of starting a duplicate. Scoped per-process (one engine
 * per server), which is all this route needs.
 */
let repairInFlight = false;

/** Wire GET /api/maintenance/integrity + POST /api/maintenance/repair onto an app. */
export function registerMaintenanceRoutes(app: FastifyInstance, engine: Engine): void {
  app.get("/api/maintenance/integrity", async () => {
    const check = (engine as unknown as IntegrityEngine).checkIntegrity;
    if (typeof check === "function") {
      try {
        const out = await check.call(engine);
        if (out && typeof out === "object") return out as IntegrityReportShape;
      } catch {
        // Half-landed / throwing — fall through to the degraded report, never a 500.
      }
    }
    // Degraded: report a clean, empty audit flagged `unavailable` so the face knows
    // the check couldn't run yet (engine method absent or threw). Always 200.
    return { ok: true, issues: [], unavailable: true } satisfies IntegrityReportShape;
  });

  app.post("/api/maintenance/repair", async (_req, reply) => {
    const repair = (engine as unknown as IntegrityEngine).repairIntegrity;
    // Capability guard: the engine method hasn't landed — ack without starting work.
    if (typeof repair !== "function") {
      reply.code(202);
      return { started: true, unavailable: true };
    }

    // De-dupe: a repair we started is still going — ack without starting a second.
    if (repairInFlight) {
      reply.code(202);
      return { started: true, alreadyRunning: true };
    }

    repairInFlight = true;
    // Fire-and-forget: a repair may re-derive (reindex) many sessions and is slow, so
    // we must not block the response. Progress flows over the existing /api/events SSE
    // (index-progress / ready), so we do NOT duplicate it here. Swallow any error from
    // a half-landed engine (logged) so we never 500, and clear the in-flight flag when
    // the run settles so a later POST can repair again.
    void Promise.resolve()
      .then(() => repair.call(engine))
      .catch((err) => {
        console.warn("[server] integrity repair failed:", err);
      })
      .finally(() => {
        repairInFlight = false;
      });

    reply.code(202);
    return { started: true };
  });
}
