import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAISessionOptions } from "@devhub/engine";
import { buildApp } from "../src/app.js";
import { openAISessions, registerOpenAIRoutes } from "../src/routes/openai.js";

const ACCESS_TOKEN = "test-access-token";

class FakeOpenAISession extends EventEmitter {
  readonly model: string;
  readonly cwd: string;
  readonly localToolsEnabled = false as const;
  readonly messages: unknown[] = [];
  readonly sends: string[] = [];
  stopCalls = 0;

  constructor(opts: OpenAISessionOptions = {}) {
    super();
    this.model = opts.model ?? "gpt-4.1";
    this.cwd = opts.cwd ?? "/tmp";
  }

  async send(text: string): Promise<void> {
    this.sends.push(text);
  }

  stop(): void {
    this.stopCalls += 1;
  }
}

type OpenAIRouteOptions = {
  enabled?: boolean;
  token?: string;
  sessionFactory?: (opts?: OpenAISessionOptions) => FakeOpenAISession;
};

let app: FastifyInstance;

async function readyRouteApp(options: OpenAIRouteOptions = {}): Promise<FastifyInstance> {
  const instance = Fastify();
  (registerOpenAIRoutes as unknown as (
    app: FastifyInstance,
    options: OpenAIRouteOptions,
  ) => void)(instance, options);
  await instance.ready();
  return instance;
}

beforeEach(() => {
  openAISessions.clear();
  delete process.env.DEVHUB_ENABLE_OPENAI_CHAT;
});

afterEach(async () => {
  openAISessions.clear();
  delete process.env.DEVHUB_ENABLE_OPENAI_CHAT;
  if (app) await app.close();
});

describe("OpenAI Chat REST security boundary", () => {
  it("is disabled by default and cannot construct a billable session", async () => {
    const sessionFactory = vi.fn(() => new FakeOpenAISession());
    app = await readyRouteApp({ token: ACCESS_TOKEN, sessionFactory });

    const response = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ enabled: false });
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(openAISessions.size).toBe(0);
  });

  it("refuses enabled mode when no server access token is configured", async () => {
    const sessionFactory = vi.fn(() => new FakeOpenAISession());
    app = await readyRouteApp({ enabled: true, sessionFactory });

    const response = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ enabled: true, authConfigured: false });
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("never accepts a query token for a REST mutation", async () => {
    const sessionFactory = vi.fn(() => new FakeOpenAISession());
    app = await readyRouteApp({ enabled: true, token: ACCESS_TOKEN, sessionFactory });

    const response = await app.inject({
      method: "POST",
      url: `/api/openai/sessions?token=${ACCESS_TOKEN}`,
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(openAISessions.size).toBe(0);
  });

  it("authenticates before revealing payload-validation details", async () => {
    const sessionFactory = vi.fn(() => new FakeOpenAISession());
    app = await readyRouteApp({ enabled: true, token: ACCESS_TOKEN, sessionFactory });

    const response = await app.inject({
      method: "POST",
      url: `/api/openai/sessions?token=${ACCESS_TOKEN}`,
      payload: { tools: true },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("rejects a hostile browser Origin before constructing a session", async () => {
    const sessionFactory = vi.fn(() => new FakeOpenAISession());
    app = await readyRouteApp({ enabled: true, token: ACCESS_TOKEN, sessionFactory });

    const response = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        origin: "https://hostile.example",
        host: "127.0.0.1:8787",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(openAISessions.size).toBe(0);
  });

  it("returns canonical model and session envelopes in explicitly enabled local mode", async () => {
    const sessionFactory = vi.fn(
      (opts?: OpenAISessionOptions) => new FakeOpenAISession(opts),
    );
    app = await readyRouteApp({ enabled: true, token: ACCESS_TOKEN, sessionFactory });

    const models = await app.inject({ method: "GET", url: "/api/openai/models" });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({
      enabled: true,
      authConfigured: true,
      models: expect.arrayContaining(["gpt-4.1"]),
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        origin: "http://localhost:5173",
        host: "127.0.0.1:8787",
      },
      payload: { model: "gpt-4.1", cwd: "/workspace" },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      sessionId: string;
      localToolsEnabled: boolean;
    };
    expect(body.sessionId).toMatch(/^oai-/);
    expect(body).not.toHaveProperty("id");
    expect(body.localToolsEnabled).toBe(false);
    expect(sessionFactory).toHaveBeenCalledWith({ model: "gpt-4.1", cwd: "/workspace" });
    expect(openAISessions.has(body.sessionId)).toBe(true);
  });

  it("stops an in-flight session through the authenticated stop endpoint", async () => {
    const session = new FakeOpenAISession();
    app = await readyRouteApp({
      enabled: true,
      token: ACCESS_TOKEN,
      sessionFactory: () => session,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {},
    });
    const { sessionId } = created.json() as { sessionId: string };

    const stopped = await app.inject({
      method: "POST",
      url: `/api/openai/sessions/${encodeURIComponent(sessionId)}/stop`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ ok: true, sessionId });
    expect(session.stopCalls).toBe(1);
  });

  it("stops a session before deleting it", async () => {
    const session = new FakeOpenAISession();
    app = await readyRouteApp({
      enabled: true,
      token: ACCESS_TOKEN,
      sessionFactory: () => session,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {},
    });
    const { sessionId } = created.json() as { sessionId: string };

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/openai/sessions/${encodeURIComponent(sessionId)}`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(removed.statusCode).toBe(204);
    expect(session.stopCalls).toBe(1);
    expect(openAISessions.has(sessionId)).toBe(false);
  });

  it("still rejects every attempt to opt into local tools", async () => {
    const sessionFactory = vi.fn(() => new FakeOpenAISession());
    app = await readyRouteApp({ enabled: true, token: ACCESS_TOKEN, sessionFactory });

    const response = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: { model: "gpt-4.1", tools: true },
    });

    expect(response.statusCode).toBe(400);
    expect(sessionFactory).not.toHaveBeenCalled();
  });
});

describe("buildApp OpenAI opt-in", () => {
  it("keeps OpenAI disabled when neither BuildOptions nor the environment opts in", async () => {
    const sessionFactory = vi.fn(() => new FakeOpenAISession());
    const built = buildApp({
      token: ACCESS_TOKEN,
      openAISessionFactory: sessionFactory,
    });
    app = built.app;

    const response = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("honors the explicit environment opt-in while retaining Bearer auth", async () => {
    process.env.DEVHUB_ENABLE_OPENAI_CHAT = "1";
    const sessionFactory = vi.fn(() => new FakeOpenAISession());
    const built = buildApp({
      token: ACCESS_TOKEN,
      openAISessionFactory: sessionFactory,
    });
    app = built.app;

    const response = await app.inject({
      method: "POST",
      url: "/api/openai/sessions",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    expect(sessionFactory).toHaveBeenCalledTimes(1);
  });
});
