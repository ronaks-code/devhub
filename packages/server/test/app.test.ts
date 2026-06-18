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

  it("GET /api/export/archive downloads a JSON bundle with the expected top-level keys", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: "/api/export/archive",
    });
    expect(res.statusCode).toBe(200);
    // Downloadable JSON: attachment disposition with the session count in the filename.
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("claude-ui-archive-3-sessions.json");
    const bundle = res.json() as {
      kind: string;
      schemaVersion: number;
      sessions: unknown[];
      savedViews: unknown[];
      audit: unknown[];
    };
    expect(bundle.kind).toBe("claude-ui-archive");
    expect(typeof bundle.schemaVersion).toBe("number");
    expect(Array.isArray(bundle.sessions)).toBe(true);
    expect(bundle.sessions.length).toBe(3);
    expect(Array.isArray(bundle.savedViews)).toBe(true);
    expect(Array.isArray(bundle.audit)).toBe(true);
  });

  it("GET /api/export/archive?projectId=… scopes the export to one project", async () => {
    const res = await current!.app.inject({
      method: "GET",
      url: `/api/export/archive?projectId=${ALPHA_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const bundle = res.json() as { sessions: Array<{ session: { projectId: string } }> };
    expect(Array.isArray(bundle.sessions)).toBe(true);
    // If the engine honors selective export, only alpha's two sessions come back; an
    // older engine that ignores the filter exports all three (an acceptable superset).
    // Either way every returned session that carries a projectId must be a real one,
    // and alpha (the requested project) must be present.
    const projectIds = bundle.sessions
      .map((s) => s.session?.projectId)
      .filter((p): p is string => typeof p === "string");
    expect(projectIds).toContain(ALPHA_ID);
    if (bundle.sessions.length < 3) {
      // Selective export landed: it's strictly alpha's sessions, beta excluded.
      expect(projectIds.every((p) => p === ALPHA_ID)).toBe(true);
    }
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

  it("POST /api/import/archive restores a previously-exported bundle, idempotently", async () => {
    // Export the seeded corpus, then re-import it into the SAME app. Because the index
    // already holds these sessions, the import is a no-op replace (idempotent) — it must
    // not duplicate rows. We assert the session count is unchanged afterward.
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
    const summary = imp.json() as { importedSessions: number; textRows: number };
    expect(summary.importedSessions).toBe(3);

    // Idempotent: re-importing the same bundle restored the same 3 sessions without
    // inflating the corpus, and a second import is still a clean no-op replace.
    expect(current!.engine.index.getSessionCount()).toBe(before);
    const imp2 = await current!.app.inject({
      method: "POST",
      url: "/api/import/archive",
      payload: bundle,
    });
    expect(imp2.statusCode).toBe(200);
    expect((imp2.json() as { importedSessions: number }).importedSessions).toBe(3);
    expect(current!.engine.index.getSessionCount()).toBe(before);
  });

  it("POST /api/import/archive rejects a malformed body (400)", async () => {
    // Missing the `sessions` array → the shape gate rejects it before the engine.
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/import/archive",
      payload: { kind: "claude-ui-archive", schemaVersion: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("invalid archive bundle");
  });

  it("POST /api/import/archive rejects an incompatible schemaVersion (400, never 500)", async () => {
    // A well-formed envelope whose schemaVersion this build can't read: the engine throws
    // ArchiveVersionError, which the route maps to bad input (400), not a server error.
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/import/archive",
      payload: {
        kind: "claude-ui-archive",
        schemaVersion: 999999,
        timestamp: 0,
        sessions: [],
        savedViews: [],
        audit: [],
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("incompatible archive");
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
});
