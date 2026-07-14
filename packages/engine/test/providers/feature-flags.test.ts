import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  defineDevHubFeatureFlags,
} from "../../src/providers/feature-flags.js";

describe("DevHub feature flags", () => {
  it("keeps all six program flags false by default", () => {
    expect(DEFAULT_DEVHUB_FEATURE_FLAGS).toEqual({
      nativeCodex: false,
      persistentClaude: false,
      unifiedTaskIndex: false,
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
