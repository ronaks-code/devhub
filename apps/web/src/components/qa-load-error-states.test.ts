// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import type { Stats } from "../lib/types";
import { InboxPane } from "./InboxPane";
import { AutomationsBoard } from "./AutomationsBoard";
import { DashboardPane } from "./DashboardPane";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QA load failures stay distinct from empty states", () => {
  it("shows an Inbox error with retry instead of Inbox zero", async () => {
    vi.spyOn(api, "allSessions").mockRejectedValueOnce(new Error("offline"));
    render(createElement(InboxPane));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load inbox");
    expect(screen.queryByText("Inbox zero")).toBeNull();

    vi.mocked(api.allSessions).mockResolvedValueOnce([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Inbox zero")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows a Scheduled Jobs error with retry instead of No automations found", async () => {
    vi.spyOn(api, "automations").mockRejectedValueOnce(new Error("offline"));
    render(createElement(AutomationsBoard));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load scheduled jobs");
    expect(screen.queryByText("No automations found")).toBeNull();

    vi.mocked(api.automations).mockResolvedValueOnce({
      ok: true,
      groups: [],
      generatedAt: new Date().toISOString(),
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No automations found")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("replaces the Dashboard's eternal skeleton with an error and retry", async () => {
    const stats = vi.spyOn(api, "stats").mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(api, "running").mockResolvedValue([]);
    vi.spyOn(api, "rollups").mockResolvedValue([]);
    render(createElement(DashboardPane));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load dashboard");
    expect(screen.queryByLabelText("Loading dashboard")).toBeNull();

    const recovered: Stats = {
      totalSessions: 0,
      totalProjects: 0,
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      totalCostUsd: 0,
      topProjects: [],
      activity: [],
      budget: { monthlyBudgetUsd: null, monthToDateUsd: 0, pct: 0, alert: "none" },
      byModel: [],
    };
    stats.mockResolvedValueOnce(recovered);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Total sessions")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
