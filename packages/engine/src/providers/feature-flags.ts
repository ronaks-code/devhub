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
  /**
   * M6 slice 2 (TaskRail). Default false. When requested true AND the server reports
   * it applied, the web app renders the rail as a Codex-style open list (compact
   * 256x30 selected row, quiet provider identity); an explicit stored false is the
   * immediate, non-destructive rollback to the legacy rail. Additive to `codexStyleShell`.
   */
  taskRail: boolean;
  /**
   * M6 slice 3 (TaskHeader + provider-aware task setup). Default false. When
   * requested true AND the server reports it applied, the web app renders the
   * capability-gated Codex-style task header + new-task setup (provider immutable
   * after creation; only provider-supported fields exposed); an explicit stored
   * false is the immediate, non-destructive rollback to the legacy `ChatPane`
   * header / setup. Additive to the umbrella `codexStyleShell` cutover flag.
   */
  taskHeaderSetup: boolean;
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
  // slice and rolls back non-destructively. shellChrome gates M6 Task 1;
  // taskRail gates M6 Task 2; taskHeaderSetup gates M6 Task 3.
  shellChrome: false,
  taskRail: false,
  taskHeaderSetup: false,
  codexStyleShell: false,
  crossProviderFork: false,
  workMode: false,
});

export function defineDevHubFeatureFlags(
  overrides: Partial<DevHubFeatureFlags> = {},
): Readonly<DevHubFeatureFlags> {
  return Object.freeze({ ...DEFAULT_DEVHUB_FEATURE_FLAGS, ...overrides });
}
