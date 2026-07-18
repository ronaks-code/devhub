import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { registerDesktopWebRoutes } from "../src/routes/desktop-web.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function fixture(token?: string): Promise<FastifyInstance> {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-desktop-web-"));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), "<main>DevHub desktop</main>");
  writeFileSync(path.join(root, "assets", "app-12345678.js"), "window.devhub=true");
  const instance = Fastify({ logger: false });
  instance.get("/api/health", async () => ({ service: "devhub-server" }));
  await registerDesktopWebRoutes(instance, root, token);
  await instance.ready();
  app = instance;
  return instance;
}

describe("desktop web bundle", () => {
  it("serves the built index and immutable assets", async () => {
    const instance = await fixture();
    const index = await instance.inject({ url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("DevHub desktop");

    const asset = await instance.inject({ url: "/assets/app-12345678.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
  });

  it("preserves API precedence and falls SPA routes back to index.html", async () => {
    const instance = await fixture();
    expect((await instance.inject({ url: "/api/health" })).json()).toEqual({
      service: "devhub-server",
    });
    expect((await instance.inject({ url: "/browse/task-1" })).body).toContain(
      "DevHub desktop",
    );
    expect((await instance.inject({ url: "/api/does-not-exist" })).statusCode).toBe(404);
    expect((await instance.inject({ url: "/api" })).statusCode).toBe(404);
  });

  it("seeds the launch token before modules and returns 404 for missing assets", async () => {
    const token = "a".repeat(64);
    const instance = await fixture(token);
    const index = await instance.inject({ url: "/" });
    expect(index.body).toContain(`localStorage.setItem("devhub-token","${token}")`);
    expect(index.body.indexOf("localStorage.setItem")).toBeLessThan(
      index.body.indexOf("DevHub desktop"),
    );
    expect((await instance.inject({ url: "/assets/missing.js" })).statusCode).toBe(404);
  });

  it("rejects malformed and traversal paths", async () => {
    const instance = await fixture();
    expect((await instance.inject({ url: "/%E0%A4%A" })).statusCode).toBe(400);
    expect((await instance.inject({ url: "/..%2Fsecret" })).statusCode).toBe(400);
  });
});
