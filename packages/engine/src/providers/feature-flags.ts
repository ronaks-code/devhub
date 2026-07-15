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
  // M5 Task 9 cutover: the unified provider task index is the requested default after
  // every migration/rebuild/rollback/lease/compatibility gate passed. The server still
  // reports it available/applied ONLY when the shared store exists AND the coordinator
  // initialized; an explicit stored `unifiedTaskIndex: false` is the immediate,
  // non-destructive rollback switch (legacy provider routes stay byte-compatible).
  unifiedTaskIndex: true,
  codexStyleShell: false,
  crossProviderFork: false,
  workMode: false,
});

export function defineDevHubFeatureFlags(
  overrides: Partial<DevHubFeatureFlags> = {},
): Readonly<DevHubFeatureFlags> {
  return Object.freeze({ ...DEFAULT_DEVHUB_FEATURE_FLAGS, ...overrides });
}
