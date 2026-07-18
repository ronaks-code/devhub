import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexMcpManager } from "../../src/config/codex-mcp.js";

describe("Codex MCP config manager", () => {
  it("normalizes codex mcp list --json and uses the configured CODEX_HOME", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([{ name: "docs", enabled: false, disabled_reason: "disabled",
        transport: { type: "stdio", command: "npx", args: ["-y", "docs"], env: { TOKEN: "x" } } }]),
    }));
    const manager = createCodexMcpManager({ executable: "/bin/codex", home: "/tmp/codex-home", run });

    await expect(manager.list()).resolves.toEqual([{
      name: "docs", type: "stdio", command: "npx", args: ["-y", "docs"],
      scope: "global", raw: { type: "stdio", command: "npx", args: ["-y", "docs"], env: { TOKEN: "x" } },
      enabled: false,
    }]);
    expect(run).toHaveBeenCalledWith("/bin/codex", ["mcp", "list", "--json"], { CODEX_HOME: "/tmp/codex-home" });
  });

  it("builds argv-only add/remove commands for stdio and HTTP servers", async () => {
    const run = vi.fn(async () => ({ stdout: "" }));
    const manager = createCodexMcpManager({ executable: "/bin/codex", home: "/tmp/codex-home", run });
    await manager.upsert("docs", { command: "npx", args: ["-y", "docs"], env: { TOKEN: "x" } });
    await manager.upsert("remote", { type: "http", url: "https://mcp.example.test" });
    await manager.remove("docs");
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["mcp", "add", "docs", "--env", "TOKEN=x", "--", "npx", "-y", "docs"],
      ["mcp", "add", "remote", "--url", "https://mcp.example.test"],
      ["mcp", "remove", "docs"],
    ]);
  });

  it("toggles enabled in only the named TOML table and preserves the rest", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "devhub-codex-mcp-"));
    const file = path.join(home, "config.toml");
    writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "npx"\n\n[mcp_servers.other]\nenabled = false\n');
    const manager = createCodexMcpManager({ executable: "/bin/codex", home, run: vi.fn() });

    await manager.setEnabled("docs", false);
    const afterDisable = readFileSync(file, "utf8");
    expect(afterDisable).toContain('[mcp_servers.docs]\ncommand = "npx"\nenabled = false');
    expect(afterDisable).toContain('[mcp_servers.other]\nenabled = false');
    await manager.setEnabled("docs", true);
    expect(readFileSync(file, "utf8")).toContain('[mcp_servers.docs]\ncommand = "npx"\nenabled = true');
  });
});
