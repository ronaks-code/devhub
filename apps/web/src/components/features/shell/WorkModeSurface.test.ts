// @vitest-environment jsdom
import { createElement } from "react";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkModeSurface } from "./WorkModeSurface.js";
import type { WorkModeApiClient, WorkModeTaskDto } from "../../../lib/work-mode-api.js";

const TASK_DTO: WorkModeTaskDto = {
  kind: "work",
  id: "work-1",
  folderScope: { root: "/active/claude-ui" },
  progress: { status: "in-progress", summary: "Ship a release-ready package", updatedAt: "2026-07-16T00:00:00.000Z" },
  artifacts: [],
  deliverables: [
    { id: "build-report", description: "Build report", satisfiedByArtifactPaths: ["/active/claude-ui/build.json"] },
  ],
};

function baseProps(overrides: Partial<Parameters<typeof WorkModeSurface>[0]> = {}) {
  return {
    enabled: true,
    title: "Prepare release audit",
    provider: "anthropic" as const,
    home: "/homes/anthropic",
    nativeTaskId: "native-1",
    folderRoot: "/active/claude-ui",
    taskId: "work-1",
    ...overrides,
  };
}

describe("WorkModeSurface", () => {
  it("never calls the client and renders nothing when the workMode flag is off", async () => {
    const getOrCreateTask = vi.fn();
    const client: WorkModeApiClient = {
      fetchStatus: vi.fn(),
      fetchTask: vi.fn(),
      createTask: vi.fn(),
      getOrCreateTask,
    };
    const { container } = rtlRender(createElement(WorkModeSurface, baseProps({ enabled: false, client })));
    await Promise.resolve();
    expect(getOrCreateTask).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("fetches/creates the real task once enabled and renders the panel from the server response", async () => {
    const getOrCreateTask = vi.fn().mockResolvedValue(TASK_DTO);
    const client: WorkModeApiClient = {
      fetchStatus: vi.fn(),
      fetchTask: vi.fn(),
      createTask: vi.fn(),
      getOrCreateTask,
    };
    rtlRender(createElement(WorkModeSurface, baseProps({ client })));

    await waitFor(() => expect(screen.getByText("Prepare release audit")).toBeInTheDocument());
    expect(getOrCreateTask).toHaveBeenCalledWith({
      id: "work-1",
      provider: "anthropic",
      home: "/homes/anthropic",
      nativeTaskId: "native-1",
      folderScope: { root: "/active/claude-ui" },
      permissionProfile: { allowedActions: ["progress:update", "artifact:record", "deliverable:add"] },
    });
    expect(screen.getByText("/active/claude-ui")).toBeInTheDocument();
    expect(screen.getByText("Build report")).toBeInTheDocument();
  });

  it("renders nothing when the server has no task to give back (e.g. disabled server-side)", async () => {
    const getOrCreateTask = vi.fn().mockResolvedValue(null);
    const client: WorkModeApiClient = {
      fetchStatus: vi.fn(),
      fetchTask: vi.fn(),
      createTask: vi.fn(),
      getOrCreateTask,
    };
    const { container } = rtlRender(createElement(WorkModeSurface, baseProps({ client })));
    await waitFor(() => expect(getOrCreateTask).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("forwards Code-mode dismissal from the loaded panel", async () => {
    const onDismiss = vi.fn();
    const client: WorkModeApiClient = {
      fetchStatus: vi.fn(),
      fetchTask: vi.fn(),
      createTask: vi.fn(),
      getOrCreateTask: vi.fn().mockResolvedValue(TASK_DTO),
    };
    rtlRender(createElement(WorkModeSurface, baseProps({ client, onDismiss })));
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Code" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
