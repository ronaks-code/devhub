import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Engine } from "@devhub/engine";
import { buildApp } from "../src/app.js";

const TOKEN = "b".repeat(64);
const HOST = "127.0.0.1:8787";
let current: { app: FastifyInstance; engine: Engine } | undefined;

afterEach(async () => {
  if (!current) return;
  await current.app.close();
  current.engine.close();
  current = undefined;
});

async function desktopApp(): Promise<FastifyInstance> {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-desktop-auth-"));
  const webDist = path.join(root, "web");
  mkdirSync(webDist);
  writeFileSync(path.join(webDist, "index.html"), "<html><head></head><body>DevHub</body></html>");
  const engine = new Engine(path.join(root, "index.db"));
  const { app } = buildApp({
    engine,
    token: TOKEN,
    desktopToken: TOKEN,
    desktopHost: HOST,
    webDist,
    nativeCodex: false,
    nativeClaude: false,
  });
  await app.ready();
  current = { app, engine };
  return app;
}

describe("packaged desktop authentication boundary", () => {
  it("refuses to construct packaged mode without a matching bearer token", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-desktop-no-token-"));
    const webDist = path.join(root, "web");
    mkdirSync(webDist);
    writeFileSync(path.join(webDist, "index.html"), "<html></html>");
    const engine = new Engine(path.join(root, "index.db"));
    expect(() => buildApp({
      engine,
      desktopHost: HOST,
      webDist,
      nativeCodex: false,
      nativeClaude: false,
    })).toThrow(/matching UI and server token/);
    engine.close();
  });

  it("bootstraps the UI but gates APIs with the per-launch token", async () => {
    const app = await desktopApp();
    const index = await app.inject({ url: "/", headers: { host: HOST } });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain(`localStorage.setItem("devhub-token","${TOKEN}")`);

    expect((await app.inject({ url: "/api/projects", headers: { host: HOST } })).statusCode)
      .toBe(401);
    expect((await app.inject({
      url: "/api/projects",
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    })).statusCode).toBe(200);
  });

  it("rejects foreign Host and Origin before exposing UI or API data", async () => {
    const app = await desktopApp();
    expect((await app.inject({ url: "/", headers: { host: "attacker.example" } })).statusCode)
      .toBe(421);
    expect((await app.inject({
      url: "/api/projects",
      method: "GET",
      headers: {
        host: HOST,
        origin: "https://attacker.example",
        authorization: `Bearer ${TOKEN}`,
      },
    })).statusCode).toBe(403);
  });
});
