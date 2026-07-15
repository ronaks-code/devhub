import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  defineDevHubFeatureFlags,
} from "../../src/providers/feature-flags.js";

describe("DevHub feature flags", () => {
  it("defaults nativeCodex + unifiedTaskIndex on after the M3/M5 cutovers, other program flags off", () => {
    // M3 native Codex cutover: nativeCodex is now the requested default (live resume
    // proof captured). M5 Task 9 cutover: unifiedTaskIndex is the requested default.
    // persistentClaude (its own live-proof gate) and the not-yet-shipped shell/fork/work
    // flags stay false. The server still clamps every resolved value to real runtime
    // availability + applied truth, so these defaults only request the features.
    expect(DEFAULT_DEVHUB_FEATURE_FLAGS).toEqual({
      nativeCodex: true,
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
    expect(defineDevHubFeatureFlags({ persistentClaude: true })).toEqual({
      ...DEFAULT_DEVHUB_FEATURE_FLAGS,
      persistentClaude: true,
    });
  });
});
