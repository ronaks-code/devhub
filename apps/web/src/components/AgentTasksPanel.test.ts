import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentTasksPanel,
  projectAgentTasks,
  type AgentActivity,
} from "./AgentTasksPanel.js";

const base = {
  provider: "openai" as const,
  key: { provider: "openai" as const, home: "/tmp/codex", nativeTaskId: "thread-1" },
  occurredAt: "2026-07-18T00:00:00.000Z",
};

describe("AgentTasksPanel", () => {
  it("projects live agent activity by native identity and updates it in place", () => {
    const events: AgentActivity[] = [
      {
        ...base,
        type: "activity",
        turnId: "turn-1",
        itemId: "spawn-call",
        activity: "collabAgentToolCall",
        status: "inProgress",
        message: JSON.stringify({ tool: "spawnAgent", prompt: "Trace SSE", agentsStates: { "agent-thread-1": { status: "running", message: null } } }),
      },
      {
        ...base,
        type: "activity",
        turnId: "turn-1",
        itemId: "wait-call",
        activity: "collabAgentToolCall",
        status: "completed",
        message: JSON.stringify({ tool: "wait", prompt: null, agentsStates: { "agent-thread-1": { status: "completed", message: "SSE is live" } } }),
      },
    ];

    expect(projectAgentTasks(events)).toEqual([
      expect.objectContaining({ id: "agent-thread-1", label: "Trace SSE", status: "done", output: expect.stringContaining("SSE is live") }),
    ]);
  });

  it("renders running, done, and failed rows with expandable output", () => {
    const html = renderToStaticMarkup(createElement(AgentTasksPanel, {
      tasks: [
        { id: "a", label: "Audit engine", status: "running", output: null },
        { id: "b", label: "Run tests", status: "done", output: "42 passed" },
        { id: "c", label: "Build app", status: "failed", output: "exit 1" },
      ],
    }));

    expect(html).toContain('aria-label="Subagents and background tasks"');
    expect(html).toContain("Audit engine");
    expect(html).toContain("running");
    expect(html).toContain("done");
    expect(html).toContain("failed");
    expect(html).toContain("42 passed");
    expect(html).toContain("exit 1");
    expect(html.match(/<details/g)).toHaveLength(3);
  });

  it("ignores ordinary foreground tool activity", () => {
    expect(projectAgentTasks([{
      ...base,
      type: "activity",
      turnId: "turn-1",
      itemId: "cmd-1",
      activity: "commandExecution",
      status: "completed",
      message: "pnpm test",
    }])).toEqual([]);
  });
});
