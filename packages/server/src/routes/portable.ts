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
function looksLikeBundle(body: unknown): body is { kind?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  // A DevHub v2 bundle carries `devhub-archive` + a providerTaskMeta array; a legacy v1
  // bundle carries `claude-ui-archive` + a sessions array. Accept either envelope; reject
  // an unknown marker or a document with neither payload array.
  if (b.kind === "devhub-archive") return Array.isArray(b.providerTaskMeta) && Array.isArray(b.legacyMeta);
  if (b.kind === "claude-ui-archive") return Array.isArray(b.sessions);
  // No/absent marker: fall back to the legacy shape gate (a bare sessions array).
  if (b.kind === undefined) return Array.isArray(b.sessions);
  return false;
}

/**
 * The archive methods we call on the engine. They exist on the real `Engine` (W25), but
 * we probe at runtime so an older build missing them degrades to a 503 capability error
 * rather than throwing. Return/param types are loose so we don't re-pin the engine's
 * exact bundle/result shape from this lane; the route forwards whatever it computes.
 */
interface ArchiveEngine {
  exportArchive?: (opts?: Record<string, unknown>) => unknown;
  exportLegacyV1Archive?: (opts?: Record<string, unknown>) => unknown;
  importArchive?: (bundle: unknown, opts?: Record<string, unknown>) => unknown;
}

/** The transport authority label for a legacy-v1 rollback export. */
const LEGACY_ARCHIVE_AUTHORITY = "legacy-rebuildable-cache";

/** Query params for selective export — all optional, all passed straight through. */
interface ExportQuery {
  projectId?: string;
  sinceTs?: number;
  format?: "legacy-v1";
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
    // Rollback ONLY: emit the legacy v1 bundle (unresolved legacy corpus). Never default.
    format: { type: "string", enum: ["legacy-v1"] },
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
      const asArchive = engine as unknown as ArchiveEngine;
      const legacy = req.query.format === "legacy-v1";
      // DEFAULT exports the DevHub v2 bundle; `format=legacy-v1` exports the legacy
      // rollback bundle (unresolved legacy corpus only) via a distinct engine method.
      const exportFn = legacy ? asArchive.exportLegacyV1Archive : asArchive.exportArchive;
      // Capability guard: an older engine without the method — 503, not a TypeError.
      if (typeof exportFn !== "function") {
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
        bundle = exportFn.call(engine, opts);
      } catch (err) {
        // A legacy export that names a resolved session is BAD INPUT → 400 (the engine
        // throws ArchiveValidationError). Any other throw on a valid request is a 500.
        const e = err as { name?: string; code?: unknown; message?: string };
        const message = e?.message ?? String(err);
        if (e?.name === "ArchiveValidationError") {
          return reply.code(400).send({ error: `invalid archive export: ${message}` });
        }
        return reply.code(500).send({ error: `archive export failed: ${message}` });
      }

      const b = bundle as Record<string, unknown> | undefined;
      const filename = legacy
        ? `devhub-archive-legacy-v1-${Array.isArray(b?.sessions) ? (b!.sessions as unknown[]).length : 0}-sessions.json`
        : `devhub-archive-v2.json`;
      reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`);
      // Label a legacy rollback export as a rebuildable cache, never authority.
      if (legacy) reply.header("X-DevHub-Archive-Authority", LEGACY_ARCHIVE_AUTHORITY);
      // Serialize once: the bundle is already in memory (the engine assembled it).
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
        // A schema/mapping/bounds violation (ArchiveValidationError) is BAD INPUT → 400.
        const invalidInput = e?.name === "ArchiveValidationError";
        const message = e?.message ?? String(err);
        if (incompatibleVersion) {
          return reply.code(400).send({ error: `incompatible archive: ${message}` });
        }
        if (invalidInput) {
          return reply.code(400).send({ error: `invalid archive: ${message}` });
        }
        return reply.code(500).send({ error: `archive import failed: ${message}` });
      }

      // Summarize exactly what was written. `sessions` (v1 only) surfaces as the route's
      // stable `importedSessions`; the rest of the exact-count breakdown passes through.
      const r = (result ?? {}) as Record<string, unknown>;
      const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
      return {
        importedSessions: n("sessions"),
        meta: n("meta"),
        textRows: n("textRows"),
        savedViews: n("savedViews"),
        audit: n("audit"),
        providerMeta: n("providerMeta"),
        forkLinks: n("forkLinks"),
        mappedLocators: n("mappedLocators"),
        orphanedLocators: n("orphanedLocators"),
        legacyProvenance: n("legacyProvenance"),
      };
    },
  );
}
