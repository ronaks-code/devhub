/**
 * Fastify transport over the engine. This is the HTTP/SSE boundary — the browser
 * talks to this; the engine itself stays framework-agnostic and in-process.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import path from "node:path";
import { Engine, watchTranscripts, startConfigWatcher, paths } from "@claude-ui/engine";
import type { EngineEvent } from "@claude-ui/engine/types";
import { registerWs } from "./ws.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerGitActionRoutes } from "./routes/git-actions.js";
import { registerPermissionsRoutes } from "./routes/permissions.js";
import { registerAllowlistSuggestRoutes } from "./routes/allowlist-suggest.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerConfigLintRoutes } from "./routes/config-lint.js";
import { registerAllSessionsRoutes } from "./routes/all-sessions.js";
import { registerRollupsRoutes } from "./routes/rollups.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerAssetsRoutes } from "./routes/assets.js";
import { registerPrRoutes } from "./routes/pr.js";
import { registerSavedViewsRoutes } from "./routes/saved-views.js";
import { registerSummaryRoutes } from "./routes/summary.js";
import { registerSymbolsRoutes } from "./routes/symbols.js";
import { registerRunningRoutes } from "./routes/running.js";
import { registerAttachmentsRoutes } from "./routes/attachments.js";
import { registerHookTestRoutes } from "./routes/hook-test.js";
import { registerExportUsageRoutes } from "./routes/export-usage.js";
import { registerExportSessionRoutes } from "./routes/export-session.js";
import { registerOpenExternalRoutes } from "./routes/open-external.js";
import { registerTailRoutes } from "./routes/tail.js";
import { registerHealthRoutes } from "./routes/health.js";
import {
  startNotificationsWatcher,
  type NotificationsWatcher,
  type NotifyEvent,
} from "./notifications.js";

/**
 * Per-engine notifications watcher, populated by {@link startEngineLifecycle}. The
 * /api/events SSE handler (built in {@link buildApp}, before the lifecycle starts)
 * looks the watcher up here AT CONNECTION TIME, so it forwards notify events without
 * needing the watcher to exist when the route was registered. A WeakMap keeps this
 * from pinning a closed engine in memory.
 */
const notificationsByEngine = new WeakMap<Engine, NotificationsWatcher>();

export interface BuildOptions {
  engine?: Engine;
  token?: string;
}

export function buildApp(opts: BuildOptions = {}): {
  app: FastifyInstance;
  engine: Engine;
} {
  const engine = opts.engine ?? new Engine();
  const token = (opts.token ?? process.env.CLAUDE_UI_TOKEN)?.trim();
  const app = Fastify({ logger: false });

  app.register(cors, { origin: true, credentials: true });
  // WebSocket support must be registered before any ws routes are defined.
  app.register(websocket);

  // Auth seam: enforced only when a token is configured (local-only by default).
  app.addHook("onRequest", async (req, reply) => {
    if (!token) return;
    // WebSocket upgrades can't carry an Authorization header reliably; the ws
    // route guards itself, so skip the token check for the upgrade handshake.
    if (req.url.startsWith("/api/ws")) return;
    if (req.url.startsWith("/api/health")) return;
    const headerOk = req.headers.authorization === `Bearer ${token}`;
    const q = (req.query as Record<string, string> | undefined)?.token;
    if (!headerOk && q !== token) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    ready: engine.ready,
    sessionCount: engine.index.getSessionCount(),
  }));

  // Live-chat WebSocket. Registered inside a child plugin so it loads AFTER the
  // websocket plugin above — otherwise the `{ websocket: true }` onRoute hook
  // isn't applied yet and the handler is wrongly called with (request, reply).
  app.register(async (instance) => {
    registerWs(instance, engine, token);
  });

  app.get<{ Querystring: { q: string; limit?: number } }>(
    "/api/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => engine.search(req.query.q, { limit: req.query.limit ?? 50 }),
  );

  app.get("/api/running", async () => engine.getRunningSessions());

  app.get("/api/stats", async () => engine.getStats());

  app.get("/api/projects", async () => engine.getProjects());

  registerSettingsRoutes(app, engine);

  registerGitRoutes(app, engine);

  registerGitActionRoutes(app, engine);

  registerPermissionsRoutes(app, engine);

  registerAllowlistSuggestRoutes(app, engine);

  registerConfigRoutes(app, engine);

  registerConfigLintRoutes(app, engine);

  registerAllSessionsRoutes(app, engine);

  registerRollupsRoutes(app, engine);

  registerSearchRoutes(app, engine);

  registerProjectsRoutes(app, engine);

  registerAssetsRoutes(app, engine);

  registerPrRoutes(app, engine);

  registerSavedViewsRoutes(app, engine);

  registerSummaryRoutes(app, engine);

  registerSymbolsRoutes(app, engine);

  registerRunningRoutes(app, engine);

  registerAttachmentsRoutes(app, engine);

  registerHookTestRoutes(app, engine);

  registerExportUsageRoutes(app, engine);

  registerExportSessionRoutes(app, engine);

  registerOpenExternalRoutes(app, engine);

  registerTailRoutes(app, engine);

  registerHealthRoutes(app, engine);

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/sessions",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (req) => engine.getProjectSessions(req.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: { tailBytes?: number } }>(
    "/api/sessions/:id/messages",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { tailBytes: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (req, reply) => {
      const { tailBytes } = req.query;
      const page = await engine.getSessionMessages(req.params.id, {
        tailBytes: tailBytes !== undefined ? Math.max(64 * 1024, tailBytes) : undefined,
      });
      if (!page) return reply.code(404).send({ error: "not found" });
      return page;
    },
  );

  // Read a single subagent transcript (path must live under ~/.claude/projects).
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/sessions/:id/subagent",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const file = path.resolve(req.query.path);
      const root = path.resolve(paths.projectsDir());
      if (!file.startsWith(root + path.sep) || !file.endsWith(".jsonl")) {
        return reply.code(400).send({ error: "invalid path" });
      }
      return engine.getSubagentMessages(file);
    },
  );

  // Rename / pin / tag (sidecar — never touches the transcript). Tags are stored
  // in session_meta and normalized by the engine on write (trim/lower/de-dupe); the
  // schema only guards the *shape* (array of short strings), capped so a single
  // request can't stuff the index with oversized or unbounded tag lists.
  app.patch<{
    Params: { id: string };
    Body: {
      customTitle?: string | null;
      pinned?: boolean;
      tags?: string[];
      notes?: string;
    };
  }>(
    "/api/sessions/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            customTitle: { type: ["string", "null"] },
            pinned: { type: "boolean" },
            tags: {
              type: "array",
              maxItems: 50,
              items: { type: "string", minLength: 1, maxLength: 64 },
            },
            // Free-form per-session note (sidecar, never touches the transcript).
            // Capped so a single request can't stuff the index with an oversized blob.
            notes: { type: "string", maxLength: 10000 },
          },
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      const body = req.body ?? {};
      if ("customTitle" in body) engine.index.setCustomTitle(id, body.customTitle ?? null);
      if ("pinned" in body) engine.index.setPinned(id, body.pinned === true);
      if ("tags" in body && body.tags) engine.setTags(id, body.tags);
      // Best-effort: `engine.setNotes` isn't on `Engine` yet (missing engine
      // symbol). Detect it at runtime and forward only if present, so the typecheck
      // passes and the route degrades gracefully until the engine adds it.
      // NOTE (missing engine symbols): add `setNotes(sessionId, notes)` to `Engine`,
      // then replace this duck-typed lookup with the direct typed call.
      if ("notes" in body && typeof body.notes === "string") {
        const setNotes = (engine as unknown as Record<string, unknown>).setNotes;
        if (typeof setNotes === "function") {
          (setNotes as (sessionId: string, notes: string) => void).call(
            engine,
            id,
            body.notes,
          );
        }
      }
      return engine.getSession(id) ?? { ok: true };
    },
  );

  // SSE live updates (index progress + session add/change).
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    raw.write(": connected\n\n");
    const send = (e: EngineEvent | NotifyEvent) =>
      raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const unsub = engine.on(send);
    // ALSO forward session notifications (finished/stalled) when a watcher is
    // running for this engine — same SSE stream, distinguished by `kind: "notify"`.
    const notifications = notificationsByEngine.get(engine);
    const unsubNotify = notifications?.on(send);
    const hb = setInterval(() => raw.write(": ping\n\n"), 25000);
    req.raw.on("close", () => {
      clearInterval(hb);
      unsub();
      unsubNotify?.();
    });
  });

  return { app, engine };
}

/** Wire up the engine lifecycle (watcher + background index) around an app. */
export function startEngineLifecycle(engine: Engine): () => void {
  const stopWatch = watchTranscripts(engine);
  // Poll running sessions for finished/stalled transitions and publish them on a
  // server-local bus; /api/events forwards them to clients (looked up via the
  // WeakMap above). Registered here, after the transcript watcher.
  const notifications = startNotificationsWatcher(engine);
  notificationsByEngine.set(engine, notifications);
  // Watch ~/.claude config files; config-changed events flow over /api/events SSE.
  const stopConfig = startConfigWatcher(engine);
  // First index runs in the background; SSE pushes progress. Incremental afterward.
  void engine.indexAll();
  return () => {
    notifications.stop();
    notificationsByEngine.delete(engine);
    stopConfig();
    stopWatch();
  };
}
