// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../lib/types.js";
import { api } from "../../lib/api.js";
import { TopSpenders } from "./TopSpenders.js";

vi.mock("../../lib/api.js", () => ({ api: { allSessions: vi.fn() } }));

function hashedSession(): SessionSummary {
  return {
    sessionId: "2b7ef4eb251a",
    filePath: "/tmp/session.jsonl",
    cwd: "/repo/devhub",
    projectId: "project-hash",
    title: "2b7ef4eb251a",
    titleSource: "session-id",
    firstTimestamp: "2026-07-18T10:00:00Z",
    lastTimestamp: "2026-07-18T10:00:00Z",
    messageCount: 2,
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    sizeBytes: 100,
    mtimeMs: 1,
    hasSubagents: false,
    model: "claude-sonnet-4-20250514",
    pinned: false,
  } as SessionSummary;
}

describe("TopSpenders session titles", () => {
  it("shows the real cwd project instead of a session-id title", async () => {
    vi.mocked(api.allSessions).mockResolvedValue([hashedSession()]);
    render(createElement(TopSpenders, {}));

    expect((await screen.findAllByText("devhub")).length).toBeGreaterThan(0);
    expect(screen.queryByText("2b7ef4eb251a")).toBeNull();
  });
});
