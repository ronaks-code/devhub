// @vitest-environment jsdom
import { createElement } from "react";
import { render as rtlRender, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { shouldMountWorkModeSurface } from "./App.js";
import type { AppSettings } from "./lib/api.js";
import { WorkModeSurface } from "./components/features/shell/WorkModeSurface.js";
import type { WorkModeApiClient } from "./lib/work-mode-api.js";

/**
 * M7-WORKMODE-CUTOVER: `workMode` flips `false -> true` in
 * `DEFAULT_DEVHUB_FEATURE_FLAGS`. This is the App-level proof that the cutover
 * default flip changes NOTHING about the no-fabrication contract: `App.tsx`
 * mounts `WorkModeSurface` (exactly as it does today) only when the resolved
 * flag AND a real project are both present (`shouldMountWorkModeSurface`), and
 * even once mounted with the flag on, the surface/panel it renders still shows
 * NOTHING without a real backing task from the server. Two independent gates,
 * both exercised with the POST-CUTOVER true default.
 */
describe("App Work-mode cutover — no-fabrication gate survives the default flip", () => {
  it("does not mount the surface without a real project, even with the (now-default) flag on", () => {
    const settings: AppSettings = { devHubFeatures: { workMode: true } as AppSettings["devHubFeatures"] };
    expect(shouldMountWorkModeSurface(settings, null)).toBe(false);
    expect(shouldMountWorkModeSurface(settings, { cwd: null })).toBe(false);
    expect(shouldMountWorkModeSurface(settings, { cwd: "" })).toBe(false);
  });

  it("mounts the surface only once BOTH the resolved flag and a real project.cwd are present", () => {
    const enabledSettings: AppSettings = {
      devHubFeatures: { workMode: true } as AppSettings["devHubFeatures"],
    };
    expect(shouldMountWorkModeSurface(enabledSettings, { cwd: "/active/claude-ui" })).toBe(true);

    const disabledSettings: AppSettings = {
      devHubFeatures: { workMode: false } as AppSettings["devHubFeatures"],
    };
    expect(shouldMountWorkModeSurface(disabledSettings, { cwd: "/active/claude-ui" })).toBe(false);
    expect(shouldMountWorkModeSurface(null, { cwd: "/active/claude-ui" })).toBe(false);
  });

  it(
    "renders NOTHING from the exact surface App.tsx mounts when the flag resolves true " +
      "(the post-cutover default) but the server has no real WorkModeTask to give back",
    async () => {
      const getOrCreateTask = vi.fn().mockResolvedValue(null);
      const client: WorkModeApiClient = {
        fetchStatus: vi.fn(),
        fetchTask: vi.fn(),
        createTask: vi.fn(),
        getOrCreateTask,
      };

      // Exactly the props App.tsx passes to WorkModeSurface at its one mount site,
      // once shouldMountWorkModeSurface(settings, project) resolves true.
      const project = { id: "proj-1", name: "claude-ui", cwd: "/active/claude-ui" };
      const { container } = rtlRender(
        createElement(WorkModeSurface, {
          enabled: true,
          title: project.name,
          provider: "anthropic",
          home: project.cwd,
          nativeTaskId: `work-mode-source-${project.id}`,
          folderRoot: project.cwd,
          taskId: `work-mode-${project.id}`,
          client,
        }),
      );

      await waitFor(() => expect(getOrCreateTask).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
    },
  );
});
