import { describe, expect, it } from "vitest";
import { DEFAULT_DEVHUB_FEATURE_FLAGS } from "@devhub/engine/providers";
import { resolveShellChromeMode } from "./components/features/shell/DevHubShell.js";
import { resolveTaskRailMode } from "./components/features/shell/TaskRail.js";
import { resolveTaskHeaderSetupMode } from "./components/features/providers/provider-capabilities.js";
import { resolveThreadWorkspaceMode } from "./components/features/shell/ThreadWorkspace.js";
import { resolveComposerSurfaceMode } from "./components/features/shell/Composer.js";
import { resolveInspectorDockMode } from "./components/features/inspectors/InspectorDock.js";
import { resolveSearchCommandsMode } from "./components/features/search/TaskSearchDialog.js";
import { resolveSettingsSecondaryMode } from "./components/features/settings/SettingsRoute.js";
import { resolveChatHostMode } from "./App.js";
import type { AppSettings } from "./lib/api.js";

/**
 * M6 umbrella cutover: proves the web composition side of the same contract the
 * engine/server tests cover. Each `resolve*Mode` reads exactly one slice key off
 * server-resolved `devHubFeatures` (App.tsx wires the actual mount decision), so
 * this exercises that contract directly against the now-flipped
 * `DEFAULT_DEVHUB_FEATURE_FLAGS` shape: every slice mounts its DevHubShell
 * composition by default, and an explicit `false` on any ONE flag restores that
 * slice's exact legacy surface without disturbing any other slice — no preserved
 * surface disappears.
 */
const SLICE_RESOLVERS = {
  shellChrome: resolveShellChromeMode,
  taskRail: resolveTaskRailMode,
  taskHeaderSetup: resolveTaskHeaderSetupMode,
  threadWorkspace: resolveThreadWorkspaceMode,
  composerSurface: resolveComposerSurfaceMode,
  inspectorDock: resolveInspectorDockMode,
  searchCommands: resolveSearchCommandsMode,
  settingsSecondary: resolveSettingsSecondaryMode,
} as const;

type SliceKey = keyof typeof SLICE_RESOLVERS;

const SLICE_KEYS = Object.keys(SLICE_RESOLVERS) as SliceKey[];

function settingsWith(overrides: Partial<Record<string, boolean>>): AppSettings {
  return { devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, ...overrides } };
}

describe("M6 codexStyleShell umbrella cutover (web composition)", () => {
  it("mounts every DevHubShell slice composition under the flipped defaults (flag-on -> devhub)", () => {
    const settings = settingsWith({});
    for (const key of SLICE_KEYS) {
      expect(SLICE_RESOLVERS[key](settings)).toBe("devhub");
    }
    // taskHeaderSetup + threadWorkspace + composerSurface bundle into ChatHost together.
    expect(resolveChatHostMode("devhub", "devhub", "devhub")).toBe("devhub");
  });

  it.each(SLICE_KEYS)(
    "an explicit stored false on %s restores exactly that legacy surface — every other slice stays devhub",
    (rolledBackKey) => {
      const settings = settingsWith({ [rolledBackKey]: false });
      expect(SLICE_RESOLVERS[rolledBackKey](settings)).toBe("legacy");
      for (const key of SLICE_KEYS) {
        if (key === rolledBackKey) continue;
        expect(SLICE_RESOLVERS[key](settings)).toBe("devhub");
      }
    },
  );

  it("an explicit stored false on the codexStyleShell umbrella alone does not, by itself, roll back any slice", () => {
    // Each slice gates independently off its OWN flag (not the umbrella) — this is
    // the existing per-slice contract every M6 task shipped. The umbrella flag is
    // additive bookkeeping; flipping it off alone must not silently disable a slice
    // whose own flag is still requested true.
    const settings = settingsWith({ codexStyleShell: false });
    for (const key of SLICE_KEYS) {
      expect(SLICE_RESOLVERS[key](settings)).toBe("devhub");
    }
  });
});
