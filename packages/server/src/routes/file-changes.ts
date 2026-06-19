/**
 * Per-session file-change summary: GET /api/sessions/:id/files
 *
 *   GET /api/sessions/:id/files
 *     → the project files this session edited or wrote: one display-friendly row
 *       per file (with per-tool edit/write counts) plus a headline summary — the
 *       payload behind a "files changed in this session" affordance in the UI.
 *
 * This complements the raw transcript surface (`/api/sessions/:id/messages`):
 * those return every message; here we want a one-glance "what did this session
 * actually change on disk" rollup, addressed by session id.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ENGINE BACKING: the engine exposes `Engine.sessionFileChanges(id)` (a single
 * bounded transcript read of THIS session folded by the pure `aggregateFileChanges`,
 * never a corpus scan). We prefer it when present and forward its result verbatim.
 * Because it lands alongside this route, we still probe it at runtime (typeof guard
 * + try/catch): when ABSENT — or a half-landed wrapper throws — we COMPOSE the SAME
 * `{ files, summary }` shape locally by reading the session once via the published
 * `getSessionMessages` and folding it with the SAME exported `aggregateFileChanges`
 * helper (so the two paths can't diverge). An unknown session degrades to an empty
 * result flagged `unavailable` (200, never a 404/500), so the route is safe to ship
 * at any point along the engine lane's landing.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import { aggregateFileChanges, type Engine, type SessionFileChanges } from "@devhub/engine";

/**
 * The per-session file-change method we expect the engine to expose. We keep the
 * return type deliberately loose (`unknown`, sync or async) so we don't pin the
 * engine's exact shape from here — the route just forwards whatever it returns.
 * The locally-composed fallback (which reuses the engine's own pure helper) is the
 * uniform shape until then.
 */
interface FileChangesEngine {
  sessionFileChanges(sessionId: string): unknown | Promise<unknown>;
}

/**
 * Tail size (bytes) the fallback reads off the transcript before folding it. The
 * engine's own method reads the whole session; the fallback caps what it even reads
 * so a giant transcript can't blow the per-request budget. The file-change rollup
 * only needs the (assistant) tool_use blocks, which sit throughout the transcript,
 * so this is a generous-but-bounded ceiling for the degraded path.
 */
const TAIL_BYTES = 512 * 1024;

/** The empty result an unknown/unloadable session degrades to (200, flagged). */
const EMPTY: SessionFileChanges & { unavailable: true } = {
  files: [],
  summary: { fileCount: 0, editCount: 0, writeCount: 0 },
  unavailable: true,
};

/**
 * Compose the summary locally when the engine method is absent or half-landed:
 * one bounded transcript read for THIS session via the published `getSessionMessages`,
 * then fold it with the engine's OWN exported `aggregateFileChanges` so the shape is
 * byte-for-byte the same as the primary path. An unknown session (the engine returns
 * undefined) yields the empty result flagged `unavailable`, never a 404/500.
 */
async function composeFileChanges(
  engine: Engine,
  sessionId: string,
): Promise<SessionFileChanges | (SessionFileChanges & { unavailable: true })> {
  const page = await engine.getSessionMessages(sessionId, { tailBytes: TAIL_BYTES });
  if (!page) return EMPTY;
  return aggregateFileChanges(page.messages, page.session.cwd);
}

/**
 * Wire GET /api/sessions/:id/files onto an app, backed by the engine. We prefer the
 * engine's own `sessionFileChanges` and forward it verbatim; if it's absent at
 * runtime — or a half-landed wrapper throws — we compose the SAME shape from the
 * published `getSessionMessages` + `aggregateFileChanges`, so the route is well-formed
 * and never 500s, at any point along the engine lane's landing.
 */
export function registerFileChangesRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/files",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      // Prefer the engine's own file-change rollup when present; forward it verbatim.
      const fn = (engine as unknown as Partial<FileChangesEngine>).sessionFileChanges;
      if (typeof fn === "function") {
        try {
          const result = await fn.call(engine, id);
          if (result) return result;
        } catch {
          // Half-landed engine (wrapper present, backing not ready): fall through
          // to the locally-composed summary rather than surface a 500.
        }
      }
      return composeFileChanges(engine, id);
    },
  );
}
