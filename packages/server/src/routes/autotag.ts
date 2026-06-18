/**
 * Auto-tagging: GET /api/sessions/:id/autotag/suggest, POST /api/sessions/:id/autotag
 *
 *   GET /api/sessions/:id/autotag/suggest
 *     → the SUGGESTED auto-tags for a session, PREVIEW only (never persisted), via
 *       `engine.autoTagSession(id)` (a W21 method, already published — we call it
 *       directly). Lets a face show "we'd add: node, typescript, branch:foo" before
 *       the user commits. Returns `{ suggested: string[] }`; degrades to `{ suggested:
 *       [] }` (200) if the engine throws — never a 500.
 *
 *   POST /api/sessions/:id/autotag
 *     → APPLY the suggested tags: merge them into the session's existing tags and
 *       persist (sidecar — session_meta.tags, never the transcript). Returns the
 *       engine's `{ applied, added }` result, where `applied` is the full persisted
 *       set and `added` are the tags that were newly introduced this call.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOL: `Engine.applyAutoTags(id)` is being added by the engine lane
 * THIS SAME WAVE — it computes the suggestions, merges them into the existing tags,
 * persists via the same setTags path, and returns `{ applied, added }`. It is not yet
 * declared on the exported `Engine` type. Per package constraints we do NOT edit the
 * engine or add a global `.d.ts` shim. Instead we declare the EXPECTED signature as a
 * narrow, in-package structural type (`AutoTagEngine`) and probe for it at runtime:
 *   - When `applyAutoTags` is present we forward to it (try/catch — a half-landed
 *     engine that throws falls through to the LOCAL path below rather than 500ing).
 *   - When it's ABSENT we don't fail: we reproduce the apply ourselves from the
 *     already-published `autoTagSession` + `getTags` + `setTags` methods — read the
 *     current tags, union the suggestions in, persist, and compute `added` as the
 *     difference. Same shape, same sidecar write path. Only if even THAT can't run
 *     (the published methods somehow throw) do we 503 — never a 500.
 * Safe to ship at any point along the engine lane's landing.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";

/**
 * The apply method we PROBE on the engine, added by the engine lane this wave. It
 * computes + persists the suggested tags and returns the full applied set plus the
 * tags newly added this call. Optional here and may be sync or async — we `await`
 * either way. Return type is loose so we don't pin the engine's exact result shape
 * from this lane; the route forwards whatever it returns.
 */
interface AutoTagEngine {
  applyAutoTags?: (sessionId: string) => unknown | Promise<unknown>;
}

/** The result both the engine method and our local fallback yield. */
interface ApplyResult {
  applied: string[];
  added: string[];
}

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

/**
 * Local stand-in for `applyAutoTags` when the engine hasn't added it yet, built from
 * the already-published `autoTagSession` (suggest) + `getTags` (current) + `setTags`
 * (persist) methods. Unions the suggestions into the existing tags, persists the
 * merged set, and reports which tags were newly added. Returns null when the published
 * methods can't run, so the caller can 503 rather than 500.
 */
function applyAutoTagsLocally(engine: Engine, sessionId: string): ApplyResult | null {
  try {
    const suggested = engine.autoTagSession(sessionId) ?? [];
    const existing = engine.getTags(sessionId) ?? [];
    // Union (order-preserving): existing first, then any suggested not already present.
    const have = new Set(existing);
    const merged = [...existing];
    const added: string[] = [];
    for (const tag of suggested) {
      if (!have.has(tag)) {
        have.add(tag);
        merged.push(tag);
        added.push(tag);
      }
    }
    // Persist via the canonical tag write path; setTags normalizes + returns the
    // stored set, which is the authoritative `applied` value.
    const applied = engine.setTags(sessionId, merged) ?? merged;
    return { applied, added };
  } catch {
    return null; // published methods unavailable — caller 503s, never 500.
  }
}

/** Wire GET /api/sessions/:id/autotag/suggest + POST /api/sessions/:id/autotag onto an app. */
export function registerAutotagRoutes(app: FastifyInstance, engine: Engine): void {
  // Preview only — never persists. `autoTagSession` is a published W21 method, so we
  // call it directly; a throw degrades to an empty suggestion (200), never a 500.
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/autotag/suggest",
    { schema: { params: idParams } },
    async (req) => {
      try {
        return { suggested: engine.autoTagSession(req.params.id) ?? [] };
      } catch {
        return { suggested: [] };
      }
    },
  );

  // Apply the suggestions (merge + persist). Prefer the engine's `applyAutoTags`
  // (engine lane, this wave); fall back to a local merge over the published
  // autoTagSession/getTags/setTags path when it's absent. See header note.
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/autotag",
    { schema: { params: idParams } },
    async (req, reply) => {
      const { id } = req.params;
      // Capability guard: forward to the engine method when present.
      const apply = (engine as unknown as AutoTagEngine).applyAutoTags;
      if (typeof apply === "function") {
        try {
          return await apply.call(engine, id);
        } catch {
          // Half-landed / throwing engine method — fall through to the local path
          // below rather than surfacing a 500.
        }
      }
      // Local fallback: reproduce the apply from the published methods.
      const local = applyAutoTagsLocally(engine, id);
      if (local) return local;
      // Even the published methods couldn't run — 503 (unavailable), never a 500.
      return reply.code(503).send({ error: "auto-tagging unavailable" });
    },
  );
}
