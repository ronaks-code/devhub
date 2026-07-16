import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  defineDevHubFeatureFlags,
} from "../../src/providers/feature-flags.js";

describe("DevHub feature flags", () => {
  it("defaults nativeCodex + persistentClaude + unifiedTaskIndex + the codexStyleShell umbrella + all eight M6 slices + crossProviderFork on after the M3/M4/M5/M6/M7 cutovers, workMode off", () => {
    // M3 native Codex cutover: nativeCodex is now the requested default (live resume
    // proof captured). M4 persistent Claude cutover: persistentClaude is now the requested
    // default (six raw-lifecycle proofs passed 6/6 live after the INIT_TIMEOUT handshake fix).
    // M5 Task 9 cutover: unifiedTaskIndex is the requested default. M6 umbrella cutover: every
    // slice flag (shellChrome..settingsSecondary) AND codexStyleShell are now the requested
    // default (evidence/m6/cutover/) after their per-slice SPEC/QUALITY/SECURITY gate review.
    // M7 fork cutover: crossProviderFork is now the requested default too — the server still
    // reports it available/applied ONLY when a genuine cross-provider handoff target (a
    // second discovered provider home) exists. The not-yet-shipped workMode flag stays
    // false. The server still clamps every resolved value to real availability + applied
    // truth, so these defaults only request the features — an explicit stored `false` on
    // any one flag is still the immediate, non-destructive rollback for that flag alone.
    expect(DEFAULT_DEVHUB_FEATURE_FLAGS).toEqual({
      nativeCodex: true,
      persistentClaude: true,
      unifiedTaskIndex: true,
      shellChrome: true,
      taskRail: true,
      taskHeaderSetup: true,
      threadWorkspace: true,
      composerSurface: true,
      inspectorDock: true,
      searchCommands: true,
      settingsSecondary: true,
      codexStyleShell: true,
      crossProviderFork: true,
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
