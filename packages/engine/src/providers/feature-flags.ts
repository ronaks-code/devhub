export interface DevHubFeatureFlags {
  nativeCodex: boolean;
  persistentClaude: boolean;
  unifiedTaskIndex: boolean;
  /**
   * M6 slice 1 (DevHubShell + application chrome). Default false. When requested
   * true AND the server reports the shell component tree available/applied, the web
   * app mounts the measured Codex-style DevHubShell; an explicit stored false is the
   * immediate, non-destructive rollback to the legacy `App.tsx`/`ResponsiveShell`
   * chrome. Additive to the umbrella `codexStyleShell` cutover flag.
   */
  shellChrome: boolean;
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
  // M6 slice flags are additive and default-off; each gates exactly one strangler
  // slice and rolls back non-destructively. shellChrome gates M6 Task 1.
  shellChrome: false,
  codexStyleShell: false,
  crossProviderFork: false,
  workMode: false,
});

export function defineDevHubFeatureFlags(
  overrides: Partial<DevHubFeatureFlags> = {},
): Readonly<DevHubFeatureFlags> {
  return Object.freeze({ ...DEFAULT_DEVHUB_FEATURE_FLAGS, ...overrides });
}
