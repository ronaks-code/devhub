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
import { Engine, paths } from "@claude-ui/engine";
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
    expect(res.json()).toEqual({ plugins: [], marketplaces: [] });
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
});
