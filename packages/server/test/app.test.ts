/**
 * Integration tests for the server REST surface.
 *
 * These are HERMETIC: we never touch the real ~/.claude. We point
 * CLAUDE_CONFIG_DIR at a fresh temp dir (the same seam packages/engine tests use),
 * seed a tiny synthetic project/session under <tmp>/projects/, build an Engine
 * against a temp SQLite DB, index it, and pass that engine into buildApp({ engine }).
 * Every request is exercised with Fastify's app.inject() — no real network port.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Engine, paths } from "@devhub/engine";
import { buildApp } from "../src/app.js";

const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** Two synthetic project cwds we seed transcripts for. */
const ALPHA_CWD = "/home/me/alpha";
const BETA_CWD = "/home/me/beta";
const ALPHA_ID = paths.projectIdFromCwd(ALPHA_CWD);
const BETA_ID = paths.projectIdFromCwd(BETA_CWD);

/** Track the prior CLAUDE_CONFIG_DIR so each test restores it (hermetic). */
let prevConfigDir: string | undefined;

/**
 * Build a fresh temp config dir, seed a couple of synthetic sessions under
 * <root>/projects/<folder>/, construct + index an Engine against a temp DB, and
 * return the wired Fastify app. The caller passes any buildApp opts (e.g. token).
 */
async function makeApp(
  opts: { token?: string } = {},
): Promise<{ app: FastifyInstance; engine: Engine; root: string }> {
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), "cui-server-test-"));
  process.env.CLAUDE_CONFIG_DIR = root;

  // Claude Code stores transcripts under <config>/projects/<encoded-folder>/*.jsonl.
  // The folder name is opaque to the indexer (it reads `cwd` off each line), so a
  // single folder holding sessions from two distinct cwds is fine.
  const projectsDir = path.join(root, "projects", "-proj");
  mkdirSync(projectsDir, { recursive: true });

  const mk = (id: string, cwd: string, ts: string, model: string, tokens: number) => {
    writeFileSync(
      path.join(projectsDir, `${id}.jsonl`),
      jl({ type: "user", cwd, timestamp: ts, message: { role: "user", content: "deploy the widget" } }) +
        jl({
          type: "assistant",
          cwd,
          timestamp: ts,
          message: {
            role: "assistant",
            model,
            content: [
              { type: "text", text: "running it" },
              { type: "tool_use", id: "tu1", name: "Bash", input: { command: "git status" } },
            ],
            usage: { input_tokens: tokens, output_tokens: 0 },
          },
        }),
    );
  };

  // alpha: two sessions (opus); beta: one (sonnet) — distinct models so byModel splits.
  mk("alpha-1", ALPHA_CWD, "2026-06-01T08:00:00.000Z", "claude-opus-4-8", 1_000_000);
  mk("alpha-2", ALPHA_CWD, "2026-06-01T20:00:00.000Z", "claude-opus-4-8", 1_000_000);
  mk("beta-1", BETA_CWD, "2026-06-02T09:00:00.000Z", "claude-sonnet-4-6", 1_000_000);

  const engine = new Engine(path.join(root, "index.db"));
  await engine.indexAll();
  const { app } = buildApp({ ...opts, engine });
  await app.ready();
  return { app, engine, root };
}

let current: { app: FastifyInstance; engine: Engine; root: string } | undefined;

afterEach(async () => {
  if (current) {
    await current.app.close();
    current.engine.close();
    current = undefined;
  }
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
});

describe("server REST endpoints (no token)", () => {
  beforeEach(async () => {
    current = await makeApp();
  });

  it("GET /api/health reports ready + session count", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(true);
    expect(body.sessionCount).toBe(3);
  });

  it("GET /api/health carries a strict identity — a 2xx alone doesn't prove which server answered", async () => {
    // Guards the desktop shell's spawn-or-reuse contract (lib.rs `health_ok`): it
    // must be able to tell THIS response apart from any other process that happens
    // to be listening on the probed port and answers with its own unrelated 2xx body.
    const res = await current!.app.inject({ method: "GET", url: "/api/health" });
    const body = res.json();
    expect(body.service).toBe("devhub-server");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });

  it("GET /api/projects lists the seeded projects, newest-activity first", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    const projects = res.json() as Array<{ id: string; cwd: string; sessionCount: number }>;
    expect(projects.map((p) => p.cwd)).toEqual([BETA_CWD, ALPHA_CWD]);
    const alpha = projects.find((p) => p.id === ALPHA_ID)!;
    expect(alpha.sessionCount).toBe(2);
    expect(projects.find((p) => p.id === BETA_ID)!.sessionCount).toBe(1);
  });

  it("GET /api/projects/:id/sessions returns that project's sessions", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: `/api/projects/${ALPHA_ID}/sessions`,
    });
    expect(res.statusCode).toBe(200);
    const sessions = res.json() as Array<{ sessionId: string }>;
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["alpha-1", "alpha-2"]);
  });

  it("GET /api/projects/:id/sessions is an empty list for an unknown project", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/projects/deadbeef0000/sessions",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("GET /api/sessions/:id/messages returns the transcript (200)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/messages",
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as { session: { sessionId: string }; messages: unknown[] };
    expect(page.session.sessionId).toBe("alpha-1");
    expect(page.messages.length).toBeGreaterThan(0);
  });

  it("GET /api/sessions/:id/messages 404s for an unknown session", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/nope/messages",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });

  it("GET /api/search requires q (400 when missing)", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/search" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/search returns hits when q is supplied", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/search?q=widget",
    });
    expect(res.statusCode).toBe(200);
    const hits = res.json() as Array<{ sessionId: string; snippet: string }>;
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    // The seeded prompt text "deploy the widget" should be findable.
    expect(hits.some((h) => h.sessionId.startsWith("alpha") || h.sessionId.startsWith("beta"))).toBe(
      true,
    );
  });

  it("GET /api/running returns an array", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/running" });
    expect(res.statusCode).toBe(200);
    // Hermetic: <config>/sessions doesn't exist, so there are no live sessions.
    expect(res.json()).toEqual([]);
  });

  it("GET /api/stats rolls up the seeded corpus", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as {
      totalSessions: number;
      totalProjects: number;
      byModel: Array<{ model: string; sessions: number }>;
      activity: unknown[];
    };
    expect(stats.totalSessions).toBe(3);
    expect(stats.totalProjects).toBe(2);
    const models = stats.byModel.map((m) => m.model).sort();
    expect(models).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(Array.isArray(stats.activity)).toBe(true);
  });

  it("GET /api/all-sessions returns the whole corpus, newest first", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/all-sessions" });
    expect(res.statusCode).toBe(200);
    const sessions = res.json() as Array<{ sessionId: string }>;
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["alpha-1", "alpha-2", "beta-1"]);
  });

  it("GET /api/all-sessions accepts the `cost` sort", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/all-sessions?sort=cost",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(3);
  });

  it("GET /api/all-sessions rejects a bad sort enum (400)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/all-sessions?sort=bogus",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/permissions/suggest returns ranked suggestions from observed Bash usage", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/permissions/suggest",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      scope: string;
      observedSessions: number;
      suggestions: Array<{ rule: string; prefix: string; count: number }>;
    };
    expect(body.scope).toBe("global");
    expect(Array.isArray(body.suggestions)).toBe(true);
    // The seeded Bash command "git status" should surface a `Bash(git status:*)` rule.
    expect(body.suggestions.some((s) => s.rule === "Bash(git status:*)")).toBe(true);
  });

  it("GET /api/permissions/suggest 400s for an unknown project", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/permissions/suggest?projectId=deadbeef0000",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/config/plugins returns an empty listing on a fresh config dir", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/config/plugins" });
    expect(res.statusCode).toBe(200);
    // Empty-but-correct shape (no plugins seeded): both keys present, both empty.
    expect(res.json()).toEqual({ plugins: [], marketplaces: [] });
  });

  it("GET /api/config/plugins delegates to the engine, mapping the enabled flag", async () => {
    // Seed an installed_plugins.json under the hermetic config dir (CLAUDE_CONFIG_DIR
    // points at `root`), the file the engine's listPlugins reads. The route should
    // surface the engine's flattened PluginInfo per install record — crucially the
    // resolved `enabled` flag — without the server re-reading the file itself.
    mkdirSync(path.join(current!.root, "plugins"), { recursive: true });
    writeFileSync(
      path.join(current!.root, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "frontend-design@claude-plugins-official": [
            { scope: "user", version: "1.2.0", installPath: "/x" },
          ],
        },
      }),
    );

    const res = await current!.app.inject({ method: "GET", url: "/api/config/plugins" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plugins: Array<{ name: string; version: string | null; marketplace: string | null; enabled: boolean; scope: string | null }>;
      marketplaces: unknown[];
    };
    expect(body.plugins).toEqual([
      {
        name: "frontend-design",
        version: "1.2.0",
        marketplace: "claude-plugins-official",
        enabled: true,
        scope: "user",
      },
    ]);
    // The engine has no marketplace view, so this half is always empty (see route).
    expect(body.marketplaces).toEqual([]);
  });

  it("GET /api/sessions/:id/export?format=json downloads the normalized session", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/export?format=json",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    // Downloadable: filename derived from the session id.
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("alpha-1");
    const body = res.json() as {
      session: { sessionId: string };
      messages: unknown[];
      truncatedFromStart: boolean;
    };
    expect(body.session.sessionId).toBe("alpha-1");
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.truncatedFromStart).toBe(false);
  });

  it("GET /api/sessions/:id/export?format=md renders a Markdown transcript", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/export?format=md",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain("attachment");
    // The seeded text + tool call should both surface in the rendered transcript.
    expect(res.body).toContain("deploy the widget");
    expect(res.body).toContain("Tool call: `Bash`");
  });

  it("GET /api/sessions/:id/export defaults to md when no format is given", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/export",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
  });

  it("GET /api/sessions/:id/export 404s for an unknown session", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/nope/export?format=json",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/:id/export 400s for a bad format", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/export?format=pdf",
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("pdf");
  });

  it("GET /api/sessions/:id/export.html downloads a self-contained HTML transcript", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/export.html",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // Downloadable: filename derived from the session id.
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("alpha-1");
    // Self-contained: a real document with inline CSS and no external assets.
    expect(res.body).toContain("<!doctype html>");
    expect(res.body).toContain("<style>");
    expect(res.body).not.toContain("<link");
    expect(res.body).not.toContain("<script");
    // The seeded text + tool call should both surface in the rendered transcript.
    expect(res.body).toContain("deploy the widget");
    expect(res.body).toContain("Tool call: <code>Bash</code>");
  });

  it("GET /api/sessions/:id/export.html 404s for an unknown session", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/nope/export.html",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/:id/related returns a JSON array", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/related",
    });
    expect(res.statusCode).toBe(200);
    // Until the engine's relatedSessions method lands, this degrades to []; once it
    // lands it returns ranked items. Either way it MUST be an array, never a 500.
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("GET /api/sessions/:id/related rejects a bad limit (400)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/related?limit=0",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/sessions/:id/related forwards to the engine method when present", async () => {
    // Duck-typed capability: stub the (not-yet-landed) engine method and confirm the
    // route calls it through with the validated limit and returns its ranked list.
    const calls: Array<{ id: string; limit?: number }> = [];
    (current!.engine as unknown as Record<string, unknown>).relatedSessions = (
      id: string,
      opts?: { limit?: number },
    ) => {
      calls.push({ id, limit: opts?.limit });
      return [{ sessionId: "alpha-2", score: 0.9 }];
    };
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/related?limit=5",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ sessionId: "alpha-2", score: 0.9 }]);
    expect(calls).toEqual([{ id: "alpha-1", limit: 5 }]);
  });

  it("GET /api/sessions/:id/related degrades to [] when the engine method throws", async () => {
    // Half-landed engine: the wrapper exists but its backing isn't ready yet (it
    // throws). The route must swallow it and return [] (200), never a 500.
    (current!.engine as unknown as Record<string, unknown>).relatedSessions = () => {
      throw new Error("index.relatedSessions is not a function");
    };
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/related",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("GET /api/sessions/:id/autotag/suggest returns a { suggested } array", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/autotag/suggest",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { suggested: string[] };
    // autoTagSession is a published W21 method; the seeded cwd has no marker files
    // and rides a default branch, so for this hermetic fixture it suggests nothing —
    // the contract under test is the SHAPE: always a { suggested } string array.
    expect(Array.isArray(body.suggested)).toBe(true);
  });

  it("GET /api/sessions/:id/autotag/suggest forwards what the engine suggests", async () => {
    // Stub the published suggest method so we can assert the route returns its output
    // verbatim under the { suggested } envelope (preview — never persists).
    const calls: string[] = [];
    (current!.engine as unknown as Record<string, unknown>).autoTagSession = (id: string) => {
      calls.push(id);
      return ["node", "typescript"];
    };
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/autotag/suggest",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suggested: ["node", "typescript"] });
    expect(calls).toEqual(["alpha-1"]);
  });

  it("GET /api/sessions/:id/autotag/suggest degrades to [] when the engine throws", async () => {
    // A half-landed / throwing suggest method must degrade to { suggested: [] } (200),
    // never a 500.
    (current!.engine as unknown as Record<string, unknown>).autoTagSession = () => {
      throw new Error("boom");
    };
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/autotag/suggest",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suggested: [] });
  });

  it("POST /api/sessions/:id/autotag forwards to engine.applyAutoTags when present", async () => {
    // Duck-typed capability: stub the (engine-lane, this-wave) applyAutoTags and confirm
    // the route calls it through with the session id and returns its { applied, added }.
    const calls: string[] = [];
    (current!.engine as unknown as Record<string, unknown>).applyAutoTags = (id: string) => {
      calls.push(id);
      return { applied: ["node", "typescript"], added: ["typescript"] };
    };
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/sessions/alpha-1/autotag",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: ["node", "typescript"], added: ["typescript"] });
    expect(calls).toEqual(["alpha-1"]);
  });

  it("POST /api/sessions/:id/autotag falls back to merge+persist when applyAutoTags is absent", async () => {
    // Degraded path: the engine method hasn't landed, so the route reproduces the apply
    // from the published autoTagSession + getTags + setTags methods — union the
    // suggestions into the existing tags, persist, and report what was newly `added`.
    (current!.engine as unknown as Record<string, unknown>).applyAutoTags = undefined;
    current!.engine.setTags("alpha-1", ["keep"]); // pre-existing user tag
    (current!.engine as unknown as Record<string, unknown>).autoTagSession = () => ["keep", "node"];

    const res = await current!.app.inject({
      method: "POST",
      url: "/api/sessions/alpha-1/autotag",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: string[]; added: string[] };
    // "keep" already present (not re-added); "node" is the only newly added tag, and the
    // persisted set is the union — proven by re-reading the engine's stored tags.
    expect(body.added).toEqual(["node"]);
    expect(body.applied.sort()).toEqual(["keep", "node"]);
    expect(current!.engine.getTags("alpha-1").sort()).toEqual(["keep", "node"]);
  });

  it("POST /api/sessions/:id/autotag 503s when neither the engine method nor the published path can run", async () => {
    // Capability guard: applyAutoTags absent AND the local fallback can't run (the
    // published methods throw) — the route returns 503 (unavailable), never a 500.
    (current!.engine as unknown as Record<string, unknown>).applyAutoTags = undefined;
    (current!.engine as unknown as Record<string, unknown>).autoTagSession = () => {
      throw new Error("index unavailable");
    };
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/sessions/alpha-1/autotag",
    });
    expect(res.statusCode).toBe(503);
  });

  it("GET /api/stats/tools returns an empty result when the engine method is absent", async () => {
    // engine.toolStats has now landed (it's a prototype method on the real Engine), so
    // to exercise the route's typeof-guard "absent" path we shadow it to undefined on
    // this test's (fresh) engine instance. The route must degrade to a 200 empty result.
    (current!.engine as unknown as Record<string, unknown>).toolStats = undefined;
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/stats/tools",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tools: [] });
  });

  it("GET /api/stats/tools rejects a bad limit (400)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/stats/tools?limit=0",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/stats/tools forwards params to the engine method when present", async () => {
    // Duck-typed capability: stub the (not-yet-landed) engine method and confirm the
    // route calls it through with the validated params and returns its summary.
    const calls: Array<{ projectId?: string; sessionId?: string; limit?: number }> = [];
    (current!.engine as unknown as Record<string, unknown>).toolStats = (opts?: {
      projectId?: string;
      sessionId?: string;
      limit?: number;
    }) => {
      calls.push({ projectId: opts?.projectId, sessionId: opts?.sessionId, limit: opts?.limit });
      return { tools: [{ name: "Bash", count: 3 }] };
    };
    const res = await current!.app.inject({
      method: "GET",
      url: `/api/stats/tools?projectId=${ALPHA_ID}&sessionId=alpha-1&limit=5`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tools: [{ name: "Bash", count: 3 }] });
    expect(calls).toEqual([{ projectId: ALPHA_ID, sessionId: "alpha-1", limit: 5 }]);
  });

  it("GET /api/stats/tools degrades to an empty result when the engine method throws", async () => {
    // Half-landed engine: the wrapper exists but its backing isn't ready yet (it
    // throws). The route must swallow it and return { tools: [] } (200), never a 500.
    (current!.engine as unknown as Record<string, unknown>).toolStats = () => {
      throw new Error("index.toolStats is not a function");
    };
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/stats/tools",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tools: [] });
  });

  it("GET /api/sessions/:id/files returns an empty files array for a session with no edits (200)", async () => {
    // The seeded sessions only run Bash (no Edit/Write/NotebookEdit), so the engine's
    // rollup finds nothing to report — an empty list + zeroed summary, never a 500.
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/files",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: unknown[]; summary: { fileCount: number } };
    expect(body.files).toEqual([]);
    expect(body.summary.fileCount).toBe(0);
  });

  it("GET /api/sessions/:id/files returns an empty result for an unknown session (200, never 500)", async () => {
    // Unknown id: the engine's rollup (and the composed fallback) yield an empty list
    // rather than a 404/500. The contract under test is "empty + 200, never 500".
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/nope/files",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { files: unknown[] }).files).toEqual([]);
  });

  it("GET /api/sessions/:id/files accepts a non-empty id and never 500s", async () => {
    // The schema requires a non-empty :id. A single space is a valid non-empty string
    // per the schema; it resolves to an unknown session → 200 empty. The contract under
    // test is that a well-formed (but unmatched) id never surfaces a 500.
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/%20/files",
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/sessions/:id/files forwards to engine.sessionFileChanges when present", async () => {
    // Duck-typed capability: stub the engine method and confirm the route forwards its
    // result verbatim, called through with the validated session id.
    const calls: string[] = [];
    (current!.engine as unknown as Record<string, unknown>).sessionFileChanges = (id: string) => {
      calls.push(id);
      return {
        files: [{ filePath: "x.ts", absPath: "/home/me/alpha/x.ts", edits: 2, writes: 0, tools: ["Edit"] }],
        summary: { fileCount: 1, editCount: 2, writeCount: 0 },
      };
    };
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/files",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      files: [{ filePath: "x.ts", absPath: "/home/me/alpha/x.ts", edits: 2, writes: 0, tools: ["Edit"] }],
      summary: { fileCount: 1, editCount: 2, writeCount: 0 },
    });
    expect(calls).toEqual(["alpha-1"]);
  });

  it("GET /api/sessions/:id/files composes the SAME shape when engine.sessionFileChanges is absent", async () => {
    // Degraded path: the engine method hasn't landed (typeof guard). The route must
    // compose the rollup itself from getSessionMessages + aggregateFileChanges, NOT
    // surface a 500. alpha-1 has no edits, so the composed result is an empty list with
    // a zeroed summary — the SAME shape the engine method returns.
    (current!.engine as unknown as Record<string, unknown>).sessionFileChanges = undefined;
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/files",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      files: [],
      summary: { fileCount: 0, editCount: 0, writeCount: 0 },
    });
  });

  it("GET /api/sessions/:id/files composes from the transcript when engine.sessionFileChanges throws", async () => {
    // Half-landed engine: the wrapper exists but its backing isn't ready (it throws).
    // The route must fall back to composing from getSessionMessages, NOT surface a 500.
    // alpha-1 has no edits, so the composed fallback is an empty list + zeroed summary.
    (current!.engine as unknown as Record<string, unknown>).sessionFileChanges = () => {
      throw new Error("index.sessionFileChanges is not a function");
    };
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/files",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      files: [],
      summary: { fileCount: 0, editCount: 0, writeCount: 0 },
    });
  });

  it("POST /api/reindex acks immediately and invokes engine.indexAll with force", async () => {
    // Stub indexAll so we can assert it was called (with force when supported) and
    // so the test never runs a real full reindex. It stays pending until we release
    // it, modeling a slow background pass — the route must NOT block on it.
    const calls: Array<{ force?: boolean }> = [];
    let release!: () => void;
    const pending = new Promise<void>((res) => {
      release = res;
    });
    (current!.engine as unknown as Record<string, unknown>).indexAll = (opts?: {
      force?: boolean;
    }) => {
      calls.push({ force: opts?.force });
      return pending;
    };

    const res = await current!.app.inject({ method: "POST", url: "/api/reindex" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true });
    // The background pass was kicked off forced; the response did not wait on it.
    expect(calls).toEqual([{ force: true }]);

    // A second immediate POST while the first is still in-flight is de-duped: it is
    // acked without starting a second concurrent run (still just one call).
    const res2 = await current!.app.inject({ method: "POST", url: "/api/reindex" });
    expect(res2.statusCode).toBe(202);
    expect(res2.json()).toEqual({ started: true, alreadyRunning: true });
    expect(calls.length).toBe(1);

    // Let the background pass settle so the in-flight flag clears (the module-level
    // guard is shared across tests, so we must not leave it stuck on). The route's
    // .finally() that clears it runs as a microtask chained after `pending`, so flush
    // the microtask queue (a setImmediate tick) before asserting it reindexes again.
    release();
    await pending;
    await new Promise((r) => setImmediate(r));

    // With the prior pass settled, a fresh POST starts a new (forced) run again —
    // proving the in-flight guard is per-run, not a permanent latch.
    const res3 = await current!.app.inject({ method: "POST", url: "/api/reindex" });
    expect(res3.statusCode).toBe(202);
    expect(res3.json()).toEqual({ started: true });
    expect(calls).toEqual([{ force: true }, { force: true }]);

    // Settle this run too so we don't leak the in-flight flag into later tests.
    release();
    await new Promise((r) => setImmediate(r));
  });

  it("GET /api/health/diagnostics reports the expected fields (200)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/health/diagnostics",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      ready: boolean;
      version: string;
      cli: { claudeVersion: string | null };
      paths: { projectsDir: string | null; configDir: string | null; indexDbPath: string | null };
      search: { mode: string; tokenizer: string | null };
      index: {
        sessionCount: number | null;
        indexedMessageCount: number | null;
        dbSizeBytes: number | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(true);
    expect(typeof body.version).toBe("string");
    // CLI version may be null in CI (no `claude` on PATH) — assert the KEY exists.
    expect(body.cli).toHaveProperty("claudeVersion");
    // Hermetic config dir points under the temp root.
    expect(body.paths.configDir).toBe(current!.root);
    expect(body.paths.projectsDir).toContain(current!.root);
    expect(body.paths.indexDbPath).toContain(current!.root);
    expect(["fts5", "like", "unknown"]).toContain(body.search.mode);
    expect(body.search).toHaveProperty("tokenizer");
    expect(body.index.sessionCount).toBe(3);
    // Three seeded sessions, each with a user + assistant line.
    expect(body.index.indexedMessageCount).toBeGreaterThan(0);
    expect(body.index).toHaveProperty("dbSizeBytes");
  });

  it("GET /api/projects/:id/overview returns the per-project deep-dive shape", async () => {
    // engine.projectOverview is an engine-lane (this-wave) method that may not have
    // landed; either way the route returns a well-formed overview. For the seeded
    // alpha project (two opus sessions) the composed fallback rolls up the count,
    // cost, per-model breakdown, and top tools from already-published engine methods.
    const res = await current!.app.inject({
      method: "GET",
      url: `/api/projects/${ALPHA_ID}/overview`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projectId: string;
      sessionCount: number;
      totalCostUsd: number;
      byModel: Array<{ model: string; sessions: number }>;
      topTools: Array<{ toolName: string; count: number }>;
    };
    expect(body.projectId).toBe(ALPHA_ID);
    expect(body.sessionCount).toBe(2);
    // Cost is present (a non-negative estimate) and the model breakdown is an array
    // that buckets alpha's two opus sessions under the single opus model. The route
    // serves the engine's overview when present and a uniform composed mirror when
    // not — both share these field names, so this holds along the lane's landing.
    expect(typeof body.totalCostUsd).toBe("number");
    expect(body.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.byModel)).toBe(true);
    expect(body.byModel.map((m) => m.model)).toEqual(["claude-opus-4-8"]);
    expect(body.byModel[0]!.sessions).toBe(2);
    // topTools is always an array; the seeded sessions each invoke Bash, so when the
    // engine's toolStats backs the ranking Bash surfaces here.
    expect(Array.isArray(body.topTools)).toBe(true);
    expect(body.topTools.some((t) => t.toolName === "Bash")).toBe(true);
  });

  it("GET /api/projects/:id/overview returns a well-formed empty overview for an unknown project (200, zeros)", async () => {
    // An unknown id must NOT 404/500 — it composes to an all-zeros overview so the
    // detail view can render an empty state without special-casing the error.
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/projects/deadbeef0000/overview",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projectId: string;
      sessionCount: number;
      totalTokens: number;
      totalCostUsd: number;
      lastTs: string | null;
      byModel: unknown[];
      topTools: unknown[];
    };
    expect(body.projectId).toBe("deadbeef0000");
    expect(body.sessionCount).toBe(0);
    expect(body.totalTokens).toBe(0);
    expect(body.totalCostUsd).toBe(0);
    expect(body.lastTs).toBe(null);
    expect(body.byModel).toEqual([]);
    expect(body.topTools).toEqual([]);
  });

  it("GET /api/projects/:id/overview forwards to engine.projectOverview when present", async () => {
    // Duck-typed capability: stub the (engine-lane, this-wave) method and confirm the
    // route forwards its result verbatim, called through with the validated project id.
    const calls: string[] = [];
    (current!.engine as unknown as Record<string, unknown>).projectOverview = (id: string) => {
      calls.push(id);
      return { projectId: id, sessionCount: 7, byModel: [], topTools: [] };
    };
    const res = await current!.app.inject({
      method: "GET",
      url: `/api/projects/${ALPHA_ID}/overview`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectId: ALPHA_ID, sessionCount: 7, byModel: [], topTools: [] });
    expect(calls).toEqual([ALPHA_ID]);
  });

  it("GET /api/projects/:id/overview composes a sane overview when engine.projectOverview throws", async () => {
    // Half-landed engine: the wrapper exists but its backing isn't ready (it throws).
    // The route must fall back to composing from published methods, NOT surface a 500.
    (current!.engine as unknown as Record<string, unknown>).projectOverview = () => {
      throw new Error("index.projectOverview is not a function");
    };
    const res = await current!.app.inject({
      method: "GET",
      url: `/api/projects/${ALPHA_ID}/overview`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { projectId: string; sessionCount: number; byModel: unknown[] };
    expect(body.projectId).toBe(ALPHA_ID);
    // The composed fallback rolled up alpha's two real sessions, proving it ran.
    expect(body.sessionCount).toBe(2);
    expect(Array.isArray(body.byModel)).toBe(true);
  });

  it("GET /api/projects/:id/overview degrades topTools to [] when toolStats is absent (still 200)", async () => {
    // The fallback's tool ranking leans on toolStats (an engine-lane method too).
    // With both projectOverview and toolStats absent the overview still composes from
    // getProjectSessions — only topTools degrades to []. Never a 500.
    (current!.engine as unknown as Record<string, unknown>).projectOverview = undefined;
    (current!.engine as unknown as Record<string, unknown>).toolStats = undefined;
    const res = await current!.app.inject({
      method: "GET",
      url: `/api/projects/${ALPHA_ID}/overview`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionCount: number; topTools: unknown[] };
    expect(body.sessionCount).toBe(2);
    expect(body.topTools).toEqual([]);
  });
});

describe("budget endpoints", () => {
  beforeEach(async () => {
    current = await makeApp();
  });

  it("GET /api/budget returns a status + config shape via engine.budgetStatus", async () => {
    // Duck-typed capability: stub the (engine-lane, this-wave) method and confirm the
    // route forwards its computed status under `status`, with the persisted `config`.
    (current!.engine as unknown as Record<string, unknown>).budgetStatus = () => ({
      monthlyBudgetUsd: 100,
      monthToDateUsd: 42,
      pct: 0.42,
      alert: "none",
    });
    const res = await current!.app.inject({ method: "GET", url: "/api/budget" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: { monthlyBudgetUsd: number | null; monthToDateUsd: number; pct: number; alert: string };
      config: { capUsd: number | null; warnFraction: number; enforce: boolean };
    };
    expect(body.status).toEqual({
      monthlyBudgetUsd: 100,
      monthToDateUsd: 42,
      pct: 0.42,
      alert: "none",
    });
    // Fresh config dir: no cap set, default warn threshold, enforce off.
    expect(body.config).toEqual({ capUsd: null, warnFraction: 0.8, enforce: false });
  });

  it("GET /api/budget degrades to a null-cap status when no status method is present", async () => {
    // Both probes absent (typeof guard) AND a half-landed throwing method: either way
    // the route must synthesize a null-cap status (200), never a 500.
    (current!.engine as unknown as Record<string, unknown>).budgetStatus = undefined;
    (current!.engine as unknown as Record<string, unknown>).getBudgetStatus = () => {
      throw new Error("index.dailyUsage is not a function");
    };
    const res = await current!.app.inject({ method: "GET", url: "/api/budget" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: { monthlyBudgetUsd: number | null; alert: string } };
    expect(body.status.monthlyBudgetUsd).toBe(null);
    expect(body.status.alert).toBe("none");
  });

  it("PUT /api/budget rejects a negative cap (400)", async () => {
    const res = await current!.app.inject({
      method: "PUT",
      url: "/api/budget",
      payload: { capUsd: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /api/budget rejects a warnFraction outside 0..1 (400)", async () => {
    const res = await current!.app.inject({
      method: "PUT",
      url: "/api/budget",
      payload: { capUsd: 100, warnFraction: 1.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /api/budget persists the config and it round-trips on a later GET", async () => {
    const put = await current!.app.inject({
      method: "PUT",
      url: "/api/budget",
      payload: { capUsd: 250, warnFraction: 0.5, enforce: true },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { config: unknown }).config).toEqual({
      capUsd: 250,
      warnFraction: 0.5,
      enforce: true,
    });
    // It persisted through the real settings store: the cap surfaces on /api/settings,
    // and the whole config round-trips on a fresh GET /api/budget.
    const settings = await current!.app.inject({ method: "GET", url: "/api/settings" });
    expect((settings.json() as { monthlyBudgetUsd: number | null }).monthlyBudgetUsd).toBe(250);
    const get = await current!.app.inject({ method: "GET", url: "/api/budget" });
    expect((get.json() as { config: unknown }).config).toEqual({
      capUsd: 250,
      warnFraction: 0.5,
      enforce: true,
    });
  });

  it("PUT /api/budget accepts a null cap to clear the budget", async () => {
    const res = await current!.app.inject({
      method: "PUT",
      url: "/api/budget",
      payload: { capUsd: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { config: { capUsd: number | null } }).config.capUsd).toBe(null);
  });
});

describe("maintenance endpoints", () => {
  beforeEach(async () => {
    current = await makeApp();
  });

  it("GET /api/maintenance/integrity returns the engine's integrity report", async () => {
    // Duck-typed capability: stub the (engine-lane, this-wave) method and confirm the
    // route forwards its report verbatim (the read-only audit of our own index DB).
    const report = {
      ok: false,
      issues: [{ kind: "orphan-row", table: "tool_calls", count: 2 }],
    };
    (current!.engine as unknown as Record<string, unknown>).checkIntegrity = () => report;
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/maintenance/integrity",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(report);
  });

  it("GET /api/maintenance/integrity degrades to a minimal report when absent or throwing", async () => {
    // Method missing (typeof guard) AND a half-landed throwing one: either way the
    // route must synthesize a minimal healthy report flagged `unavailable`, never a 500.
    (current!.engine as unknown as Record<string, unknown>).checkIntegrity = () => {
      throw new Error("index.checkIntegrity is not a function");
    };
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/maintenance/integrity",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, issues: [], unavailable: true });
  });

  it("POST /api/maintenance/repair acks immediately and invokes engine.repairIntegrity, de-duping a concurrent call", async () => {
    // Stub repairIntegrity so we can assert it was called and so the test never runs a
    // real repair. It stays pending until we release it, modeling a slow background
    // reindex-style pass — the route must NOT block on it.
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((res) => {
      release = res;
    });
    (current!.engine as unknown as Record<string, unknown>).repairIntegrity = () => {
      calls += 1;
      return pending;
    };

    const res = await current!.app.inject({
      method: "POST",
      url: "/api/maintenance/repair",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true });
    // The background repair was kicked off; the response did not wait on it.
    expect(calls).toBe(1);

    // A second immediate POST while the first is still in-flight is de-duped: it is
    // acked without starting a second concurrent repair (still just one call).
    const res2 = await current!.app.inject({
      method: "POST",
      url: "/api/maintenance/repair",
    });
    expect(res2.statusCode).toBe(202);
    expect(res2.json()).toEqual({ started: true, alreadyRunning: true });
    expect(calls).toBe(1);

    // Let the background pass settle so the in-flight flag clears (the module-level
    // guard is shared across tests, so we must not leave it stuck on). The route's
    // .finally() that clears it runs as a microtask chained after `pending`, so flush
    // the microtask queue (a setImmediate tick) before asserting it repairs again.
    release();
    await pending;
    await new Promise((r) => setImmediate(r));

    // With the prior pass settled, a fresh POST starts a new repair again — proving
    // the in-flight guard is per-run, not a permanent latch.
    const res3 = await current!.app.inject({
      method: "POST",
      url: "/api/maintenance/repair",
    });
    expect(res3.statusCode).toBe(202);
    expect(res3.json()).toEqual({ started: true });
    expect(calls).toBe(2);

    // Settle this run too so we don't leak the in-flight flag into later tests.
    release();
    await new Promise((r) => setImmediate(r));
  });

  it("POST /api/maintenance/repair acks unavailable when the engine method is absent (202, never 500)", async () => {
    // Engine method not landed yet (typeof guard): ack without starting any work.
    (current!.engine as unknown as Record<string, unknown>).repairIntegrity = undefined;
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/maintenance/repair",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true, unavailable: true });
  });
});

describe("portable archive endpoints", () => {
  beforeEach(async () => {
    current = await makeApp();
  });

  it("GET /api/export/archive defaults to the DevHub v2 bundle (no session content/paths)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/export/archive",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("devhub-archive-v2.json");
    // The default is authority-clean, NOT the legacy rollback cache.
    expect(res.headers["x-devhub-archive-authority"]).toBeUndefined();
    const bundle = res.json() as {
      kind: string;
      schemaVersion: number;
      legacyMeta: unknown[];
      savedViews: unknown[];
      audit: unknown[];
      providerTaskMeta: unknown[];
      providerForkLinks: unknown[];
    };
    expect(bundle.kind).toBe("devhub-archive");
    expect(bundle.schemaVersion).toBe(2);
    expect(Array.isArray(bundle.legacyMeta)).toBe(true);
    expect(Array.isArray(bundle.providerTaskMeta)).toBe(true);
    expect(Array.isArray(bundle.providerForkLinks)).toBe(true);
    // No session content, transcript path, or mirrored text leaks into the default bundle.
    expect((bundle as unknown as { sessions?: unknown }).sessions).toBeUndefined();
    expect(res.body).not.toContain("filePath");
  });

  it("GET /api/export/archive?format=legacy-v1 emits the legacy rollback bundle + authority header", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/export/archive?format=legacy-v1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toContain("devhub-archive-legacy-v1-");
    // The rollback export is labeled a rebuildable cache, never authority.
    expect(res.headers["x-devhub-archive-authority"]).toBe("legacy-rebuildable-cache");
    const bundle = res.json() as { kind: string; schemaVersion: number; sessions: unknown[] };
    expect(bundle.kind).toBe("claude-ui-archive");
    expect(bundle.schemaVersion).toBe(1);
    expect(Array.isArray(bundle.sessions)).toBe(true);
    // No verified unified mappings were seeded, so the whole corpus is still legacy.
    expect(bundle.sessions.length).toBe(3);
  });

  it("GET /api/export/archive 503s when the engine method is absent", async () => {
    // Capability guard: an older engine without exportArchive degrades to 503, not a 500.
    (current!.engine as unknown as Record<string, unknown>).exportArchive = undefined;
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/export/archive",
    });
    expect(res.statusCode).toBe(503);
  });

  it("POST /api/import/archive restores a v2 bundle, idempotently (no session churn)", async () => {
    const exp = await current!.app.inject({ method: "GET", url: "/api/export/archive" });
    expect(exp.statusCode).toBe(200);
    const bundle = exp.json();

    const before = current!.engine.index.getSessionCount();

    const imp = await current!.app.inject({
      method: "POST",
      url: "/api/import/archive",
      payload: bundle,
    });
    expect(imp.statusCode).toBe(200);
    const summary = imp.json() as { importedSessions: number; providerMeta: number };
    // v2 carries no session rows — the session corpus is untouched.
    expect(summary.importedSessions).toBe(0);
    expect(current!.engine.index.getSessionCount()).toBe(before);

    // Idempotent: a second import of the same bundle is a clean no-op replace.
    const imp2 = await current!.app.inject({
      method: "POST",
      url: "/api/import/archive",
      payload: bundle,
    });
    expect(imp2.statusCode).toBe(200);
    expect(current!.engine.index.getSessionCount()).toBe(before);
  });

  it("POST /api/import/archive restores a legacy v1 bundle round-trip", async () => {
    const exp = await current!.app.inject({
      method: "GET",
      url: "/api/export/archive?format=legacy-v1",
    });
    const legacy = exp.json();
    const imp = await current!.app.inject({
      method: "POST",
      url: "/api/import/archive",
      payload: legacy,
    });
    expect(imp.statusCode).toBe(200);
    const summary = imp.json() as { importedSessions: number };
    expect(summary.importedSessions).toBe(3);
  });

  it("POST /api/import/archive rejects a malformed body (400)", async () => {
    // Neither a v1 sessions array nor a v2 payload → the shape gate rejects it.
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/import/archive",
      payload: { kind: "devhub-archive", schemaVersion: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("invalid archive bundle");
  });

  it("POST /api/import/archive rejects an incompatible schemaVersion (400, never 500)", async () => {
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/import/archive",
      payload: {
        kind: "devhub-archive",
        schemaVersion: 999999,
        timestamp: 0,
        legacyMeta: [],
        savedViews: [],
        audit: [],
        providerTaskMeta: [],
        providerForkLinks: [],
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("incompatible archive");
  });
});

describe("session file-change summary (seeded edits)", () => {
  // A dedicated hermetic config dir holding ONE session that runs the file-mutating
  // tools (Edit / Write / MultiEdit / NotebookEdit), so the composed fallback has
  // real file_path inputs to roll up. Kept separate from the shared makeApp fixture
  // (which only seeds Bash) so the assertions stay precise.
  let local: { app: FastifyInstance; engine: Engine; root: string } | undefined;
  let prevDir: string | undefined;

  beforeEach(async () => {
    prevDir = process.env.CLAUDE_CONFIG_DIR;
    const root = mkdtempSync(path.join(os.tmpdir(), "cui-files-test-"));
    process.env.CLAUDE_CONFIG_DIR = root;
    const projectsDir = path.join(root, "projects", "-proj");
    mkdirSync(projectsDir, { recursive: true });

    const cwd = "/home/me/edits";
    writeFileSync(
      path.join(projectsDir, "edits-1.jsonl"),
      jl({ type: "user", cwd, timestamp: "2026-06-03T08:00:00.000Z", message: { role: "user", content: "fix the bug" } }) +
        jl({
          type: "assistant",
          cwd,
          timestamp: "2026-06-03T08:00:01.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [
              { type: "text", text: "editing" },
              // Two edits to the same file → count 2, kind "edit".
              { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/home/me/edits/app.ts", old_string: "a", new_string: "b" } },
              { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/home/me/edits/app.ts", old_string: "b", new_string: "c" } },
              // A Write to a different file → kind "write".
              { type: "tool_use", id: "t3", name: "Write", input: { file_path: "/home/me/edits/README.md", content: "hi" } },
              // A non-mutating tool is ignored (Bash carries no file_path).
              { type: "tool_use", id: "t4", name: "Bash", input: { command: "ls" } },
            ],
            usage: { input_tokens: 100, output_tokens: 10 },
          },
        }),
    );

    const engine = new Engine(path.join(root, "index.db"));
    await engine.indexAll();
    const { app } = buildApp({ engine });
    await app.ready();
    local = { app, engine, root };
  });

  afterEach(async () => {
    if (local) {
      await local.app.close();
      local.engine.close();
      local = undefined;
    }
    if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevDir;
  });

  it("rolls up Edit/Write tool calls into a per-file summary, most-touched first", async () => {
    const res = await local!.app.inject({
      method: "GET",
      url: "/api/sessions/edits-1/files",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      files: Array<{ filePath: string; absPath: string; edits: number; writes: number; tools: string[] }>;
      summary: { fileCount: number; editCount: number; writeCount: number };
    };
    // app.ts edited twice (2 edits, most activity → sorts first); README.md written once.
    // The Bash call carries no file_path, so it's dropped. Paths are relativized against
    // the session cwd (/home/me/edits) for display, with the absolute path kept on absPath.
    expect(body.files).toEqual([
      { filePath: "app.ts", absPath: "/home/me/edits/app.ts", edits: 2, writes: 0, tools: ["Edit"] },
      { filePath: "README.md", absPath: "/home/me/edits/README.md", edits: 0, writes: 1, tools: ["Write"] },
    ]);
    // The edited file's absolute path must show up in the rollup.
    expect(body.files.some((f) => f.absPath === "/home/me/edits/app.ts")).toBe(true);
    // Headline summary totals across all files.
    expect(body.summary).toEqual({ fileCount: 2, editCount: 2, writeCount: 1 });
  });
});

describe("server token auth", () => {
  beforeEach(async () => {
    current = await makeApp({ token: "secret" });
  });

  it("rejects a request with no token (401)", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts a Bearer-token request (200)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts a ?token query-param request (200)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/projects?token=secret",
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong token (401)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("exempts /api/health from the token check", async () => {
    const res = await current!.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("guards the autotag suggest endpoint behind the token (401 without it)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/autotag/suggest",
    });
    expect(res.statusCode).toBe(401);
    const ok = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/autotag/suggest",
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("guards the project overview endpoint behind the token (401 without it)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: `/api/projects/${ALPHA_ID}/overview`,
    });
    expect(res.statusCode).toBe(401);
    const ok = await current!.app.inject({
      method: "GET",
      url: `/api/projects/${ALPHA_ID}/overview`,
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("guards the session files endpoint behind the token (401 without it)", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/files",
    });
    expect(res.statusCode).toBe(401);
    const ok = await current!.app.inject({
      method: "GET",
      url: "/api/sessions/alpha-1/files",
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

/**
 * The mutation token env now resolves through the DEVHUB_* / CLAUDE_UI_* compat layer:
 * DEVHUB_TOKEN is preferred, the CLAUDE_UI_TOKEN alias is accepted only when the DevHub
 * form is absent, and on a conflict the DevHub value wins (value-free diagnostic only).
 * No opts.token is passed here so buildApp reads the environment.
 */
describe("server mutation token env compat (DEVHUB_TOKEN / CLAUDE_UI_TOKEN)", () => {
  let prevDevhub: string | undefined;
  let prevAlias: string | undefined;

  beforeEach(() => {
    prevDevhub = process.env.DEVHUB_TOKEN;
    prevAlias = process.env.CLAUDE_UI_TOKEN;
    delete process.env.DEVHUB_TOKEN;
    delete process.env.CLAUDE_UI_TOKEN;
  });

  afterEach(() => {
    if (prevDevhub === undefined) delete process.env.DEVHUB_TOKEN;
    else process.env.DEVHUB_TOKEN = prevDevhub;
    if (prevAlias === undefined) delete process.env.CLAUDE_UI_TOKEN;
    else process.env.CLAUDE_UI_TOKEN = prevAlias;
  });

  it("accepts a request bearing the DEVHUB_TOKEN value", async () => {
    process.env.DEVHUB_TOKEN = "devhub-secret";
    current = await makeApp();
    const bad = await current.app.inject({ method: "GET", url: "/api/projects" });
    expect(bad.statusCode).toBe(401);
    const ok = await current.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer devhub-secret" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("accepts the CLAUDE_UI_TOKEN alias only when DEVHUB_TOKEN is absent", async () => {
    process.env.CLAUDE_UI_TOKEN = "legacy-secret";
    current = await makeApp();
    const ok = await current.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer legacy-secret" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("prefers DEVHUB_TOKEN over CLAUDE_UI_TOKEN on a conflict", async () => {
    process.env.DEVHUB_TOKEN = "devhub-secret";
    process.env.CLAUDE_UI_TOKEN = "legacy-secret";
    current = await makeApp();
    // The DevHub value is authoritative; the legacy alias is ignored.
    const legacy = await current.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer legacy-secret" },
    });
    expect(legacy.statusCode).toBe(401);
    const devhub = await current.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer devhub-secret" },
    });
    expect(devhub.statusCode).toBe(200);
  });
});
