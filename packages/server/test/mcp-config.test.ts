import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "@devhub/engine";
import type { CodexMcpManager } from "@devhub/engine";
import { buildApp } from "../src/app.js";

const opened: Array<{ app: ReturnType<typeof buildApp>["app"]; engine: Engine }> = [];
afterEach(async () => {
  for (const item of opened.splice(0)) { await item.app.close(); item.engine.close(); }
  delete process.env.CLAUDE_CONFIG_DIR;
});

async function setup(codexMcp: CodexMcpManager, reloadCodexMcp = vi.fn(async () => true), reloadClaudeMcp = vi.fn(async () => false)) {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-mcp-routes-"));
  process.env.CLAUDE_CONFIG_DIR = root;
  const engine = new Engine(path.join(root, "index.db"));
  const built = buildApp({ engine, nativeCodex: false, nativeClaude: false, codexMcp, reloadCodexMcp, reloadClaudeMcp });
  await built.app.ready();
  opened.push({ app: built.app, engine });
  return { ...built, root, reloadCodexMcp, reloadClaudeMcp };
}

describe("provider-aware MCP config routes", () => {
  it("lists Codex servers with provider and enabled state", async () => {
    const codexMcp = { list: vi.fn(async () => [{ name: "docs", type: "stdio", command: "npx", args: [], scope: "global", raw: {}, enabled: false }]), upsert: vi.fn(), remove: vi.fn(), setEnabled: vi.fn() };
    const { app } = await setup(codexMcp);
    const response = await app.inject({ method: "GET", url: "/api/config/mcp?provider=openai" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([{ name: "docs", type: "stdio", command: "npx", args: [], scope: "global", raw: {}, enabled: false, provider: "openai" }]);
  });

  it("upserts, toggles and removes Codex servers then hot-reloads the active runtime", async () => {
    const codexMcp = { list: vi.fn(async () => []), upsert: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), setEnabled: vi.fn(async () => undefined) };
    const reload = vi.fn(async () => true);
    const { app } = await setup(codexMcp, reload);
    const put = await app.inject({ method: "PUT", url: "/api/config/mcp", payload: { provider: "openai", name: "docs", server: { command: "npx", args: ["docs"] } } });
    const toggle = await app.inject({ method: "PATCH", url: "/api/config/mcp", payload: { provider: "openai", name: "docs", enabled: false } });
    const remove = await app.inject({ method: "DELETE", url: "/api/config/mcp", payload: { provider: "openai", name: "docs" } });
    expect([put.statusCode, toggle.statusCode, remove.statusCode]).toEqual([200, 200, 200]);
    expect(codexMcp.upsert).toHaveBeenCalledWith("docs", { command: "npx", args: ["docs"] });
    expect(codexMcp.setEnabled).toHaveBeenCalledWith("docs", false);
    expect(codexMcp.remove).toHaveBeenCalledWith("docs");
    expect(reload).toHaveBeenCalledTimes(3);
    expect(toggle.json().applied).toBe("live");
  });

  it("deletes Claude config from CLAUDE_CONFIG_DIR and reports next-turn application", async () => {
    const codexMcp = { list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), setEnabled: vi.fn() };
    const { app, root, reloadClaudeMcp } = await setup(codexMcp);
    writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ keep: true, mcpServers: { docs: { command: "npx" } } }));
    const response = await app.inject({ method: "DELETE", url: "/api/config/mcp", payload: { provider: "anthropic", name: "docs" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().applied).toBe("next-turn");
    expect(reloadClaudeMcp).toHaveBeenCalledOnce();
    const listed = await app.inject({ method: "GET", url: "/api/config/mcp?provider=anthropic" });
    expect(listed.json()).toEqual([]);
  });
});
