import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  defineDevHubFeatureFlags,
} from "../../src/providers/feature-flags.js";

describe("DevHub feature flags", () => {
  it("defaults unifiedTaskIndex on after the M5 cutover, all other program flags off", () => {
    // M5 Task 9 cutover: unifiedTaskIndex is the requested default; the two live-proof
    // gated flags (nativeCodex, persistentClaude) and the not-yet-shipped shell/fork/work
    // flags stay false. The server still clamps the resolved value to real runtime
    // availability + applied truth, so this default only requests the feature.
    expect(DEFAULT_DEVHUB_FEATURE_FLAGS).toEqual({
      nativeCodex: false,
      persistentClaude: false,
      unifiedTaskIndex: true,
      shellChrome: false,
      taskRail: false,
      taskHeaderSetup: false,
      threadWorkspace: false,
      composerSurface: false,
      inspectorDock: false,
      searchCommands: false,
      settingsSecondary: false,
      codexStyleShell: false,
      crossProviderFork: false,
      workMode: false,
    });
    expect(Object.isFrozen(DEFAULT_DEVHUB_FEATURE_FLAGS)).toBe(true);
  });

  it("only enables explicit resolved overrides", () => {
    expect(defineDevHubFeatureFlags({ nativeCodex: true })).toEqual({
      ...DEFAULT_DEVHUB_FEATURE_FLAGS,
      nativeCodex: true,
    });
  });
});
