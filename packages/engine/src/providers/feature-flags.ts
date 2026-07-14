export interface DevHubFeatureFlags {
  nativeCodex: boolean;
  persistentClaude: boolean;
  unifiedTaskIndex: boolean;
  codexStyleShell: boolean;
  crossProviderFork: boolean;
  workMode: boolean;
}

export const DEFAULT_DEVHUB_FEATURE_FLAGS: Readonly<DevHubFeatureFlags> = Object.freeze({
  nativeCodex: false,
  persistentClaude: false,
  unifiedTaskIndex: false,
  codexStyleShell: false,
  crossProviderFork: false,
  workMode: false,
});

export function defineDevHubFeatureFlags(
  overrides: Partial<DevHubFeatureFlags> = {},
): Readonly<DevHubFeatureFlags> {
  return Object.freeze({ ...DEFAULT_DEVHUB_FEATURE_FLAGS, ...overrides });
}
