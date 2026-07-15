# M6 Approved Reference-First Codex-Style Shell Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: use subagent-driven-development. Execute one slice at a time with test-first (RED) implementation, specification review, then code-quality/design review. Do not combine the two review stages. A slice is not "done" until its own default-OFF flag is proven, its fidelity-ledger entry is written, and its per-slice gate criteria pass.

**Goal:** Convert the locked visual specification in `design-lock.md` section 2 into a Codex-quality DevHub shell by extracting eleven canonical production components (`DevHubShell`, `TaskRail`, `TaskHeader`, `TaskSetup`, `ThreadWorkspace`, `ActivityTimeline`, `Composer`, `InspectorDock`, `TaskSearchDialog`, `CommandDialog`, and the preserved Settings/secondary routes) behind per-slice default-OFF flags, one strangler slice at a time, with the existing UI live and rollback-safe the entire way. M6 changes presentation and composition only; it never invents or upgrades a provider capability, and it never claims a first-party Codex behavior that was not directly observed.

**Architecture:** Follow the strangler pattern locked in `design-lock.md` section 12 and `implementation-plan.md` "Strangler surface order." `App.tsx` becomes composition/routing incrementally: each new component is mounted behind its own explicit false-by-default slice flag while the legacy owner (its "Current anchor" in `component-state-matrix.md`/`surface-inventory.md`) stays live and byte-compatible as the instant rollback surface. A slice flag flips on only when its functional (`F`), persistence (`P`), recovery (`R`), security/capability (`S`), and visual/fidelity (`V`) gates are green for that surface; the legacy path is deleted only after the deletion (`D`) gate proves zero remaining imports. The umbrella `codexStyleShell` flag is the final cutover (mirrors M5's `unifiedTaskIndex`): it becomes the requested default only after every slice flag is green and `apps/web/src/components/ui.tsx` reaches zero imports. Visual truth is measured, not invented: wide desktop uses the exact geometry in `reference-capture-manifest.md` "Measured wide-shell geometry"; unobserved transient/narrow/motion states use the measured shell plus documented capability semantics per the manifest "Unavailable or conditional reference states."

**Tech stack:** React 19, Vite, TypeScript, Tailwind v4 CSS variables, official `@shadcn` registry primitives on a Radix base with the one audited custom preset from `design-lock.md` section 11, Lucide icons, Vitest 2 for component/behavior tests, the bundled Browser/IAB skill for real-workflow QA and current/minimum/narrow screenshots, and `view_image` for governing-image inspection. No new runtime dependency without a `design-system.md` entry.

**Operating constraints:** Work in a detached worktree rooted at the reviewed M5 tip and land tested commits on `wip/devhub-background-runner` (do not merge to `origin/main`; do not flip a production release). Never touch the four user-owned paths (`.gitignore`, `AGENTS.md`, `apps/web/src/components/ChatPane.tsx`, `apps/web/src/components/SlashPalette.tsx`) except where a slice's file list explicitly extracts from `ChatPane`/`SlashPalette` into a new owner without editing the user-owned file itself. No Python. Use at most two Vitest workers. Keep `nativeCodex` and `persistentClaude` false; M6 is visual/composition work and must render honestly against deterministic fixtures and the M5 unified index, not live billable provider turns. Every commit excludes the four user-owned paths; verify the staged path list before committing.

---

## Frozen decisions and invariants

These bind every M6 slice. A slice that violates one fails its gate regardless of visual fidelity.

1. **Provider is immutable after native task creation.** No provider picker appears inside an existing task in any extracted surface. Provider change is only `Create cross-provider fork` (an M7 flow), which leaves the source unchanged. Existing-task provider identity is read-only quiet text (`OpenAI · Codex` / `Anthropic · Claude`), never a disabled select styled to look changeable (`design-lock.md` §3; `component-state-matrix.md` §6 `selected`/`disabled`, §7).
2. **Capability-gated controls are never faked by CSS.** A control that lacks a proven provider/version runtime contract is absent or rendered as a disabled explanatory row with its exact capability reason; a disabled/greyed style may never stand in for a missing runtime contract, and no schema-only control is advertised as working (`design-lock.md` §5, §6, §8; `component-state-matrix.md` §2 capability presentation algorithm, §10 `disabled`/`unsupported`). Timeout never emits Allow; late request responses are no-ops.
3. **Preserved surfaces never disappear.** Every surface listed in `surface-inventory.md` §5 and every legacy route `RT-01..RT-09` stays reachable through its route, Search, Commands, Settings, the inspector, or a compact overflow throughout M6. A legacy owner is deleted only after its preservation row passes `F/P/R/S/V/D`; until then its current visible copy must survive unchanged. Deleting DevHub cache is never equated with deleting native history.
4. **No dashboard or marketing chrome in the task canvas.** The core task canvas (`#181818` open canvas, no page card) admits only requests, user bubbles, compact controls, composer, and inspector as surfaces; assistant prose and normal activity stay unframed. No dashboard grid, KPI cards, marketing copy, decorative badges/pills, gradients, glows, generic IDE chrome, welcome hero, suggestions, or onboarding illustration enters the task canvas. Ops/Inbox/Dashboard/analytics remain secondary utilities, never task-home cards (`design-lock.md` §4, `chatgpt-empty-task-1800x1130.png`; `component-state-matrix.md` §4, §13; `surface-inventory.md` `SF-04`).
5. **Measured geometry is the visual authority.** Wide desktop uses the exact logical units in `reference-capture-manifest.md`: 273 rail, 46 header, `#181818` canvas, 736 transcript/composer column, 736x98 resting composer with 16 bottom gutter, 300 content-height inspector with 12 top / 16 right gutter, 256x30 selected row at 8 inset, user bubble max ~566. Invented geometry, oversized headings/overlays, and cropped concept surfaces are rejected (`design-lock.md` §4, §13).
6. **Concept screenshots are provenance, never shipped UI.** All visible product text, controls, icons, lists, dialogs, and state remain code-native. Generated misspellings, malformed tabs/paths, rejected permission terms, and artifact contradictions never become implementation requirements (`design-lock.md` §13; `component-state-matrix.md` §1).
7. **shadcn substrate is official-registry-only with the one audited custom preset.** Use `@shadcn` registry source, Radix base, `rsc:false`, Tailwind v4 CSS variables, Lucide, and the `@/*` alias. Before each primitive: registry search, current docs, `add --dry-run`, `add --diff`, file inspection. No named visual preset, `--defaults`, page block, `apply`, `--force`, `--reinstall`, `--overwrite`, `add --all`, or default styling. Keep `ui.tsx` as a compatibility facade until zero imports remain; do not flag-day migrate controls (`design-lock.md` §11; `surface-inventory.md` §8).
8. **The virtualized transcript is never wrapped in shadcn `ScrollArea`.** Native virtualized scroll is preserved; `ScrollArea` is allowed only inside a bounded, non-virtualized diff (`design-lock.md` §11; `surface-inventory.md` `SF-06`, `SF-12`).
9. **Brand is always `DevHub`.** The global shell wordmark is never `Codex`, `ChatGPT`, `Claude`, `OpenAI`, `Anthropic`, or `Claude UI`. Provider identity is quiet secondary text only, with no generated or imitation logos and no implied first-party affiliation (`design-lock.md` §3; `surface-inventory.md` §2, `T-shell`).
10. **The installed dark Codex build is the fidelity reference; light is a supported theme, not a claimed first-party match.** A functional result inside the preserved shell is never relabeled as final M6 visual parity (`fidelity-ledger.md` preamble; `reference-capture-manifest.md`).
11. **Keyboard-first behavior, accessibility, and reduced motion are mandatory per-slice gates, not polish.** Logical tab order, visible focus, accessible names, status/stream announcements, Escape, arrow navigation, focus traps/restoration, scroll locking, forced-colors distinctness, and `prefers-reduced-motion` support (with interruption/reversal and focus restoration) must pass before any slice flag advances (`design-lock.md` §10; `component-state-matrix.md` §3, §17).
12. **Each slice ships behind its own explicit false-by-default flag with a non-destructive rollback.** No slice defaults on in its own task. The umbrella `codexStyleShell` flips to requested-default true only in the final cutover task, after every slice flag is green and `ui.tsx` imports reach zero. An explicit stored false on any flag instantly restores that surface's legacy owner without schema or data change. `nativeCodex`/`persistentClaude` stay false throughout.

### Slice feature-flag scheme

M6 adds eight additive, default-false slice flags to `DevHubFeatureFlags` (in `packages/engine/src/providers/feature-flags.ts`), each gating exactly one strangler slice, plus reuses the existing umbrella `codexStyleShell` (already present, default false) as the final cutover switch:

| Slice | Slice flag (default false) | Legacy rollback owner |
|---|---|---|
| 1 DevHubShell + chrome | `shellChrome` | `App.tsx` layout + `ResponsiveShell.tsx` + `TopBar` |
| 2 TaskRail | `taskRail` | `App.tsx` rail + `ProjectsPane`/`SessionsPane`/`RecentMenu` |
| 3 TaskHeader + provider-aware setup | `taskHeaderSetup` | `ChatPane` header + `ProjectDetailHeader`/`BranchSwitcher` |
| 4 ThreadWorkspace + ActivityTimeline | `threadWorkspace` | `TranscriptPane`/`MessageView`/`ToolGroup` renderers |
| 5 Stable Composer | `composerSurface` | `ChatPane` composer (extract; do not edit `ChatPane.tsx`/`SlashPalette.tsx`) |
| 6 InspectorDock | `inspectorDock` | `DiffView`/`FileChangeSummary`/`GitPanel`/`WorktreePanel` |
| 7 Search / command palette | `searchCommands` | `SearchPalette.tsx` + (unmounted) `CommandPalette.tsx` |
| 8 Settings / secondary | `settingsSecondary` | `SettingsPane` + `LiveOpsBoard`/`InboxPane`/`DashboardPane` |
| Final cutover | `codexStyleShell` (umbrella; requested-default flips true) | all of the above, byte-compatible until `D` |

Rule: a slice flag is server-available only when its component tree builds; it is reported applied only when the slice mounts without falling back to the legacy owner. Flag-off routing must not instantiate the new component tree (proved by test), exactly as M5's flag-off routing never instantiates the coordinator.

### Per-slice gate criteria (applies to every Task 1–8)

A slice flag advances only after ALL of the following, recorded in its `fidelity-ledger.md` entry and, where visual, under `evidence/m6/<slice>/`:

- **Screenshots:** current (1800-wide measured), minimum (the preserved 1024 boundary), and narrow (768) viewport captures via the Browser/IAB skill, plus governing-image inspection with `view_image`.
- **≥5 concrete comparison points** against the slice's governing reference capture/concept, each a measurable claim (geometry unit, flat color token, copy string, row density, focus/selection treatment), with match/intentional-mismatch disposition.
- **Visible-copy diff:** before/after visible-string snapshot of every route/surface the slice touches, proving `surface-inventory.md` §6 exact copy is met and no preserved copy regressed.
- **Keyboard/a11y:** the slice's `component-state-matrix.md` accessibility column and the §17 assertions for its family pass (roles/names/states, focus order, focus restoration, no hidden narrow/desktop duplicate remains tabbable, reduced motion, forced-colors distinctness).
- **`F/P/R/S/V` as applicable** from `surface-inventory.md` cutover-gate keys; `D` (legacy deletion) is deferred to the final cutover task, never taken inside a slice.
- **Fidelity-ledger entry** appended under the new `## M6 - approved Codex-style shell` section (see "Fidelity ledger requirement" below).

### Fidelity ledger requirement

Extend `fidelity-ledger.md` with a `## M6 - approved Codex-style shell` section. Each slice appends its own dated sub-table in the exact shape of the existing M3 table — columns `Comparison | Governing reference | M6 implementation evidence | Finding / disposition` — with one row per comparison point (minimum five) and an explicit disposition (`Match` / `Match after test-first repair` / `Intentional deviation` with reason). No M6 row may relabel an M3/M4 functional result as new visual parity; that separation is the ledger's stated purpose.

### Brownfield shadcn initialization (prerequisite, before Task 1)

Per `implementation-plan.md` "Brownfield shadcn initialization" and `design-lock.md` §11: apply only the reviewed disposable custom-preset alias/config/dependency/CSS changes; inspect the complete URL/config and disposable diff and stop if it cannot be audited. Move the clay brand token from `--accent` to `--dh-brand`/`--brand`, reserve `--primary` for the neutral high-contrast action, `--accent` for neutral hover/selection, and preserve/alias legacy tokens per `design-system.md`. This lands as its own commit ahead of Task 1 and touches only config/CSS, not component behavior.

---

## Task 1: DevHubShell and application chrome

**Owner (target):** `apps/web/src/components/features/shell/DevHubShell.tsx` (canonical `DevHubShell`). Legacy anchors: `apps/web/src/App.tsx` layout, `apps/web/src/components/ResponsiveShell.tsx`, `TopBar`.

**Maps to:** `component-state-matrix.md` §4 (Shell) and §16 (Responsive shell/PWA); `surface-inventory.md` `SF-01`, route inventory `RT-10`, `T-shell` copy, §9 responsive ownership.

**Governing reference:** `chatgpt-empty-task-1800x1130.png` (REF-EMPTY) and `chatgpt-current-1800x1130.png` (REF-RICH) for the measured 273/46/`#181818`/16-gutter frame; `design-lock.md` §4 container/geometry model; `reference-capture-manifest.md` "Measured wide-shell geometry."

**Slice flag:** `shellChrome` (default false). Flag-off renders the existing `App.tsx`/`ResponsiveShell` chrome byte-for-byte.

**RED-first testable DoD:**
1. Write failing tests first: `DevHubShell` renders one `main`, a named rail landmark, an optional named complementary inspector region, and a skip link; wide layout matches measured slots (273 rail, 46 header, open `#181818` canvas, stable bottom composer slot, content-height inspector slot, 16 outer gutters); shell geometry does not shift between rest/loading/streaming; provider failure is isolated to its region (chrome, cached list, draft, navigation preserved); the global brand string is exactly `DevHub` and never a provider wordmark; below 1024 the one-pane drill-down is preserved with no horizontal overflow and no hidden duplicate tabbable control.
2. Implement `DevHubShell` to green using the audited shadcn `Sidebar`/`Separator`/`Tooltip`/`Button` primitives and custom layout; mount it only under `shellChrome` true, with `App.tsx` composition routing to it, legacy chrome under false.
3. Prove flag-off does not instantiate `DevHubShell`.
4. Web typecheck, `vite build` (eager bundle stays Node-free), `git diff --check`.

**Per-slice gate:** screenshots (1800/1024/768) + ≥5 comparison points (rail width 273, header height 46, canvas color `#181818`, outer gutter 16, brand text `DevHub`) + `T-shell` visible-copy diff (`DevHub`, `Skip to main content`, `Search`, `Settings`, `Keyboard shortcuts`; no `Claude UI`) + keyboard/a11y (skip link, tab order rail→content/composer→inspector, focus ring without reflow) + `F/P/V`. Fidelity-ledger entry appended.

## Task 2: TaskRail

**Owner (target):** `apps/web/src/components/features/shell/TaskRail.tsx` (canonical `TaskRail`) plus provider-aware task-row/section primitives. Legacy anchors: `App.tsx` rail, `ProjectsPane.tsx`, `SessionsPane.tsx`, `RecentMenu`.

**Maps to:** `component-state-matrix.md` §5 (Rail and task rows); `surface-inventory.md` `SF-02`, preserved "Project/session organization" (§5), `T-rail` copy, `RT-01/RT-02` routes.

**Governing reference:** REF-EMPTY, REF-ACTIVE, REF-RICH for rail grouping, open-list hierarchy (not nested cards), the 256x30 selected row at 8 inset, quiet spinner on active row; concept `01-new-task-empty` (C01); `design-lock.md` §4 "Rail hierarchy is an open list."

**Slice flag:** `taskRail` (default false). Flag-off keeps `ProjectsPane`/`SessionsPane`/`RecentMenu` and the legacy rail.

**RED-first testable DoD:**
1. Failing tests first: compact task-first open list (no nested cards); each row exposes accessible task title AND provider text (`Codex`/`Claude` suffix, full `OpenAI · Codex`/`Anthropic · Claude` in accessible name) — provider may be visually quiet but never absent; selected row uses measured 256x30 compact fill and does not change height when a quiet active spinner appears; roving focus with Arrow/J/K/Home/End/Enter, overflow `Actions for {task}` independently tabbable and reachable without hover; secondary destinations (`Scheduled`/`Plugins`/`Pull requests`/`Projects`/`Tasks`/`Ops`/`Inbox`/`Settings`) appear only when reachable and never inert; provider failure never marks other-provider rows failed; `Archive in DevHub` is labeled local when a Claude native archive is absent and never equated with native deletion; narrow uses a collapsed strip or accessible titled `Sheet` with no duplicate selected route.
2. Implement using audited shadcn `Sidebar` (no cookie persistence/shortcut), `Collapsible`, `ContextMenu`, `DropdownMenu`, `Tooltip`, native scrolling; mount under `taskRail` true.
3. Prove flag-off does not instantiate `TaskRail`.
4. Typecheck, build, `git diff --check`.

**Per-slice gate:** screenshots + ≥5 comparison points (open-list density, selected fill `#313131`, row 256x30, 8 inset, provider suffix present in accessible name) + `T-rail` visible-copy diff (`New task`, `No tasks`, provider suffixes; no unapproved generated rail strings) + keyboard/a11y (roving focus distinct from selection, overflow reachable on focus) + `F/P/R/V`. Fidelity-ledger entry appended.

## Task 3: TaskHeader and provider-aware setup

**Owner (target):** `apps/web/src/components/features/shell/TaskHeader.tsx` (canonical `TaskHeader`) and `apps/web/src/components/features/providers/TaskSetup.tsx` (canonical `TaskSetup`), plus `ProviderIdentity`/`CapabilityDisclosure` helpers. Legacy anchors: `ChatPane` header, `ProjectDetailHeader`, `BranchSwitcher`.

**Maps to:** `component-state-matrix.md` §6 (Task header and provider-aware setup) and §7 (Provider identity and capability disclosure); `surface-inventory.md` `SF-03`, `SF-05`, `SF-17`, `T-header`/`T-setup` copy, `RT-10`.

**Governing reference:** REF-EMPTY, REF-SPARSE (`chatgpt-devhub-sync3-thread-1800x1130.png`) for the 46-high thin header and title truncation; concept `05-provider-setup` (C05) and `01-new-task-empty` (C01) for the compact anchored setup popover (reject C01's oversized overlapping inset per `design-lock.md` §2/§13); `design-lock.md` §5 provider-aware control rules.

**Slice flag:** `taskHeaderSetup` (default false). Flag-off keeps the `ChatPane`/`ProjectDetailHeader` header and legacy setup.

**RED-first testable DoD:**
1. Failing tests first: existing task header shows compact truncating title plus quiet provider identity with NO editable provider control; new-task setup is a compact anchored popover (`New task setup`), never a wizard/hero, exposing only provider-supported fields (`Provider`, `Model`, `Mode`, `Project`, `Folder`, provider-native permission field, `Create task`); the fixed-provider disclosure `Provider is fixed after creation. Fork to another provider to continue there.` is present; Codex uses its real model/reasoning/permission inventory and `Permissions`, Claude uses `Permission mode` (never `Workspace`) and shows `Requested`/`Session reported`/`Response used`/`Model differs from request` only when Claude is selected and divergence exists; unsupported/unproven controls are absent or disabled with a capability reason (never CSS-faked); `Create task` is disabled until auth/project/folder/policy valid and never navigates until a native ID returns; after creation provider is read-only identity text; a permanently visible Claude warning beside a selected Codex task is rejected.
2. Implement using audited `Popover`+`Command`/Combobox, `Select` (short static lists only), `ToggleGroup`, `FieldGroup`, `Button`; mount under `taskHeaderSetup` true.
3. Prove flag-off does not instantiate the new header/setup.
4. Typecheck, build, `git diff --check`.

**Per-slice gate:** screenshots + ≥5 comparison points (header height 46, title truncates before overflow, provider identity is quiet text, setup is an anchored popover not a hero, permission vocabulary is provider-native) + `T-header`/`T-setup` visible-copy diff (identity strings, lock disclosure, exact field labels, `Create task`, Claude diagnostic labels) + keyboard/a11y (popover focus to first row, DOM-order fields, close restores focus to `New task`, no logo tiles) + `F/P/R/S/V`. Fidelity-ledger entry appended.

## Task 4: ThreadWorkspace and ActivityTimeline

**Owner (target):** `apps/web/src/components/features/shell/ThreadWorkspace.tsx` (canonical `ThreadWorkspace`, owning the `TaskTranscript` region) and `apps/web/src/components/features/shell/ActivityTimeline.tsx` (canonical `ActivityTimeline`), adapting existing `MessageView`/`ToolGroup`/`ToolCard`/`LiveBubble`/`TurnFooter` renderers. Legacy anchors: `TranscriptPane` and existing renderer adapters.

**Maps to:** `component-state-matrix.md` §8 (Transcript, items, activity, Plan, tools) — plus the inline request behavior in §10 that renders inside the thread — and the diff/goal strip in §9; `surface-inventory.md` `SF-06`, `SF-07`, `SF-09`, `SF-10` (inline requests), `SF-04` (empty task), preserved "Transcript utilities" and "Tool renderers" (§5), `T-thread`/`T-empty`/`T-active`/`T-intervention` copy.

**Governing reference:** REF-RICH (dense completed transcript, unframed assistant prose, `#242424` user bubble max ~566), REF-SPARSE (interrupted spacing, negative space), REF-ACTIVE (`chatgpt-active-goal-1800x1130.png`: inline commentary/tool rows, quiet spinner, `#262626` diff pill, narrow goal card), REF-EMPTY (blank canvas, no hero); concept `02-active-plan-tools` (C02) for inline plan/activity; `03-intervention-states` corrected (C03) for inline capability-gated requests.

**Slice flag:** `threadWorkspace` (default false). Flag-off keeps `TranscriptPane` and current renderers.

**RED-first testable DoD:**
1. Failing tests first: assistant prose/tables/lists/code/reasoning-disclosure/ordinary tool rows are UNFRAMED; user content uses compact right-aligned `#242424` bubbles on the 736 column; the empty existing task renders a blank central canvas with ZERO children/SVG/suggestions/hero (hard visual failure otherwise) while the composer/inspector still render; active work stays in the same vertical narrative (no separate progress dashboard); Plan rows expose pending(empty glyph)/running(quiet spinner + `aria-current="step"`)/complete(check)/failed(error) and omitted/unknown provider plan events are not synthesized from prose; streaming appends native deltas to one anchored in-progress region with a stable composer and one polite coarse live region (never per-token, `Working for [elapsed]` from acknowledged elapsed work not a fabricated estimate); replayed events are idempotent on provider/native IDs; unknown native events render as bounded raw diagnostics, never fabricated tools or hidden reasoning; inline requests sit at transcript/composer width on `#262626` (never modal), do not steal typing focus, offer only provider-proved actions (no `Always allow`), timeout shows `Request expired — no action taken`, cancellation is the independent terminal `Cancelled by you`; disconnect freezes the streaming item awaiting reconciliation and keeps partial deltas/scroll; the diff summary pill and goal strip are compact bottom-local and hidden when their source is absent; virtualization renders bounded nodes for a long transcript and is NOT wrapped in `ScrollArea`.
2. Implement `ThreadWorkspace`/`ActivityTimeline` reusing existing renderer adapters, native virtualized scroll, and audited `Collapsible`/`Progress`/`Spinner`/`Badge`/`Alert`; mount under `threadWorkspace` true.
3. Prove flag-off does not instantiate the new workspace.
4. Typecheck, build, `git diff --check`.

**Per-slice gate:** screenshots + ≥5 comparison points (unframed assistant prose, user bubble `#242424`/max 566, empty canvas has no hero, diff pill `#262626`, goal card geometry) + `T-thread`/`T-empty`/`T-active`/`T-intervention` visible-copy diff (retained utility labels, empty-filter copy, activity examples, terminal request states) + keyboard/a11y (Cmd/Ctrl+F, bookmark/error shortcuts, virtualization keeps focused node, inline request does not steal focus, one polite live region) + `F/P/R/S/V`. Fidelity-ledger entry appended. (Note: inline permission/input request FUNCTIONAL execution stays capability-gated behind M3/M4 flags which remain false; M6 proves the honest disabled/absent presentation and the expiry/cancellation copy contract.)

## Task 5: Stable Composer

**Owner (target):** `apps/web/src/components/features/shell/Composer.tsx` (canonical `Composer`). Legacy anchors: the `ChatPane` composer, `MentionPicker`, `SnippetLibrary`, `useDraft`, `usePromptHistory`. IMPORTANT: extract into the new owner; do NOT edit the user-owned `ChatPane.tsx` or `SlashPalette.tsx` — the new `Composer` reimplements the slash/mention behavior against the existing hooks/registries.

**Maps to:** `component-state-matrix.md` §9 (Composer); `surface-inventory.md` `SF-08`, `T-composer`/`L-chat` copy, preserved keyboard contract.

**Governing reference:** REF-EMPTY (resting 736x98 composer, 16 bottom gutter, disabled send arrow), REF-ACTIVE (send→stop swap without layout shift, footer model/mode/permission context); `design-lock.md` §6 composer rules and §4 "composer does not move when send becomes stop."

**Slice flag:** `composerSurface` (default false). Flag-off keeps the `ChatPane` composer.

**RED-first testable DoD:**
1. Failing tests first: measured 736x98 with 16 bottom gutter and stable provider/mode/permission footer; existing-task provider identity is fixed; new-task placeholder is `Describe the outcome or change…`; textarea has an explicit accessible label (not placeholder-only); draft is task/provider scoped and survives navigation/reload; Enter sends, Shift+Enter newline, boundary Up/Down history only while idle, mention/slash/snippet pickers preserve textarea ownership with arrows/Enter/Tab/Escape; send disables for empty draft, blocking request, missing writer lease, disconnected/stale revision, unsupported send, or pending creation, with an accessible disabled reason; geometry is unchanged when send becomes a verified Stop in the same slot (Stop shown only when a native interrupt is product-enabled — gated false for Claude until M4, so the slice proves the honest gated state); draft is never cleared until send is accepted and native turn identity is secured; disconnect keeps the textarea/draft editable and freezes mutation with `Reconnect to send. Your draft is saved.`; permission/mode values are provider-native strings never cross-mapped by equality; credentials and an unsandboxed shell fallback are never exposed.
2. Implement using audited `InputGroup`/`InputGroupTextarea`/`InputGroupAddon`, `Button`, `Popover`/`Command`, `ToggleGroup`, `Tooltip`, reusing `useDraft`/`usePromptHistory`; mount under `composerSurface` true.
3. Prove flag-off does not instantiate the new composer and the user-owned files are untouched.
4. Typecheck, build, `git diff --check`.

**Per-slice gate:** screenshots + ≥5 comparison points (composer 736x98, bottom gutter 16, footer context present, send→stop no layout shift, `#2d2d2d` surface) + `T-composer`/`L-chat` visible-copy diff (placeholder, disabled reasons, `Stop current turn`, reconnect copy) + keyboard/a11y (Enter/Shift+Enter, picker ownership, focus-within ring without geometry change) + `F/P/R/S/V`. Fidelity-ledger entry appended.

## Task 6: InspectorDock

**Owner (target):** `apps/web/src/components/features/inspectors/InspectorDock.tsx` (canonical `InspectorDock`) with the persistent non-tab `Environment` summary plus the five destinations, and per-destination `DiffInspector`/`FilesInspector`/`TerminalInspector`/`BrowserInspector`/`ArtifactsInspector`. Legacy anchors: `DiffView`, `FileChangeSummary`, `GitPanel`, `WorktreePanel`, repository APIs.

**Maps to:** `component-state-matrix.md` §11 (Inspector dock); `surface-inventory.md` `SF-11`..`SF-16`, `SF-17`, `T-inspectors` copy, preserved "Repository/Git/worktree/editor" (§5), `design-lock.md` §8.

**Governing reference:** REF-RICH and REF-ACTIVE for the one 300-wide, content-height, rounded `#2d2d2d` surface with 12 top / 16 right gutter (199 sparse / 282 completed / 396 active heights); concept `04-inspector-dock` (C04) and its brief for the five destinations (reject generated tab/copy inconsistencies).

**Slice flag:** `inspectorDock` (default false). Flag-off keeps the existing diff/file/git panels.

**RED-first testable DoD:**
1. Failing tests first: one measured 300-wide content-height rounded dock with 16 padding (NOT a full-height IDE split pane); a persistent compact `Environment` summary region owning only backed environment/repository/subagent/source rows and NOT a sixth tab; exactly five selectable destinations `Diff`, `Files`, `Terminal`, `Browser`, `Artifacts` with footer `Availability follows the task runtime`; a `role="tablist"` with roving Left/Right/Home/End focus, Tab enters the selected `tabpanel`, and exactly one destination renders below the unchanged Environment summary; each gated destination shows `Not available for this task` (with cause when useful) and empty Artifacts shows `No artifacts` (distinct from unsupported); Terminal is provider-emitted output only and never presents an automatic unsandboxed input fallback (never auto-invokes `thread/shellCommand`); Browser updates only from a real browser runtime; disconnected panels read cached/stale with `Showing cached data — reconnect to refresh.`; destructive discard/unstage/worktree deletion uses explicit repository-utility confirmation, never inside a tab; narrow/PWA uses a titled `Sheet` or an explicit `Desktop required for terminal and diff` disclosure.
2. Implement using a custom content-height dock plus audited `Tabs`/`Collapsible`/`Separator`/`Empty`/`Alert`/`Tooltip` (dock is NOT shadcn `Sheet` on desktop; `ScrollArea` only inside a bounded diff); mount under `inspectorDock` true.
3. Prove flag-off does not instantiate the dock.
4. Typecheck, build, `git diff --check`.

**Per-slice gate:** screenshots + ≥5 comparison points (dock width 300, content-height not full-height, `Environment` is a summary not a tab, five tabs exactly, `#2d2d2d` surface + ~16 radius) + `T-inspectors` visible-copy diff (tab names, `Not available for this task`, `No artifacts`, footer) + keyboard/a11y (tablist roving focus, tabpanel labelled by tab, focus returns to trigger on close) + `F/P/S/V`. Fidelity-ledger entry appended.

## Task 7: Search and command palette

**Owner (target):** `apps/web/src/components/features/search/TaskSearchDialog.tsx` (canonical `TaskSearchDialog`) and `apps/web/src/components/features/commands/CommandDialog.tsx` (canonical `CommandDialog`) as two separate contracts. Legacy anchors: `SearchPalette.tsx`, the currently-unmounted `CommandPalette.tsx`, `ProjectSwitcher`, `FindBar`, `ShortcutOverlay`.

**Maps to:** `component-state-matrix.md` §12 (Search and Commands); `surface-inventory.md` `SF-18`, `SF-19`, §7 (Search and Commands are separate contracts), `T-search`/`T-commands` copy, `RT-02` transcript navigation.

**Governing reference:** `devhub-current-search-results.png` (REF-SEARCH) as the preservation authority for the populated results contract (this is a preservation reference, NOT a Codex visual reference); concept `08-command-responsive` (C08) for the separate command palette and responsive behavior; `design-lock.md` §8.

**Slice flag:** `searchCommands` (default false). Flag-off keeps `SearchPalette` (and Commands stays unmounted exactly as today).

**RED-first testable DoD:**
1. Failing tests first: Search is a dedicated `Search tasks and messages` dialog with a focused query, Global/current-project scope, date facets, result count/status, and title/project/highlighted-snippet rows; opening a result navigates to the correct provider-locked native task/message with the result provider derived from the composite task key (never inferred from model text); Search must NOT collapse to `No results` on error (distinct in-dialog error state retaining query/facets); Commands is a SEPARATE `Search commands and tasks` palette whose actions include `New task`, `Search tasks`, `Toggle inspector`, `Open Settings`, `Go to Ops`, and where `Search tasks` closes Commands then opens Search (never merged, never a command that silently invokes another provider); keyboard-active row is distinct from scope/date selection; Escape closes and restores the invoker; footer `↑↓ navigate`, `↵ open`/`↵ run`, `esc close`; degraded history results carry `Read-only fallback` and raw OpenAI sessions are never labeled Codex.
2. Implement using audited `Command` inside a titled `Dialog` (one per surface), `ToggleGroup` for scope/date, `Skeleton`/`Empty`/`Alert`; mount both under `searchCommands` true.
3. Prove flag-off does not instantiate the new dialogs (and Commands stays unmounted).
4. Typecheck, build, `git diff --check`.

**Per-slice gate:** screenshots + ≥5 comparison points (Search is a distinct results surface, scope + date facets present, highlighted snippet rows, Commands is separate, `Search tasks` transitions to Search) + `T-search`/`T-commands` visible-copy diff (dialog titles, footer, action labels) + keyboard/a11y (query focus on open, activedescendant/roving, result count announced, focus restored) + `F/P/V`. Fidelity-ledger entry appended.

## Task 8: Settings and secondary utilities

**Owner (target):** `apps/web/src/components/features/settings/SettingsRoute.tsx` (provider-aware Settings) plus secondary `features/ops`, `features/inbox`, `features/analytics` route compositions under clean secondary navigation. Legacy anchors: `SettingsPane` + `components/config/*`, `LiveOpsBoard`, `InboxPane`, `DashboardPane`.

**Maps to:** `component-state-matrix.md` §13 (Settings and secondary utilities); `surface-inventory.md` `RT-01`/`RT-04`/`RT-05`/`RT-06`/`RT-07`, `SF-20` (feedback layer), preserved "Archive/export/import/index maintenance" and "Desktop/TUI" (§5), `L-settings`/`L-ops`/`L-inbox`/`L-dashboard`/`L-home` copy.

**Governing reference:** concept `08-command-responsive` (C08) and `design-lock.md` §8 (accessible field groups: `Appearance`, `Providers`, `Permissions`); there is no first-party Codex settings capture, so Settings uses the measured shell language plus documented capability semantics (manifest "Unavailable or conditional reference states") and preserves current DevHub configuration copy until each surface's cutover gate passes.

**Slice flag:** `settingsSecondary` (default false). Flag-off keeps `SettingsPane`/`LiveOpsBoard`/`InboxPane`/`DashboardPane`.

**RED-first testable DoD:**
1. Failing tests first: Settings uses accessible field groups (`Appearance`, `Providers`, `Permissions`, and preserved configuration surfaces) with ALL current preferences/budgets/memory/MCP/hooks/webhooks/agents/skills/plugins/integrity/index/archive workflows still reachable and old key/env/schema readers preserved; Ops/Inbox/Dashboard/analytics remain reachable SECONDARY destinations (never task-home cards, never dashboard grid/KPI in the task canvas); provider-specific fields are explicitly grouped/labeled and never imply cross-provider equivalence; unsupported provider settings are absent or read-only with reason (Claude archive labeled local additive metadata; Codex experimental features are not stable toggles); a browser-local save is labeled local (`Saved in this browser` vs `Not synced`), and cache/database deletion never calls a provider delete; reindex/repair/export/import/webhook-delete/permission changes state affected store/provider and reversibility with focus starting on `Cancel` and no credentials in summaries; narrow uses slim/sheet navigation, one field-group column, no horizontal overflow.
2. Implement using audited `Tabs`/`FieldGroup`/`Field`/`FieldSet`/`Select`/`Input`/`Switch`/`Button`/`Alert`/`Progress`/`Table`/`Dialog` (no generic form cards); route Ops/Inbox/Dashboard under secondary navigation; mount under `settingsSecondary` true.
3. Prove flag-off does not instantiate the new routes.
4. Typecheck, build, `git diff --check`.

**Per-slice gate:** screenshots + ≥5 comparison points (field groups not cards, secondary nav placement, provider grouping explicit, local-vs-synced labeling, no dashboard chrome in task canvas) + `L-settings`/`L-ops`/`L-inbox`/`L-dashboard` visible-copy diff (every preserved config string survives, e.g. `Server name`, `Config (JSON)`, `Fire on`, `All projects (full archive)`) + keyboard/a11y (bound labels, section nav, `Open Settings` command, focus on user-initiated route change) + `F/P/S/V`. Fidelity-ledger entry appended.

## Task 9: App.tsx composition reduction, final review, and shell cutover

**Files:** reduce `apps/web/src/App.tsx` to composition/routing only after every extracted surface (Tasks 1–8) is covered; flip `codexStyleShell` requested-default in `packages/engine/src/providers/feature-flags.ts` only after every gate below passes; remove `apps/web/src/components/ui.tsx` only after the `D` gate proves zero imports; update `implementation-plan.md`, `fidelity-ledger.md`, `preservation-matrix.md`, `risk-register.md`, `tasks/todo.md`/`tasks/STATUS.md`, and add `evidence/m6/` artifacts.

**Required pre-cutover gates:**
1. Every slice flag (`shellChrome`, `taskRail`, `taskHeaderSetup`, `threadWorkspace`, `composerSurface`, `inspectorDock`, `searchCommands`, `settingsSecondary`) has passed its `F/P/R/S/V` gate with a written fidelity-ledger entry and evidence under `evidence/m6/<slice>/`.
2. Preservation gate: every `surface-inventory.md` §5 preserved surface and every legacy route `RT-01..RT-09` is still reachable; the `preservation-matrix.md` rows for each deleted legacy owner are green (`F/P/R/S/V/D`); a `D` scan proves zero imports of each deleted legacy component and zero imports of `ui.tsx` before removing it.
3. Induced-failure / behavior drills pass at ≤2 workers: flag rollback (explicit stored false on any slice flag instantly restores its legacy owner with no schema/data change and no hidden duplicate tabbable control), provider-failure isolation, disconnect-before-send reconciliation, long-transcript virtualization + focus retention, empty-task-has-no-hero, timeout-never-Allow, Search/Commands separation and `Search tasks` focus transfer, and reduced-motion/forced-colors distinctness across rest→loading/streaming→success/error/reconnect/interruption/reversal.
4. Fresh independent specification review finds no missing M6 requirement (every `design-lock.md` §2 row and §3–§13 rule maps to a landed, gated surface).
5. Fresh independent design/quality/security review finds no open P1/P2 and no unaccepted P3; `git diff --check`, targeted secret scan, and the four user-owned preservation-path hash check pass before changing the default.

**Cutover:**
- Set `DEFAULT_DEVHUB_FEATURE_FLAGS.codexStyleShell` to true (requested default) and make the server report it available/applied only when the full `DevHubShell` tree mounts without falling back; preserve an explicit stored false as the immediate rollback switch; rerun the focused flag/routing/rollback tests, then create the dedicated cutover commit.
- On the exact enabled commit, run fresh full web (and any affected engine/server) tests, typechecks, and `vite build` with forced cache bypass; capture Browser/IAB current/minimum/narrow QA plus keyboard/a11y traces under `evidence/m6/`; any failure gets a repair commit and the exact-tip gate repeats.
- Run the final independent exact-tip review plus secret scan, generated-file check, `git diff --check`, clean owned-path status, and preservation hash/status check. Keep `nativeCodex=false`/`persistentClaude=false` and document their unchanged live-proof blockers. Do not merge to `origin/main` (held [RONAK-GATE]).

## Commit and review sequence

1. `chore(web): audited shadcn custom preset + semantic token migration` — brownfield init; config/CSS only, `ui.tsx` facade retained.
2. `feat(web): extract DevHubShell behind shellChrome flag` — Task 1 focused tests/typecheck/build + fidelity entry pass.
3. `feat(web): extract TaskRail behind taskRail flag` — Task 2 gate pass.
4. `feat(web): extract TaskHeader + TaskSetup behind taskHeaderSetup flag` — Task 3 gate pass.
5. `feat(web): extract ThreadWorkspace + ActivityTimeline behind threadWorkspace flag` — Task 4 gate pass.
6. `feat(web): extract stable Composer behind composerSurface flag` — Task 5 gate pass (user-owned files untouched).
7. `feat(web): extract InspectorDock behind inspectorDock flag` — Task 6 gate pass.
8. `feat(web): extract Search + Commands behind searchCommands flag` — Task 7 gate pass.
9. `feat(web): extract Settings + secondary routes behind settingsSecondary flag` — Task 8 gate pass.
10. `feat(web): reduce App.tsx to composition and enable codexStyleShell` — Task 9 full-milestone gates/evidence/review pass; `ui.tsx` removed only after `D`.

Every commit must exclude `.gitignore`, `apps/web/src/components/ChatPane.tsx`, `apps/web/src/components/SlashPalette.tsx`, and `AGENTS.md`; verify the staged path list before committing. Do not push until the exact branch tip passes its own slice gates, and do not merge to `origin/main`.
