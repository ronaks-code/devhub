import { describe, expect, it, vi } from "vitest";
import { createWorkModeApiClient, toWorkModeTaskView, type WorkModeTaskDto } from "./work-mode-api.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const TASK_DTO: WorkModeTaskDto = {
  kind: "work",
  id: "work-1",
  folderScope: { root: "/active/claude-ui" },
  progress: { status: "in-progress", summary: "3 of 5 deliverables underway", updatedAt: "2026-07-16T00:00:00.000Z" },
  artifacts: [{ path: "/active/claude-ui/build.json", kind: "file", createdAt: "2026-07-16T00:00:00.000Z" }],
  deliverables: [
    { id: "build-report", description: "Build report", satisfiedByArtifactPaths: ["/active/claude-ui/build.json"] },
    { id: "release-notes", description: "Release notes", satisfiedByArtifactPaths: [] },
  ],
};

describe("createWorkModeApiClient", () => {
  it("fetchStatus resolves false on a non-ok response and on a thrown network error", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(500, {}));
    const client = createWorkModeApiClient(fetchImpl as unknown as typeof fetch);
    expect(await client.fetchStatus()).toEqual({ enabled: false });

    const throwing = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const client2 = createWorkModeApiClient(throwing as unknown as typeof fetch);
    expect(await client2.fetchStatus()).toEqual({ enabled: false });
  });

  it("fetchStatus reflects the server's real answer", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { enabled: true }));
    const client = createWorkModeApiClient(fetchImpl as unknown as typeof fetch);
    expect(await client.fetchStatus()).toEqual({ enabled: true });
  });

  it("fetchTask returns null on 403/404 and the task on 200", async () => {
    const disabled = vi.fn().mockResolvedValueOnce(jsonResponse(403, { error: "work_mode_disabled" }));
    const client = createWorkModeApiClient(disabled as unknown as typeof fetch);
    expect(await client.fetchTask("work-1")).toBeNull();

    const found = vi.fn().mockResolvedValueOnce(jsonResponse(200, { task: TASK_DTO }));
    const client2 = createWorkModeApiClient(found as unknown as typeof fetch);
    expect(await client2.fetchTask("work-1")).toEqual(TASK_DTO);
  });

  it("getOrCreateTask fetches first and only creates when the fetch comes back empty", async () => {
    const input = {
      id: "work-1",
      provider: "anthropic" as const,
      home: "/homes/anthropic",
      nativeTaskId: "native-1",
      folderScope: { root: "/active/claude-ui" },
      permissionProfile: { allowedActions: ["progress:update"] },
    };

    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { task: TASK_DTO }));
    const client = createWorkModeApiClient(fetchImpl as unknown as typeof fetch);
    expect(await client.getOrCreateTask(input)).toEqual(TASK_DTO);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const fetchThenCreate = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: "work_mode_task_not_found" }))
      .mockResolvedValueOnce(jsonResponse(201, { task: TASK_DTO }));
    const client2 = createWorkModeApiClient(fetchThenCreate as unknown as typeof fetch);
    expect(await client2.getOrCreateTask(input)).toEqual(TASK_DTO);
    expect(fetchThenCreate).toHaveBeenCalledTimes(2);
    expect(fetchThenCreate.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });
});

describe("toWorkModeTaskView", () => {
  it("projects a real WorkModeTaskDto into the panel's view model, deriving deliverable status from recorded artifacts", () => {
    const view = toWorkModeTaskView(TASK_DTO, "Prepare release audit");
    expect(view).toEqual({
      title: "Prepare release audit",
      folderScope: "/active/claude-ui",
      outcome: { summary: "3 of 5 deliverables underway", current: 1, total: 2 },
      deliverables: [
        { id: "build-report", label: "Build report", status: "ready" },
        { id: "release-notes", label: "Release notes", status: "pending" },
      ],
    });
  });
});
