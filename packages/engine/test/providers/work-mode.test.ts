import { describe, expect, it } from "vitest";
import {
  addWorkModeDeliverable,
  assertActionPermitted,
  assertPathInFolderScope,
  createWorkModeTask,
  isWorkModeTask,
  recordWorkModeArtifact,
  updateWorkModeProgress,
  WorkModeDisabledError,
  WorkModeFolderScopeViolationError,
  WorkModePermissionDeniedError,
  WORK_MODE_KIND,
} from "../../src/providers/work-mode.js";
import { defineDevHubFeatureFlags } from "../../src/providers/feature-flags.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";
import type { CreateWorkModeTaskInput } from "../../src/providers/work-mode.js";

const ROOT = "/tmp/work-mode-scope";

function baseInput(overrides: Partial<CreateWorkModeTaskInput> = {}): CreateWorkModeTaskInput {
  return {
    id: "work-1",
    runtime: {
      provider: "anthropic",
      home: "/tmp/work-mode-home",
      nativeTaskKey: createNativeTaskKey("anthropic", "/tmp/work-mode-home", "native-1"),
    },
    folderScope: { root: ROOT },
    permissionProfile: {
      allowedActions: ["progress:update", "artifact:record", "deliverable:add"],
    },
    ...overrides,
  };
}

describe("work-mode: flag-off rejection at every entry point", () => {
  const disabledFlags = defineDevHubFeatureFlags({ workMode: false });
  const enabledFlags = defineDevHubFeatureFlags({ workMode: true });

  it("rejects createWorkModeTask", () => {
    expect(() => createWorkModeTask(disabledFlags, baseInput())).toThrow(WorkModeDisabledError);
  });

  it("rejects updateWorkModeProgress even given an already-built task", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    expect(() =>
      updateWorkModeProgress(disabledFlags, task, { status: "in-progress", summary: "working" }),
    ).toThrow(WorkModeDisabledError);
  });

  it("rejects recordWorkModeArtifact", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    expect(() =>
      recordWorkModeArtifact(disabledFlags, task, { path: `${ROOT}/out.txt`, kind: "file" }),
    ).toThrow(WorkModeDisabledError);
  });

  it("rejects addWorkModeDeliverable", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    expect(() =>
      addWorkModeDeliverable(disabledFlags, task, {
        id: "d1",
        description: "done",
        satisfiedByArtifactPaths: [],
      }),
    ).toThrow(WorkModeDisabledError);
  });

  it("the default flag value stays false", () => {
    const defaults = defineDevHubFeatureFlags();
    expect(defaults.workMode).toBe(false);
    expect(() => createWorkModeTask(defaults, baseInput())).toThrow(WorkModeDisabledError);
  });
});

describe("work-mode: mode distinctness from Code mode", () => {
  const enabledFlags = defineDevHubFeatureFlags({ workMode: true });

  it("uses the 'work' discriminant kind, never 'cowork'", () => {
    expect(WORK_MODE_KIND).toBe("work");
    expect(WORK_MODE_KIND).not.toBe("cowork");
    expect(String(WORK_MODE_KIND).toLowerCase()).not.toContain("cowork");
  });

  it("isWorkModeTask distinguishes a work task from a bare Code-mode NativeTaskKey/summary", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    expect(isWorkModeTask(task)).toBe(true);

    const nativeTaskKey = createNativeTaskKey("anthropic", "/tmp/work-mode-home", "native-1");
    expect(isWorkModeTask(nativeTaskKey)).toBe(false);

    const nativeTaskSummaryShaped = {
      key: nativeTaskKey,
      title: "a code-mode task",
      cwd: null,
      model: null,
      status: "active",
      createdAt: null,
      updatedAt: null,
      archived: null,
      source: "native",
    };
    expect(isWorkModeTask(nativeTaskSummaryShaped)).toBe(false);
  });

  it("carries a real provider runtime binding via the same NativeTaskKey shape Code mode uses, never a mock/simulated variant", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    expect(task.runtime.provider).toBe("anthropic");
    expect(task.runtime.nativeTaskKey.nativeTaskId).toBe("native-1");
    expect(task.kind).toBe("work");
  });
});

describe("work-mode: folder-scope enforcement", () => {
  const enabledFlags = defineDevHubFeatureFlags({ workMode: true });

  it("assertPathInFolderScope accepts a path inside the root", () => {
    expect(() => assertPathInFolderScope({ root: ROOT }, `${ROOT}/sub/file.txt`)).not.toThrow();
  });

  it("assertPathInFolderScope rejects a path escaping the root via ..", () => {
    expect(() => assertPathInFolderScope({ root: ROOT }, `${ROOT}/../outside.txt`)).toThrow(
      WorkModeFolderScopeViolationError,
    );
  });

  it("assertPathInFolderScope rejects an unrelated absolute path", () => {
    expect(() => assertPathInFolderScope({ root: ROOT }, "/tmp/completely-different/file.txt")).toThrow(
      WorkModeFolderScopeViolationError,
    );
  });

  it("createWorkModeTask rejects a folderScope whose writablePaths escape root", () => {
    expect(() =>
      createWorkModeTask(
        enabledFlags,
        baseInput({ folderScope: { root: ROOT, writablePaths: ["/tmp/elsewhere"] } }),
      ),
    ).toThrow(WorkModeFolderScopeViolationError);
  });

  it("recordWorkModeArtifact rejects an artifact path outside the folder scope", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    expect(() =>
      recordWorkModeArtifact(enabledFlags, task, { path: "/tmp/outside/leak.txt", kind: "file" }),
    ).toThrow(WorkModeFolderScopeViolationError);
  });

  it("recordWorkModeArtifact accepts an artifact path inside the folder scope", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    const next = recordWorkModeArtifact(enabledFlags, task, { path: `${ROOT}/result.txt`, kind: "file" });
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifacts[0].path).toBe(`${ROOT}/result.txt`);
    // original task is untouched
    expect(task.artifacts).toHaveLength(0);
  });
});

describe("work-mode: permission-profile enforcement", () => {
  const enabledFlags = defineDevHubFeatureFlags({ workMode: true });

  it("assertActionPermitted allows an action present in allowedActions and absent from deniedActions", () => {
    expect(() =>
      assertActionPermitted({ allowedActions: ["progress:update"] }, "progress:update"),
    ).not.toThrow();
  });

  it("assertActionPermitted denies an action absent from allowedActions by default", () => {
    expect(() => assertActionPermitted({ allowedActions: [] }, "progress:update")).toThrow(
      WorkModePermissionDeniedError,
    );
  });

  it("assertActionPermitted denies an action even if allowed, when it is also explicitly denied", () => {
    expect(() =>
      assertActionPermitted(
        { allowedActions: ["progress:update"], deniedActions: ["progress:update"] },
        "progress:update",
      ),
    ).toThrow(WorkModePermissionDeniedError);
  });

  it("updateWorkModeProgress is rejected when the task's permission profile lacks progress:update", () => {
    const task = createWorkModeTask(
      enabledFlags,
      baseInput({ permissionProfile: { allowedActions: ["artifact:record"] } }),
    );
    expect(() => updateWorkModeProgress(enabledFlags, task, { status: "in-progress", summary: "x" })).toThrow(
      WorkModePermissionDeniedError,
    );
  });

  it("recordWorkModeArtifact is rejected when the task's permission profile lacks artifact:record", () => {
    const task = createWorkModeTask(
      enabledFlags,
      baseInput({ permissionProfile: { allowedActions: ["progress:update"] } }),
    );
    expect(() => recordWorkModeArtifact(enabledFlags, task, { path: `${ROOT}/x.txt`, kind: "file" })).toThrow(
      WorkModePermissionDeniedError,
    );
  });
});

describe("work-mode: deliverables/artifacts shape", () => {
  const enabledFlags = defineDevHubFeatureFlags({ workMode: true });

  it("a new task starts with no artifacts/deliverables and pending progress", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    expect(task.artifacts).toEqual([]);
    expect(task.deliverables).toEqual([]);
    expect(task.progress.status).toBe("pending");
  });

  it("addWorkModeDeliverable accepts a deliverable whose artifact paths were already recorded", () => {
    let task = createWorkModeTask(enabledFlags, baseInput());
    task = recordWorkModeArtifact(enabledFlags, task, { path: `${ROOT}/report.md`, kind: "file" });
    task = addWorkModeDeliverable(enabledFlags, task, {
      id: "d1",
      description: "wrote the report",
      satisfiedByArtifactPaths: [`${ROOT}/report.md`],
    });
    expect(task.deliverables).toHaveLength(1);
    expect(task.deliverables[0]).toMatchObject({
      id: "d1",
      description: "wrote the report",
      satisfiedByArtifactPaths: [`${ROOT}/report.md`],
    });
  });

  it("addWorkModeDeliverable rejects a deliverable referencing an artifact path never recorded", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    expect(() =>
      addWorkModeDeliverable(enabledFlags, task, {
        id: "d1",
        description: "claims work never actually recorded",
        satisfiedByArtifactPaths: [`${ROOT}/nonexistent.md`],
      }),
    ).toThrow(TypeError);
  });

  it("updateWorkModeProgress advances status/summary/updatedAt without mutating the prior task", () => {
    const task = createWorkModeTask(enabledFlags, baseInput());
    const priorUpdatedAt = task.progress.updatedAt;
    const next = updateWorkModeProgress(enabledFlags, task, {
      status: "delivered",
      summary: "all deliverables satisfied",
    });
    expect(next.progress.status).toBe("delivered");
    expect(next.progress.summary).toBe("all deliverables satisfied");
    expect(task.progress.status).toBe("pending");
    expect(typeof next.progress.updatedAt).toBe("string");
    expect(next.progress.updatedAt >= priorUpdatedAt).toBe(true);
  });
});
