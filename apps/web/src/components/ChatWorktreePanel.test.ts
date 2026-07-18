// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api.js";
import { ChatWorktreePanel } from "./ChatWorktreePanel.js";

describe("ChatWorktreePanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads and exposes worktree management only after the chat drawer opens", async () => {
    const gitWorktrees = vi.spyOn(api, "gitWorktrees").mockResolvedValue([
      { path: "/repo", branch: "main", isMain: true },
      { path: "/repo-feature", branch: "feature/chat-worktrees" },
    ]);

    render(createElement(ChatWorktreePanel, { cwd: "/repo" }));

    const toggle = screen.getByRole("button", { name: "Worktrees" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(gitWorktrees).not.toHaveBeenCalled();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("feature/chat-worktrees")).toBeInTheDocument();
    expect(screen.getByTitle("Add a worktree")).toBeInTheDocument();
    expect(gitWorktrees).toHaveBeenCalledOnce();
    expect(gitWorktrees).toHaveBeenCalledWith("/repo");
  });
});
