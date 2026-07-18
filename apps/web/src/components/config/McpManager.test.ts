// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpManager } from "./McpManager";

afterEach(() => vi.unstubAllGlobals());

describe("McpManager", () => {
  it("switches providers and hot-applies a Codex enable toggle", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true, provider: "openai", name: "docs", enabled: false, applied: "live" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const servers = url.includes("provider=openai")
        ? [{ provider: "openai", name: "docs", type: "stdio", command: "npx", args: ["docs"], scope: "global", raw: {}, enabled: true }]
        : [];
      return new Response(JSON.stringify(servers), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(createElement(McpManager, { projectCwd: "/workspace" }));

    await user.selectOptions(screen.getByLabelText("MCP provider"), "openai");
    expect(await screen.findByText("docs")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Disable docs" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/config/mcp",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ provider: "openai", name: "docs", enabled: false }),
      }),
    ));
    expect(await screen.findByText("Applied to this Codex session.")).toBeInTheDocument();
  });
});
