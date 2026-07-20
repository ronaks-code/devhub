// @vitest-environment jsdom
import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../lib/types.js";
import { loadHomeData } from "../lib/home-data.js";
import { HomePane } from "./HomePane.js";

vi.mock("../lib/home-data.js", () => ({ loadHomeData: vi.fn() }));

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "2b7ef4eb251a",
    filePath: "/tmp/session.jsonl",
    cwd: "/Users/ronak/Documents/01-code/active/claude-ui",
    projectId: "2b7ef4eb251a",
    title: "Polish DevHub navigation",
    titleSource: "first-prompt",
    firstTimestamp: "2026-07-18T10:00:00Z",
    lastTimestamp: "2026-07-18T10:00:00Z",
    messageCount: 2,
    usage: { inputTokens: 0, outputTokens: 0 },
    sizeBytes: 100,
    mtimeMs: 1,
    hasSubagents: false,
    model: null,
    pinned: false,
    ...overrides,
  } as SessionSummary;
}

describe("HomePane Recent Activity titles", () => {
  beforeEach(() => {
    vi.mocked(loadHomeData).mockResolvedValue({
      claudeSessions: [session()],
      claudeTotal: 1,
      claudeLast30Days: 1,
      codexSessions: [],
      codexStats: null,
    });
  });

  it("shows the human session title instead of mapping the project hash as cwd", async () => {
    render(createElement(HomePane, { onNewChat: vi.fn() }));

    expect(await screen.findByText("Polish DevHub navigation")).toBeInTheDocument();
    expect(screen.queryByText("2b7ef4eb251a")).toBeNull();
  });

  it("starts a new session without forwarding the React click event", async () => {
    const onNewChat = vi.fn((_unexpectedArgument?: unknown) => undefined);
    render(createElement(HomePane, { onNewChat }));

    fireEvent.click(await screen.findByRole("button", { name: "New Claude Session" }));

    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onNewChat.mock.calls[0]).toEqual([]);
  });
});
