/**
 * Portable-archive transport: GET /api/export/archive, POST /api/import/archive
 *
 *   GET /api/export/archive[?projectId=…&sinceTs=…]
 *     → stream the engine's portable {@link ArchiveBundle} (a single versioned,
 *       self-describing JSON document — every indexed session's normalized metadata +
 *       mirrored search text plus the sidecar data we own: custom titles/pins/tags
 *       /archived/notes, saved views, the permission-audit log) back as a DOWNLOADABLE
 *       file (`Content-Type: application/json` + `Content-Disposition: attachment`).
 *       The filename carries the session count so a face can show "N sessions" before
 *       the download finishes. Optional `projectId` / `sinceTs` ask the engine for a
 *       SUBSET (selective export); they pass straight through to `engine.exportArchive`
 *       — an older engine that doesn't recognize them simply exports everything, which
 *       is an acceptable superset, never wrong data.
 *
 *   POST /api/import/archive   (body: a JSON ArchiveBundle)
 *     → validate the uploaded bundle's top-level shape, then restore it into THIS index
 *       via `engine.importArchive(bundle)`, returning a summary of what was written
 *       ({ importedSessions, … }). IDEMPOTENT: the engine de-dupes by identity, so
 *       re-importing the same bundle never duplicates rows. The import body can be large
 *       (a full export is 100+ sessions, some multi-MB), so this ONE route raises its
 *       `bodyLimit` well above Fastify's 1 MB default.
 *
 * READ-ONLY w.r.t. ~/.claude: export reads our index DB (never a raw transcript); import
 * writes ONLY our index DB (sidecar meta + mirrored text) and the engine guarantees it
 * never touches ~/.claude. Bad input is a 400 (never a 500): a non-object body, a body
 * missing the expected top-level keys, an oversized body (Fastify's 413 is normalized to
 * 400 here), or an incompatible `schemaVersion` (the engine throws `ArchiveVersionError`,
 * which we map to 400). A 500 is reserved for a genuine engine failure on valid input.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ENGINE METHODS: `Engine.exportArchive()` / `Engine.importArchive()` already exist
 * (W25), so we call them directly through the typed interface. We still wrap each in a
 * try/catch — a 500 (with a message) only on a genuine failure, and a 503 if the method
 * is somehow ABSENT on an older engine build (capability guard) so the route degrades
 * gracefully rather than throwing a TypeError.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/**
 * Per-route body limit for the import upload (bytes). A full export can be sizeable
 * (100+ sessions incl. multi-MB ones), so we lift it well above Fastify's 1 MB default
 * — but still cap it so a single request can't ask the server to buffer an unbounded
 * body. A bundle larger than this is rejected as bad input (normalized to 400 below),
 * never accepted into memory.
 */
const IMPORT_BODY_LIMIT = 256 * 1024 * 1024;

/**
 * The top-level keys we require an uploaded bundle to carry before we hand it to the
 * engine. This is a SHAPE gate (cheap, structural), not a deep validation — the engine
 * does the authoritative `schemaVersion` check and the idempotent restore. We only guard
 * the envelope so a stray JSON object (or a non-archive document) is a clean 400.
 */
function looksLikeBundle(body: unknown): body is { kind?: unknown; sessions?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  // `sessions` MUST be an array (the core payload). `kind`, when present, must be the
  // archive marker — a present-but-wrong marker is a different document, so reject it.
  if (!Array.isArray(b.sessions)) return false;
  if (b.kind !== undefined && b.kind !== "claude-ui-archive") return false;
  return true;
}

/**
 * The archive methods we call on the engine. They exist on the real `Engine` (W25), but
 * we probe at runtime so an older build missing them degrades to a 503 capability error
 * rather than throwing. Return/param types are loose so we don't re-pin the engine's
 * exact bundle/result shape from this lane; the route forwards whatever it computes.
 */
interface ArchiveEngine {
  exportArchive?: (opts?: Record<string, unknown>) => unknown;
  importArchive?: (bundle: unknown, opts?: Record<string, unknown>) => unknown;
}

/** Query params for selective export — both optional, both passed straight through. */
interface ExportQuery {
  projectId?: string;
  sinceTs?: number;
}

const exportSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    // A specific project's sessions only (subset export). Bounded length so a bad
    // value is rejected by the schema rather than reaching the engine.
    projectId: { type: "string", minLength: 1, maxLength: 256 },
    // Only sessions active at/after this epoch-ms timestamp (subset export).
    sinceTs: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * Wire GET /api/export/archive + POST /api/import/archive onto an app, backed by the
 * engine. Honors the app-level token auth (the onRequest hook in buildApp runs first).
 */
export function registerPortableRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Querystring: ExportQuery }>(
    "/api/export/archive",
    { schema: { querystring: exportSchema } },
    async (req, reply) => {
      const exportArchive = (engine as unknown as ArchiveEngine).exportArchive;
      // Capability guard: an older engine without the method — 503, not a TypeError.
      if (typeof exportArchive !== "function") {
        return reply.code(503).send({ error: "archive export not supported by this engine" });
      }

      // Pass the (optional) subset filters straight through. An engine that doesn't yet
      // understand them ignores the extra keys and exports everything — an acceptable
      // superset. Only forward keys the client actually sent.
      const opts: Record<string, unknown> = {};
      if (req.query.projectId !== undefined) opts.projectId = req.query.projectId;
      if (req.query.sinceTs !== undefined) opts.sinceTs = req.query.sinceTs;

      let bundle: unknown;
      try {
        bundle = exportArchive.call(engine, opts);
      } catch (err) {
        // A genuine engine failure on a valid request — 500 with the message.
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `archive export failed: ${message}` });
      }

      // Filename carries the session count so a face can label the download. The bundle
      // is our own document shape, so `sessions` is an array; guard anyway.
      const count = Array.isArray((bundle as { sessions?: unknown })?.sessions)
        ? (bundle as { sessions: unknown[] }).sessions.length
        : 0;
      const filename = `claude-ui-archive-${count}-sessions.json`;
      reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`);
      // Serialize once: the bundle is already in memory (the engine assembled it), so
      // there's nothing to stream incrementally here — return the JSON string.
      return JSON.stringify(bundle);
    },
  );

  app.post<{ Body: unknown }>(
    "/api/import/archive",
    {
      // Raise the body limit for THIS route only — an archive upload can be large. No
      // body schema: we validate the shape ourselves so a malformed bundle is our own
      // clean 400 rather than Fastify's generic schema rejection, and so a huge body is
      // parsed at all (a strict schema would also need its own larger limit).
      bodyLimit: IMPORT_BODY_LIMIT,
    },
    async (req, reply) => {
      const bundle = req.body;
      // Shape gate: a non-object / non-archive / sessions-less body is bad input (400),
      // never handed to the engine and never a 500.
      if (!looksLikeBundle(bundle)) {
        return reply
          .code(400)
          .send({ error: "invalid archive bundle (expected an object with a sessions array)" });
      }

      const importArchive = (engine as unknown as ArchiveEngine).importArchive;
      // Capability guard: an older engine without the method — 503, not a TypeError.
      if (typeof importArchive !== "function") {
        return reply.code(503).send({ error: "archive import not supported by this engine" });
      }

      let result: unknown;
      try {
        result = importArchive.call(engine, bundle);
      } catch (err) {
        // An incompatible `schemaVersion` (the engine throws `ArchiveVersionError`) is
        // BAD INPUT → 400, never a 500. We detect it structurally (by name + the
        // `found`/`expected` fields it carries) so we don't import the engine's error
        // class as a value from this lane. Any other throw on a valid-looking bundle is
        // a genuine failure → 500.
        const e = err as { name?: string; message?: string; found?: unknown; expected?: unknown };
        const incompatibleVersion =
          e?.name === "ArchiveVersionError" ||
          (typeof e?.found === "number" && typeof e?.expected === "number");
        const message = e?.message ?? String(err);
        if (incompatibleVersion) {
          return reply.code(400).send({ error: `incompatible archive: ${message}` });
        }
        return reply.code(500).send({ error: `archive import failed: ${message}` });
      }

      // Summarize what was written. The engine's result keys `sessions` as the count of
      // restored sessions; surface it as `importedSessions` (the route's stable name)
      // and pass the rest of the breakdown through verbatim.
      const r = (result ?? {}) as Record<string, unknown>;
      const importedSessions = typeof r.sessions === "number" ? r.sessions : 0;
      return {
        importedSessions,
        meta: typeof r.meta === "number" ? r.meta : 0,
        textRows: typeof r.textRows === "number" ? r.textRows : 0,
        savedViews: typeof r.savedViews === "number" ? r.savedViews : 0,
        audit: typeof r.audit === "number" ? r.audit : 0,
      };
    },
  );
}
