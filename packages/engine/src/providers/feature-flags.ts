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
  /**
   * M6 slice 4 (ThreadWorkspace + ActivityTimeline). Default false. When requested
   * true AND the server reports it applied, the web app renders the Codex-style
   * transcript workspace — the transcript IS the task (active work in the same
   * vertical narrative as completed work), assistant prose/normal activity unframed,
   * surfaces reserved for requests/user bubbles/compact controls/composer/inspector,
   * and a geometry-stable composer slot; an explicit stored false is the immediate,
   * non-destructive rollback to the legacy `TranscriptPane`/renderers chat. Additive
   * to the umbrella `codexStyleShell` cutover flag.
   */
  threadWorkspace: boolean;
  /**
   * M6 slice 5 (Composer). Default false. When requested true AND the server reports
   * it applied, the web app mounts the canonical geometry-stable Composer (measured
   * 736x98 slot, provider-native footer context, honest Stop gating); an explicit
   * stored false is the immediate, non-destructive rollback to the legacy `ChatPane`
   * composer. Additive to the umbrella `codexStyleShell` cutover flag.
   */
  composerSurface: boolean;
  /**
   * M6 slice 6 (InspectorDock). Default false. When requested true AND the server
   * reports it applied, the web app mounts the canonical content-height inspector dock
   * (one measured 300-wide `#2d2d2d` surface: persistent non-tab `Environment` summary
   * plus exactly five runtime-gated destinations Diff/Files/Terminal/Browser/Artifacts);
   * an explicit stored false is the immediate, non-destructive rollback to the legacy
   * diff/file/git panels. Additive to the umbrella `codexStyleShell` cutover flag.
   */
  inspectorDock: boolean;
  /**
   * M6 slice 7 (TaskSearchDialog + CommandDialog). Default false. When requested true
   * AND the server reports it applied, the web app mounts the two SEPARATE Codex-style
   * dialogs — a dedicated `Search tasks and messages` results dialog and a separate
   * `Search commands and tasks` command palette (where `Search tasks` closes Commands
   * then opens Search); an explicit stored false is the immediate, non-destructive
   * rollback to the legacy `SearchPalette` with Commands unmounted exactly as today.
   * Additive to the umbrella `codexStyleShell` cutover flag.
   */
  searchCommands: boolean;
  /**
   * M6 slice 8 (Settings + secondary utilities). Default false. When requested true AND
   * the server reports it applied, the web app mounts the canonical `SettingsRoute`
   * (accessible `Appearance`/`Providers`/`Permissions` field groups, all preserved
   * config workflows still reachable) plus routes Ops/Inbox/Dashboard under secondary
   * navigation as `OpsRoute`/`InboxRoute`/`DashboardRoute`; an explicit stored false is
   * the immediate, non-destructive rollback to the legacy `SettingsPane`/`LiveOpsBoard`/
   * `InboxPane`/`DashboardPane`. Additive to the umbrella `codexStyleShell` cutover flag.
   */
  settingsSecondary: boolean;
  codexStyleShell: boolean;
  crossProviderFork: boolean;
  workMode: boolean;
}

export const DEFAULT_DEVHUB_FEATURE_FLAGS: Readonly<DevHubFeatureFlags> = Object.freeze({
  // M3 native Codex cutover: the production-wrapper resume + continued-conversation
  // live proof passed (evidence/m3/live-runtime-resume-proof.md), so native Codex is
  // now the requested default. The server still clamps the resolved value to real
  // runtime availability (a constructed native Codex runtime); an explicit stored
  // `nativeCodex: false` is the immediate, non-destructive rollback to history mode.
  nativeCodex: true,
  // M4 persistent Claude cutover: the six raw-lifecycle proofs (multi-query / resume /
  // permission / interrupt / post-interrupt / fork) all passed live against the EXACT
  // staged 2.1.207 arm64 binary with the scoped programmatic key
  // (evidence/m4/lifecycle-proof-rerun-2026-07-15-keyfile.md), after the INIT_TIMEOUT
  // handshake deadlock was fixed, so persistent Claude is now the requested default.
  // The server still clamps the resolved value to real runtime availability (a
  // constructed native Claude runtime whose canEnable() requires the wired lifecycle
  // evidence + a compatible 2.1.207 install + programmatic auth + a mutation token); an
  // explicit stored `persistentClaude: false` is the immediate, non-destructive rollback.
  persistentClaude: true,
  // M5 Task 9 cutover: the unified provider task index is the requested default after
  // every migration/rebuild/rollback/lease/compatibility gate passed. The server still
  // reports it available/applied ONLY when the shared store exists AND the coordinator
  // initialized; an explicit stored `unifiedTaskIndex: false` is the immediate,
  // non-destructive rollback switch (legacy provider routes stay byte-compatible).
  unifiedTaskIndex: true,
  // M6 umbrella cutover: the codexStyleShell strangler migration (Tasks 1-9) passed
  // its per-slice SPEC/QUALITY/SECURITY gate review (evidence/m6/<slice>/), so every
  // M6 slice flag AND the codexStyleShell umbrella are now the requested default —
  // shellChrome gates Task 1; taskRail gates Task 2; taskHeaderSetup gates Task 3;
  // threadWorkspace gates Task 4; composerSurface gates Task 5; inspectorDock gates
  // Task 6; searchCommands gates Task 7; settingsSecondary gates Task 8. Each slice
  // is still additive and independently rolls back non-destructively to its exact
  // legacy surface: the server availability clamp ANDs every resolved value against
  // real applied truth, and an explicit stored `false` on ANY ONE flag is the
  // immediate, byte-compatible rollback to the legacy App.tsx chrome for that slice
  // ONLY — the other slices (and the umbrella) are unaffected (evidence/m6/cutover/).
  shellChrome: true,
  taskRail: true,
  taskHeaderSetup: true,
  threadWorkspace: true,
  composerSurface: true,
  inspectorDock: true,
  searchCommands: true,
  settingsSecondary: true,
  codexStyleShell: true,
  crossProviderFork: false,
  workMode: false,
});

export function defineDevHubFeatureFlags(
  overrides: Partial<DevHubFeatureFlags> = {},
): Readonly<DevHubFeatureFlags> {
  return Object.freeze({ ...DEFAULT_DEVHUB_FEATURE_FLAGS, ...overrides });
}
