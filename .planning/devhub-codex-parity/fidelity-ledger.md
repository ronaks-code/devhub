# DevHub fidelity ledger

This ledger records implemented evidence against the approved source hierarchy. A functional M3 result inside the preserved shell is not relabeled as final M6 visual parity.

## M3 - native Codex vertical slice

Date: 2026-07-13

Governing sources:

1. installed ChatGPT/Codex build `26.707.51957 (5175)` captures in `reference-captures/`;
2. approved concepts `02-active-plan-tools.png`, `03-intervention-states.png`, `07-new-task-provider.png`, and `08-command-responsive.png` with their production briefs;
3. `design-lock.md`, `design-system.md`, `component-state-matrix.md`, and `surface-inventory.md`;
4. existing DevHub shell only where M3 intentionally precedes the M6 strangler cutover.

| Comparison | Governing reference | M3 implementation evidence | Finding / disposition |
| --- | --- | --- | --- |
| Empty existing task | `surface-inventory.md` `T-empty`: no central copy, illustration, suggestions, or card | `browser-narrow-empty-task-after-fix.png`; transcript region has zero children, no SVG, exact `Ask for follow-up changes` placeholder | Match after test-first repair. |
| User/assistant transcript | Current-build active-task capture and concept 2 | `browser-wide-active.png`: user content is right-aligned; assistant work remains inline with plan/activity | Functional partial match. M3 retains a small assistant icon; final prose treatment belongs to M6. |
| Plan and activity | Concept 2 plus `T-active` | `browser-wide-active.png`: three truthful plan rows, shell activity, diff summary, usage, and turn state are native timeline entries | Functional match. Final `Working for`/`Goal` composition is deferred to M6. |
| Intervention placement | Concept 3 plus `T-intervention` | `browser-wide-archive-dialog.png`, `browser-narrow-input-request-guard.png`, and `browser-narrow-intervention-cancelled.png` | Inline requests and destructive dialog behavior pass. The approval card is visually larger than the approved compact specimen; M6 must reduce it. |
| Capability honesty | `component-state-matrix.md` unavailable/disabled states | `browser-narrow-unsupported.png`: mutation controls disappear, approval actions are absent, and the task says it is read-only for the verified capability set | Match. No schema-only control is advertised as working. |
| Failure and recovery | `T-intervention`: safe retry, reconnect, check status, expiry/cancel independence | `browser-narrow-disconnected.png`, `browser-narrow-reconnecting.png`, `browser-narrow-recovered.png` | Fail-closed mutation uncertainty, authoritative refresh, explicit review, verified-policy resume, and recovery pass synthetically. Expiry-specific visible copy remains an M6/provider-event contract gap. |
| Archive confirmation | Current-build destructive interaction language plus state matrix | `browser-wide-archive-dialog.png`; Browser log records modal role, inert background, scroll lock, focus trap, Escape, and focus restoration | Behavioral match. Final radius/color/token parity is deferred to M6. |
| Wide shell geometry | Current build: one 273px task rail and open task canvas | M3 preserves DevHub's 44px top bar, 176px global rail, and 288px native rail | Intentional M3 mismatch. The approved M6 shell cutover must remove the extra permanent rail and adopt measured geometry. |
| Minimum desktop width | Concept 8 plus responsive rules | `browser-narrow-after-fix.png`: at 768x720, document/header client and scroll widths are all 768px | Functional pass after hiding secondary top-bar utilities below `lg`. M6 still replaces two permanent rails with the approved narrow sheet/one-pane behavior. |
| Long transcript | Performance risk R-26 | `browser-narrow-long-transcript.png`; 600 history messages render only 17 nodes at 768px and 29 nodes at 1800px | Functional/performance pass for virtualization; final scroll anchoring and packaged profiling remain M8 gates. |
| Theme and motion | Design-system accessibility rules | `browser-wide-light-theme.png`; Browser log records computed light body colors and forced reduced-motion root state | Functional pass. Current-build visual reference remains dark; light is a DevHub supported-theme check, not a claimed first-party match. |
| Palette and typography | Current-build measured canvas/surface tokens | M3 remains on zinc compatibility classes | Intentional M3 mismatch. Semantic token migration is explicitly M6 work and may not be claimed complete here. |

## M3 judgment

The vertical slice is functionally faithful enough to remain behind its feature flag in the existing UI: native identity, history, streaming, controls, failure states, and accessibility behavior are honest. Final shell geometry, semantic tokens, compact request styling, responsive rail replacement, and expiry-specific presentation are not M3 claims and remain open for M6/M8.

## M4 - persistent Claude vertical slice

Date: 2026-07-13

Governing sources: installed Codex shell captures for layout, concepts `02-active-plan-tools.png` and `05-provider-setup.png` for task/setup semantics, the four approved design artifacts for copy and capability truth, and the existing shell only because M4 intentionally precedes M6.

| Comparison | M4 evidence | Finding / disposition |
| --- | --- | --- |
| Provider identity | `browser-wide-active-claude.png`, `computer-use-chrome-devhub.jpg` | Quiet text `Anthropic · Claude` is visible in rail/header and accessibility context; no provider logo or first-party imitation. Match. |
| Active plan/activity | `browser-wide-active-claude.png` vs concept 2 | Three plan states, shell activity, diff, usage, turn state, and stable composer are inline and truthful. Functional match; final goal strip/inspector composition remains M6. |
| Capability honesty | Active capture plus `official-control-contract.md` | Unsupported command approval has no executable action and says the interaction is not enabled. Match; compact visual styling remains M6. |
| Provider setup | `browser-wide-create-exact-copy.png`, `browser-narrow-create-exact-copy.png`, `browser-narrow-create-ready-exact-copy.png` vs concept 5 | Fixed provider, disabled model selection, Claude permission mode, cwd, required first message, and disabled-to-enabled creation are directly recaptured. Match. |
| Permission vocabulary | Browser/IAB plus `computer-use-exact-copy-trace.md` | Live options/selected states prove exact safe installed terms `Manual`, `Accept edits`, `Plan`; no Codex `Workspace` appears. Match. |
| Model disclosure | Browser/IAB plus Computer Use exact-copy captures | Exact allowed capability copy replaces an overlong implementation sentence. Match; divergence detail remains available from runtime diagnostics, not a fake picker. |
| Provider-lock disclosure | Browser/IAB plus Computer Use exact-copy captures | Exact approved sentence states that continuation elsewhere requires a fork. Match. |
| Terminal task status | `browser-narrow-completed-after-fix.jpg` | Browser found stale `active`; a failing test preceded the repair, and a second turn leaves the selected row `idle`. Match after repair. |
| Responsive geometry | Final wide/narrow exact-copy captures | Body/document/client widths are exactly `1280` and `768` with no horizontal overflow. Functional pass; the extra permanent rails remain an intentional pre-M6 mismatch. |
| Computer Use | `computer-use-exact-copy-trace.md`, fresh `computer-use-chrome-*.png`, `computer-use.md` | Chrome/DevHub setup/create/complete/idle/interrupt workflow passes; first-party Codex control is host-blocked and is not relabeled. Honest partial. |
| Palette/typography/shell | All captures | M4 remains in the zinc compatibility shell rather than the measured single-rail semantic-token target. Intentional mismatch owned by M6. |

### M4 judgment

The existing-UI Anthropic slice is functionally and semantically coherent under deterministic fixtures. Exact-copy, task-status, responsive Browser/IAB, and Computer Use gates now pass with fresh evidence. The raw selected-runtime lifecycle artifact is still missing, so the feature flag remains false and M4 is not complete.

## M6 - approved Codex-style shell

M6 records the strangler-slice extraction of the measured Codex-style shell. Each slice
appends its own dated sub-table below. Per the ledger preamble, no M6 row relabels an
M3/M4 functional result as new visual parity; M6 rows report measured geometry and
token/copy fidelity of the newly extracted surface only.

### Task 1 - DevHubShell + application chrome (`shellChrome`)

Date: 2026-07-15

Governing sources: `reference-captures/chatgpt-empty-task-1800x1130.png` (REF-EMPTY) and
`chatgpt-current-1800x1130.png` (REF-RICH) for the measured 273/46/`#181818`/16-gutter
frame; `design-lock.md` §4 container/geometry model; `reference-capture-manifest.md`
"Measured wide-shell geometry"; `design-system.md` §2–§4 tokens. Evidence:
`evidence/m6/shell/` (`qa-note.md`, `fixture.html`, wide/narrow/PWA screenshots) plus the
unit/snapshot suite `apps/web/src/components/features/shell/{DevHubShell,AppShell}.test.ts`.

| Comparison | Governing reference | M6 implementation evidence | Finding / disposition |
| --- | --- | --- | --- |
| Left rail width | design-lock §4 "Left task rail: 273 units" | `m6-shell-wide-1800x1130.png`; live `getBoundingClientRect` rail width = 273; `SHELL_GEOMETRY.railWidth === 273` asserted | Match. |
| Header height | design-lock §4 "Header: 46 units" | measured header height = 46; `data-dh-height="46"` asserted; header slot never grows | Match. |
| Canvas color / open canvas | design-lock §4 "Main canvas: open `#181818`, without a page card" | measured `getComputedStyle` background = `rgb(24,24,24)` = `#181818`; canvas is a bare `<main>` flex column, no card wrapper | Match. |
| Shared transcript/composer column | design-lock §4 "Transcript and composer share a 736-unit column" | measured transcript column = 736; composer slot max-width = 736; both centered in the stage | Match. |
| Resting composer box | design-lock §4 "Resting composer is 736x98 with a 16-unit bottom gutter and ~21-unit radius" | measured composer 736 wide, 98-high box + 16 padding-bottom, radius 21 (`--dh-radius-composer`) | Match. |
| Inspector dock | design-lock §4 "300-unit, content-height surface with a 12-unit top gutter, 16-unit right gutter, ~16-unit radius; not a full-height split pane" | measured dock 300 wide, lane 316, top gutter 12, right gutter 16, radius 16, `#2d2d2d`, height follows content | Match. |
| Outer shell gutters | design-lock §4 / manifest "16 gutter" | `--dh-shell-gutter: 16px` drives header/inspector padding + composer bottom gutter; no horizontal shell overflow at any tier (doc width == viewport) | Match. |
| Brand wordmark | design-lock §3 / invariant 9 "brand is always `DevHub`" | rendered wordmark is exactly `DevHub`; test forbids provider wordmarks in the brand slot | Match. Intentional deviation from the capture's `Codex` wordmark. |
| Token-only geometry | design-system §2–§4 "use CSS variables, not raw values in feature components" | shell markup carries no `273px`/`#181818` style literals; all geometry reads `var(--dh-*)`; test asserts no hex/px leak | Match. |
| Landmarks + skip link | design-system §10.3 "one main, named navigation, skip link" | exactly one `<main>`, one named rail `<nav>`, one skip link, optional named `complementary` inspector; asserted by count | Match. |
| Geometry invariant across status | design-lock §4 "composer does not move when send becomes stop or activity appends" | rest/loading/streaming render byte-identical geometry markup (only `aria-busy` differs); asserted | Match. |
| Responsive / no hidden duplicate | design-lock §10 / design-system §8 "one-pane drill-down below 1024, no horizontal overflow" | 768: one rail collapses to 48 icon strip in place, inspector hidden, 1 nav/1 main/1 skip, no overflow; 390: rail `display:none` (not tabbable), header 44, no overflow | Match (proposed narrow/PWA behavior, QA-gated). |

### Task 1 judgment

The DevHubShell frame reproduces the locked wide-reference geometry to the measured unit
(rail 273, header 46, canvas `#181818`, 736 column, 300 content-height dock with 12/16
gutters, 16 outer gutter) using `design-system.md` tokens only, with correct DevHub brand
and shell landmarks. It ships behind the default-off `shellChrome` flag; flag-off renders
the legacy `App.tsx`/`ResponsiveShell` chrome byte-for-byte (proven by `AppShell.test.ts`).
Rail rows, header title/actions, transcript renderers, composer controls, and inspector
destinations remain placeholder slots owned by M6 Tasks 2–8; this task claims frame
geometry, tokens, landmarks, and flag safety only, not final content fidelity.

### Task 2 - TaskRail open list (`taskRail`)

Date: 2026-07-15

Governing sources: REF-EMPTY / REF-ACTIVE / REF-RICH for rail grouping and the open-list
hierarchy; `design-lock.md` §4 "Rail hierarchy is an open list"; `reference-capture-manifest.md`
"256x30 selected row at 8 inset"; `design-system.md` §2–§4 tokens; `component-state-matrix.md`
§5 (rail and task rows); `surface-inventory.md` `SF-02` / `T-rail`. Evidence:
`evidence/m6/taskrail/` (`qa-note.md`, `fixture.html`, `fixture-empty.html`,
`m6-taskrail-wide.png`, `m6-taskrail-empty.png`) plus the unit/snapshot suite
`apps/web/src/components/features/shell/TaskRail.test.ts`.

| Comparison | Governing reference | M6 implementation evidence | Finding / disposition |
| --- | --- | --- | --- |
| Open list, not nested cards | design-lock §4 "Rail hierarchy is an open list" | rail is a `role="list"` of flat `data-dh-task-row` list items grouped under quiet headings; no card container chrome; test asserts open-list semantics | Match. |
| Selected row 256x30 | manifest "256x30 selected row" | measured selected row width 256, height 30 via `getBoundingClientRect`; driven by `--dh-selected-row-width/height` | Match. |
| Rail inset 8 | manifest "…at 8 inset" | measured 8-unit inset from the rail-content left edge; `--dh-rail-inset` | Match. |
| Selected fill `#313131` | design-system §2.1 `--dh-selected` | measured `getComputedStyle` background `rgb(49,49,49)` = `#313131`, radius 9px | Match. |
| Provider identity is quiet text, never a logo | design-lock §3 / invariant 1 | quiet visible suffix `Codex`/`Claude` + full `OpenAI · Codex` / `Anthropic · Claude` in the accessible name; 0 `svg`/`img` in the rail | Match. |
| Height invariant under active spinner | component-state-matrix §5 (`selected`/active) | selected+active row height stays 30 with the quiet spinner present; asserted | Match. |
| Roving focus distinct from selection | design-lock §10 / a11y gate | exactly one open-button `tabIndex 0`; `nextRovingIndex` covers Arrow/J/K/Home/End; overflow `Actions for {task}` are independently `tabIndex 0` and reachable without hover | Match. |
| Secondary destinations reachable-only, never inert | surface-inventory `RT-01/RT-02` | unreachable destinations are absent (never rendered `disabled`/`aria-disabled`); current destination carries `aria-current` | Match. |
| Failure isolation | design-lock §4 (provider-failure isolation) | `failedProvider` marks only that provider's rows; the other provider's rows carry no failure marker; asserted both directions | Match. |
| No raw-home / NUL in keys | invariant / preservation | `sanitizeRailKey` strips NUL/control chars and path separators; rendered markup carries no NUL and no `/Users/` or `.codex/sessions` path | Match. |
| Rail copy (`T-rail`) | surface-inventory `T-rail` | `New task`, `No tasks`, provider suffixes present; no unapproved generated rail strings | Match. |
| Brand wordmark | invariant 9 | brand stays `DevHub`; no provider wordmark in the rail | Match. |

### Task 2 judgment

`TaskRail` renders the rail as a Codex-style open list — flat task rows grouped under
quiet headings, a measured 256x30 selected fill at an 8-unit inset (`#313131`, 9px
radius), quiet provider identity (visible `Codex`/`Claude` suffix + full `OpenAI · Codex`
/ `Anthropic · Claude` accessible name, never a logo), height-invariant active spinner,
roving focus distinct from selection, hover-free overflow actions, single-provider
failure isolation, and NUL/raw-home-safe keys. It ships behind the default-off `taskRail`
flag; flag-off keeps the legacy rail and never instantiates `TaskRail` (the App model is
built only in the devhub branch). The App-side model currently supplies the reachable
primary tabs as secondary destinations with an empty task list (`No tasks`); populating
live native task rows with their immutable provider identity is a later data-wire, not in
this unit.

### Task 3 - TaskHeader + provider-aware setup (`taskHeaderSetup`)

Date: 2026-07-15

Governing sources: REF-EMPTY / REF-SPARSE for the 46-high thin header and title
truncation; concepts `05-provider-setup` (C05) and `01-new-task-empty` (C01) for the
compact anchored setup (rejecting C01's oversized overlapping inset per `design-lock.md`
§2/§13); `design-lock.md` §3 (identity/provider ownership) and §5 (task setup and
provider-aware control rules); `design-system.md` §2–§4 tokens; `component-state-matrix.md`
§6 (task header + provider-aware setup) and §7 (provider identity + capability
disclosure); `surface-inventory.md` `SF-03`/`SF-05`/`SF-17`, `T-header`/`T-setup`.
Evidence: `evidence/m6/taskheader/` (`qa-note.md`, `fixture.html`,
`m6-taskheader-wide.png`) plus the unit/snapshot suites
`apps/web/src/components/features/providers/TaskSetup.test.ts` and
`apps/web/src/components/features/shell/TaskHeader.test.ts`.

| Comparison | Governing reference | M6 implementation evidence | Finding / disposition |
| --- | --- | --- | --- |
| Header height 46 | design-lock §4 / manifest | measured 47 = 46 content + 1px bottom border; driven by `--dh-header-height` | Match. |
| Title truncates before overflow | design-lock §5 / REF-SPARSE | `getComputedStyle` `text-overflow: ellipsis`, `white-space: nowrap`, `overflow: hidden`; full title in `title=` | Match. |
| Provider identity is quiet read-only text | design-lock §3 / invariant 1 | `<span data-dh-provider-identity>` `OpenAI · Codex` / `Anthropic · Claude`; no control | Match. |
| Provider immutable after creation (no in-task picker) | design-lock §3 / invariant 1 | 0 `<select>` and 0 `data-dh-provider-picker` in the header; change is only `Create cross-provider fork` (source unchanged) | Match. |
| Setup exposes only capability-supported fields | design-lock §5 | Codex shows Provider/Model/Reasoning/Mode/Project/Folder/Permissions; Claude shows the same minus Reasoning; absent fields have no faked control | Match. |
| Reasoning is Codex-only | design-lock §5 (Codex real reasoning inventory) | reasoning field present for Codex, ABSENT for Claude (asserted both) | Match. |
| Provider-native permission label | design-lock §5 (not interchangeable) | Codex `Permissions`, Claude `Permission mode`; Claude never renders `Workspace` | Match. |
| Unproven control is disabled WITH a reason, never CSS-faked | design-lock §5 / invariant 2 | `decideSetupFields` only emits `disabled` together with a non-empty `reason`; rendered as a real `disabled` control + `data-dh-capability-reason` wired via `aria-describedby` | Match. |
| Fixed-provider disclosure present | design-lock §5 | `Provider is fixed after creation. Fork to another provider to continue there.` in setup + header note | Match. |
| Create task gated until valid | design-lock §5 | `canCreateTask` requires auth+project+folder+policy; disabled Create carries the first-unmet accessible reason (`Choose a project.`) | Match. |
| Claude model divergence copy | design-lock §5 | on divergence: Requested/Session reported/Response used each under its own label + `Model differs from request`; requested is never relabeled as the model that ran | Match. |
| No Claude warning beside a Codex task | design-lock §13 (rejected) | Codex header computes no Claude disclosure even when divergence-shaped data is passed | Match. |
| Provider identity is never a logo | design-lock §3 / invariant 9 | 0 `svg`/`img` in header or setup | Match. |

### Task 3 judgment

`TaskHeader` renders the compact 46-high existing-task header with a truncating title and
QUIET read-only provider identity (`OpenAI · Codex` / `Anthropic · Claude`) and NO in-task
provider control — provider is immutable after creation and the only change is
`Create cross-provider fork`. `TaskSetup` is a compact anchored new-task panel (not a
wizard/hero) that exposes ONLY the fields the selected provider/version proves it
supports: Codex uses its real model/reasoning/permission inventory with the `Permissions`
label; Claude drops reasoning and uses `Permission mode` (never `Workspace`); a
schema-named-but-unproven control renders as an explicitly disabled field with its exact
capability reason (never a greyed style alone). `Create task` stays disabled with the
first-unmet accessible reason until auth/project/folder/policy are valid. For a Claude
task only, when the requested model diverges from the session-reported or response-used
model, the header surfaces all three under their own labels plus `Model differs from
request` and never claims the requested model ran. Ships behind the default-off
`taskHeaderSetup` flag; flag-off keeps the legacy `ChatPane` header/setup
(`resolveTaskHeaderSetupMode` returns `legacy` for false/undefined/missing). Live mounting
into the task canvas is a later data-wire (the per-task canvas header lives in the
user-owned `ChatPane.tsx`, off-limits to this slice), mirroring how Tasks 1–2 left
slots/rows as later data-wires. `nativeCodex`/`persistentClaude`/`taskHeaderSetup`
requested-defaults stay false.

### Task 4 - ThreadWorkspace + ActivityTimeline (`threadWorkspace`)

Date: 2026-07-15

Governing sources: REF-EMPTY / REF-RICH / REF-SPARSE / REF-ACTIVE for the transcript
column, the empty existing-task canvas, and the active/streaming state; concepts C02
(active plan/tools) and C04 (transcript-is-the-task) for the vertical-narrative model;
`design-lock.md` §4 (task canvas / surfaces reserved for requests, user bubbles, compact
controls, composer, inspector — everything else unframed) and §6 (stable composer);
`design-system.md` §2–§4 tokens (`--dh-user-bubble` `#242424`, `--dh-control` `#262626`,
`--dh-surface` `#2d2d2d`, `--dh-user-bubble-max` 566, composer 736x98 / r21 / 16 gutter);
`component-state-matrix.md` §8 (thread workspace + activity timeline); `surface-inventory.md`
`T-thread`/`T-active`/`T-intervention`. Evidence: `evidence/m6/thread/`
(`qa-note.md`, `fixture-{empty,sparse,active,complete}.html`, `m6-thread-wide.png`,
`m6-thread-active-wide.png`) plus the unit/snapshot suites
`apps/web/src/components/features/shell/ThreadWorkspace.test.ts` (21) and
`apps/web/src/components/features/shell/ActivityTimeline.test.ts` (9).

| Comparison | Governing reference | M6 implementation evidence | Finding / disposition |
| --- | --- | --- | --- |
| Assistant prose is UNFRAMED | design-lock §4 / invariant 4 | measured `background: rgba(0,0,0,0)`, `border: none`, `border-radius: 0`; `data-dh-unframed` present on `.dh-thread-assistant` | Match. |
| User bubble fill `#242424`, max ~566 | design-system §2 / manifest | measured `rgb(36,36,36)` = `#242424`, `max-width: 566px` (`data-dh-bubble-max="566"`), right-aligned surface (`justify-content: flex-end`) | Match. |
| Empty existing task is a blank canvas (no hero/SVG/suggestions) | design-lock §4 / REF-EMPTY | `fixture-empty`: transcript `children=0` / `textContent=""`, `0` `<h1..h3>`, `0` `<svg>`, `0` `<img>`, only the composer button | Match. |
| Composer persists on the empty canvas | design-lock §6 | `fixture-empty` composer renders at `height: 98px` with the transcript empty | Match. |
| Inline request pill `#262626`, surfaced, NOT modal | design-lock §5 / invariant 2 | measured `rgb(38,38,38)` = `#262626`, `data-dh-surface` present, `role="group"`, no `role="dialog"` / `aria-modal` | Match. |
| Stable composer geometry (736x98 / r21 / 16 gutter / `#2d2d2d`) | design-lock §4/§6 | measured width `736`, height `98`, radius `21`, `margin-bottom: 16`, fill `rgb(45,45,45)`=`#2d2d2d`; Send↔Stop swaps label only (`data-dh-send-state`) with no geometry shift | Match. |
| Transcript column width 736 | manifest | measured `736px` | Match. |
| Single polite live region | component-state-matrix §8 | exactly one `[data-dh-live-region]` `role="status"` `aria-live="polite"` (streaming carries none of its own) | Match. |
| Raw unknown events bounded + control-stripped | design-lock §4 (never a fabricated tool) | `boundRawDiagnostic` caps at `RAW_DIAGNOSTIC_MAX` 2048 and strips C0/DEL (unit-tested) | Match. |
| No logos anywhere | design-lock §3 / invariant 9 | `0` `<svg>` and `0` `<img>` across all four fixtures | Match. |

### Task 4 judgment

`ThreadWorkspace` renders the transcript-is-the-task canvas: completed and active work
share ONE vertical narrative (assistant/user/activity/request/streaming/raw items), with
surfaces reserved for the user bubble (`#242424`, right-aligned, capped at 566), inline
requests (`#262626`, non-modal, per-turn actions only — `sanitizeRequestActions` drops any
`Always allow`), and the geometry-stable 736x98 composer; everything else (assistant prose,
activity rows, streaming deltas, bounded raw diagnostics) is UNFRAMED. The empty existing
task is a genuinely blank canvas (zero children/SVG/hero/suggestions) while the composer and
a single polite live region still render. `ActivityTimeline` renders the compact
inline plan/activity delegate. Ships behind the default-off `threadWorkspace` flag;
flag-off keeps the legacy `TranscriptPane`/renderers chat (`resolveThreadWorkspaceMode`
returns `legacy` for false/undefined/missing, `isThreadWorkspaceApplied` true only for an
explicit true). SCOPE: this claims the workspace PRESENTATION, surface/unframed
discipline, non-modal request rules, stable-composer geometry, and flag safety only; live
mounting into the task canvas — mapping native events to `ThreadItem[]` — is a deferred
data-wire because the live transcript canvas is owned by the user-owned `ChatPane.tsx`
(off-limits) and `CodexNativePane`, mirroring exactly how Task 3 deferred the header
data-wire. The flag gate + resolver land here; the App composition mount is staged for the
Task 9 `codexStyleShell` cutover integration. `nativeCodex` / `persistentClaude` /
`threadWorkspace` requested-defaults stay false.

### M6 Task 5 - Composer

Date: 2026-07-15

Governing sources: `design-lock.md` §4/§6 (stable composer, provider-native context,
no credential/unsandboxed-shell exposure), REF-EMPTY (resting 736x98 composer, 16 bottom
gutter, disabled send) + REF-ACTIVE (send→stop swap without layout shift, footer
model/mode/permission context), `component-state-matrix.md` §9, `surface-inventory.md`
`SF-08` / `T-composer` / `L-chat`. Evidence: `evidence/m6/composer/` (`qa-note.md`,
`fixture-{resting,active,new,disconnected}.html`, `m6-composer-{resting,active,disconnected}-wide.png`)
plus the unit/snapshot suite `apps/web/src/components/features/shell/Composer.test.ts` (26).

| Comparison | Governing reference | M6 implementation evidence | Finding / disposition |
| --- | --- | --- | --- |
| Composer measured 736x98 | design-lock §4/§6 / manifest | measured width `736`, height `98` across resting/active/disconnected | Match. |
| Bottom gutter 16 | manifest resting composer | measured `margin-bottom: 16px` in every state | Match. |
| Surface fill `#2d2d2d` | design-system §2 / manifest | measured `rgb(45,45,45)` = `#2d2d2d` in every state | Match. |
| Footer context present | design-lock §6 (compact folder/permission/model/mode) | measured footer text `Folder ~/devhub`, `Model claude-sonnet-4`, `Mode default`, `Permission mode plan`; Codex shows `Permissions workspace-write` | Match. |
| Send → Stop, no layout shift | design-lock §4 ("composer does not move when send becomes stop") | the geometry-bearing container tag is byte-identical send↔stop (unit-asserted); measured 736x98 identical live; only the button label/state/`#d95c5c` fill change | Match. |
| Stop honestly gated | design-lock §6 (Stop only for a real native interrupt) | `resolveSendState` returns `stop` only when `turnRunning && nativeInterruptEnabled`; a running Claude turn (no native interrupt) stays `send` | Match. |
| Provider-native permission (never cross-mapped) | design-lock §5/§6 | Claude renders `Permission mode` / `plan`; Codex renders `Permissions` / `workspace-write`; values pass through verbatim; Claude never renders `Workspace` | Match. |
| Accessible label (not placeholder-only) | design-lock a11y | `label[for=dh-composer-textarea]` present with copy `Message`; new-task placeholder `Describe the outcome or change…` | Match. |
| Disabled send carries an accessible reason | component-state-matrix §9 | send `disabled` + `aria-describedby="dh-composer-send-reason"` with distinct reason per blocking condition (empty/blocking-request/missing-writer-lease/disconnected-stale/unsupported/pending-creation) | Match. |
| Disconnect keeps draft editable | design-lock §6 | textarea NOT disabled while disconnected; draft preserved; note `Reconnect to send. Your draft is saved.` shown | Match. |
| No credentials / unsandboxed shell | design-lock §6 | rendered markup contains none of credential/apiKey/sk-/unsandboxed/danger/bypassPermissions (unit-asserted) | Match. |
| No logos anywhere | design-lock §3 / invariant 9 | `0` `<svg>` and `0` `<img>` across all fixtures | Match. |

### Task 5 judgment

`Composer` is the canonical geometry-stable task composer: a measured 736x98 slot on the
`#2d2d2d` surface with a 16 bottom gutter and ~21 radius whose container is byte-identical
across Send↔Stop and every draft/disabled transition (the stable-composer invariant). It
reimplements the legacy `ChatPane` composer against the SAME registries/hooks
(`useDraft`, `usePromptHistory`, `detectMention`, `filterCommands`, snippets) WITHOUT
editing the user-owned `ChatPane.tsx` or `SlashPalette.tsx`; the keyboard contract
(Enter sends, Shift+Enter newline, boundary Up/Down history only while idle, pickers own
Arrow/Enter/Tab/Escape) and every send-disabled reason are pure functions
(`decideComposerKey`, `computeSendDisabledReason`, `resolveSendState`,
`computePickerState`). Stop is honestly gated (only for a real native interrupt, false for
Claude); permission/mode values are provider-native strings never cross-mapped; disconnect
keeps the draft editable with `Reconnect to send. Your draft is saved.`; credentials and an
unsandboxed shell fallback are never exposed. Ships behind the default-off `composerSurface`
flag; flag-off keeps the legacy `ChatPane` composer (`resolveComposerSurfaceMode` returns
`legacy` for false/undefined/missing, `isComposerSurfaceApplied` true only for an explicit
true). SCOPE: this claims the composer PRESENTATION, stable-slot geometry, provider-native
footer, keyboard/disabled-reason logic, and flag safety only; live mounting into the task
canvas is a deferred data-wire (the live host is the user-owned `ChatPane.tsx`), mirroring
Tasks 3–4 and staged for the Task 9 cutover. `nativeCodex` / `persistentClaude` /
`composerSurface` requested-defaults stay false.

### M6 Task 6 - InspectorDock

Date: 2026-07-15

Governing sources: `design-lock.md` §8 (InspectorDock destinations, terminal is
provider-emitted, honest empty/gated/local states), `component-state-matrix.md` §11
(Inspector dock), `surface-inventory.md` `SF-11`..`SF-17` + `T-inspectors` copy,
REF-RICH / REF-ACTIVE (one 300-wide, content-height, rounded `#2d2d2d` surface, 12 top /
16 right gutter, 199 sparse / 282 completed / 396 active heights), concept
`04-inspector-dock` (C04). Evidence: `evidence/m6/inspector/` (`qa-note.md`,
`fixture-{diff,terminal,browser-unavailable,artifacts-empty,disconnected,disclosure}.html`,
`m6-inspector-{diff,terminal,browser-unavailable,disconnected}-wide.png`,
`m6-inspector-disclosure-narrow.png`) plus the unit/snapshot suite
`apps/web/src/components/features/inspectors/InspectorDock.test.ts` (31).

| Comparison | Governing reference | M6 implementation evidence | Finding / disposition |
| --- | --- | --- | --- |
| Dock width 300 | manifest (`x=1484`, width `300`) / SF-11 | measured `300` live; `data-dh-inspector-width="300"` mirrors `SHELL_GEOMETRY.inspectorWidth` | Match. |
| Content-height, NOT full-height IDE pane | design-lock §8 / matrix §11 ("not a permanent full-height IDE pane") | measured `321` in a `900` viewport (content-height); `data-dh-inspector-height-mode="content"`; no full-height rule | Match. |
| `Environment` is a summary, not a tab | design-lock §8 / `T-inspectors` | Environment region renders ABOVE the tablist with `role`-free heading; exactly `5` `role="tab"` nodes; region byte-identical across selections | Match. |
| Exactly five tabs (Diff/Files/Terminal/Browser/Artifacts) | design-lock §8 / `T-inspectors` | measured tab labels `["Diff","Files","Terminal","Browser","Artifacts"]`, `count(role="tab")===5`, one panel rendered | Match. |
| `#2d2d2d` surface + ~16 radius | design-system §2 / manifest | measured `rgb(45,45,45)` = `#2d2d2d`, `border-radius: 16px`, `padding: 16px` | Match. |
| Footer `Availability follows the task runtime` | `T-inspectors` | measured footer text verbatim | Match. |
| Tablist roving + tabpanel entry | matrix §11 focus row (`role=tablist`, Left/Right/Home/End, Tab enters panel) | `role="tablist"` + `aria-orientation="horizontal"`; single roving `tabindex="0"` tab; tabpanel `tabindex="0"` + `aria-labelledby` the selected tab; `nextTabIndex` unit-asserted | Match. |
| Gated destination `Not available for this task` (+ cause) | matrix §11 unsupported / design-lock §8 | Browser gated panel reads `Not available for this task`; with a cause reads `… — <cause>` | Match. |
| Empty Artifacts `No artifacts` (distinct) | design-lock §8 / `T-inspectors` | Artifacts empty reads `No artifacts` with NO unavailable node present; distinct copy | Match. |
| Terminal provider-emitted output only | design-lock §8 / SF-14 (never auto-invoke `thread/shellCommand`) | Terminal panel is a `<pre>` of provider output; no `<input>`/`<textarea>`/`<button>`; markup contains no `shellCommand`/`thread/shellCommand` | Match. |
| Browser only from a real browser runtime | SF-15 / matrix §11 streaming | populated only with real activity; empty browser reads `Not available for this task` | Match. |
| Disconnected reads cached | matrix §11 disconnected | disconnected diff shows `Showing cached data — reconnect to refresh.` with cached content still readable | Match. |
| Destructive discard/unstage/worktree never in a tab | matrix §11 destructive / design-lock §8 | no `Discard`/`Unstage`/`Delete worktree` control inside ANY tabpanel; `describeDestructiveConfirmation` is a repository-utility contract (`rendersInTab:false`, focus on `Cancel`, names target, states provider task unaffected) | Match. |
| ScrollArea only inside a bounded diff | SF-12 (`ScrollArea` allowed inside bounded non-virtualized diff only) | measured diff scroll region `overflow-y:auto; max-height:220px`; no other panel carries `data-dh-diff-scroll` | Match. |
| Narrow/PWA disclosure | matrix §11 responsive / SF-11 | `disclosure` variant renders `Desktop required for terminal and diff` + title, no tablist/tabpanel | Match. |
| No logos anywhere | design-lock §3 / invariant 9 | `0` `<svg>` and `0` `<img>` in every fixture | Match. |

### Task 6 judgment

`InspectorDock` is the canonical task inspector: ONE measured 300-wide, content-height,
rounded `#2d2d2d` dock (16 padding, ~16 radius, mirroring `SHELL_GEOMETRY`) that is NOT a
full-height IDE split pane. It opens with a persistent, compact, NON-TAB `Environment`
summary (backed environment/repository/subagent/source rows only) that stays byte-identical
across selections, followed by exactly five selectable destinations
`Diff`/`Files`/`Terminal`/`Browser`/`Artifacts` on a `role="tablist"` with roving
Left/Right/Home/End focus (`nextTabIndex` pure fn) and a `tabindex=0` tabpanel labelled by
the selected tab, and the footer `Availability follows the task runtime`. Exactly one
destination renders. Availability follows the real runtime, never the schema
(`computeDestinationView`): a gated destination reads `Not available for this task` (with
an appended cause when useful); empty-but-supported Artifacts reads `No artifacts` (a
DISTINCT state); a disconnected panel reads cached with
`Showing cached data — reconnect to refresh.`. Terminal is provider-emitted output only
with no input/shell affordance and never references `thread/shellCommand`; Browser
populates only from a real browser runtime. Destructive discard/unstage/worktree deletion
is a repository-utility confirmation OUTSIDE any tab (`describeDestructiveConfirmation`,
focus on `Cancel`, names the target, states the provider task is unaffected); the dock
renders no destructive control inside a tabpanel. `ScrollArea` appears ONLY inside the
bounded diff body. Narrow/PWA uses the titled `Desktop required for terminal and diff`
disclosure, not the desktop dock. Ships behind the default-off `inspectorDock` flag;
flag-off keeps the legacy diff/file/git panels (`resolveInspectorDockMode` returns `legacy`
for false/undefined/missing, `isInspectorDockApplied` true only for an explicit true), so
flag-off never instantiates the dock. SCOPE: this claims the inspector PRESENTATION,
dock geometry, runtime-gated destination logic, keyboard/a11y, and flag safety only; live
mounting into the shell + wiring real repository/provider events is a deferred data-wire
staged for the Task 9 `codexStyleShell` cutover. `nativeCodex` / `persistentClaude` /
`inspectorDock` requested-defaults stay false.

### M6 Task 7 - Search + Commands

Date: 2026-07-15

Governing sources: `design-lock.md` §8 (Search is a dedicated dialog with query,
global/project scope, date facets, highlighted result rows, keyboard selection,
status/count, open/close navigation; Commands is a SEPARATE Command-in-Dialog action
palette; `Search tasks` transitions into Search rather than replacing it),
`component-state-matrix.md` §12, `surface-inventory.md` `SF-18`/`SF-19`,
`design-system.md` §7.9, REF-SEARCH (`devhub-current-search-results.png`, the
PRESERVATION authority for the populated results contract). Evidence:
`evidence/m6/search-commands/` (`qa-note.md`, `fixture.html`,
`m6-search-commands-wide.png`) plus the unit/snapshot suites
`apps/web/src/components/features/search/TaskSearchDialog.test.ts` (26) and
`apps/web/src/components/features/commands/CommandDialog.test.ts` (16).

| Comparison | Governing reference | M6 implementation evidence | Finding / disposition |
| --- | --- | --- | --- |
| One shared `#2d2d2d` / 12px-radius Dialog composition, two SEPARATE surfaces | design-system §7.9 / design-lock §8 | measured `rgb(45,45,45)` / `12px` on both; `5` `data-dh-search-dialog` + `3` `data-dh-command-dialog`, never both on one node | Match. |
| Search is Search; Commands is Commands (never merged) | design-lock §8 | each dialog's markup excludes the other's title/marker (`TaskSearchDialog` never contains `Search commands and tasks`/`data-dh-command-dialog`, and vice versa) | Match. |
| `Search tasks` closes Commands, opens Search (no inline merge) | design-lock §8 | `describeSearchTasksTransition()` returns `{closeCommands:true,openSearch:true,merged:false}`; dispatch routes to `onSearchTasks`, never `onRun`, for the `open-search` kind | Match. |
| Global/current-project scope + locked date facets (radio/pressed semantics) | `T-search` / matrix §12 | `role="radio"` scope + date buttons with `aria-checked`; Project scope `disabled` + `Select a project to scope the search to it` reason when no project is active | Match. |
| Populated result rows: title / project / highlighted snippet / count | REF-SEARCH preservation contract | `<mark>` highlight (not color-only), `N results` / `1 result` singularization, title+project+provider-label rows | Match. |
| Result provider is derived from the composite key, never model text | `assertNativeTaskKey` parity / design-lock §3 | `providerFromTaskKey`/`navigationTargetForResult` parse the `provider\0home\0nativeTaskId` key and `throw` on a malformed/textual key; a snippet mentioning "Codex" never becomes the provider | Match. |
| Degraded raw OpenAI session is `OpenAI`, never `Codex`, and discloses `Read-only fallback` | design-lock §3 (raw OpenAI ≠ Codex identity) | `resultProviderLabel` returns `OpenAI` (not `Codex`) for a `degraded` result; row renders `data-dh-read-only` + `Read-only fallback` | Match. |
| Error is a DISTINCT accessible Alert, never collapses to `No results` | design-lock §8 / matrix §12 | `role="alert"` region, `Search failed` + `Retry`, retains query/scope/date; `resolveSearchStatus` precedence proves `error` always wins over `empty` | Match. |
| Loading renders content-shaped Skeleton rows | matrix §12 (loading distinct from empty) | `3` `data-dh-search-skeleton-row` (`aria-hidden="true"`) reusing the shared `Skeleton` primitive; announced to AT via the `role="status"` `Searching…` text above, not the hidden rows | Match. |
| Commands keeps the approved 5-row registry with runtime-gated provider-scoped rows | design-lock §8 / `T-commands` | `DEFAULT_COMMANDS` titles exactly `[New task, Search tasks, Toggle inspector, Open Settings, Go to Ops]`; `visibleCommands` drops a `providerScoped` row whose `capable` is false, so Commands never offers a silent cross-provider action | Match. |
| Keyboard-active row distinct from scope/date; Escape restores the invoker | matrix §12 focus row | `aria-activedescendant` + `aria-selected` mark the ONE active row; Commands carries zero `data-dh-search-scope`/`data-dh-date-facet` nodes; `describeEscapeRestore` names the invoker to refocus | Match. |
| No provider logos anywhere | design-lock §3 / invariant 9 | `0` `<svg>` and `0` `<img>` across all 8 fixture sections | Match. |

### Task 7 judgment

`TaskSearchDialog` and `CommandDialog` are the canonical, SEPARATE Search-results and
Commands-action-palette dialogs: one shared `#2d2d2d`/12px-radius Dialog composition,
each with its own titled `role="dialog"` and accessible name, never merged into one
surface. Search owns a focused query, Global/current-project scope (radio semantics,
Project disabled with a stated reason absent a project), five locked date facets
plus after/before/clear controls, a result count/status region, and provider-locked
result rows (title/project/highlighted-`<mark>`-snippet) whose provider is derived
SOLELY from the composite native task key (`providerFromTaskKey`/
`navigationTargetForResult`, which throw rather than infer a provider from text) — a
degraded raw OpenAI session is labeled `OpenAI` (never `Codex`) and discloses
`Read-only fallback`. A read failure renders a DISTINCT `role="alert"` Alert that
retains the query/facets and can never collapse to `No results` (`resolveSearchStatus`'s
precedence proves it); a request in flight renders content-shaped `Skeleton` rows
instead of a bare spinner. Commands is a wholly separate contract carrying only the five
approved rows (`New task`/`Search tasks`/`Toggle inspector`/`Open Settings`/`Go to Ops`)
with a subsequence fuzzy filter, hides any `providerScoped` row whose runtime capability
is false so it can never silently invoke another provider, and its `Search tasks` row
CLOSES Commands then OPENS Search (`describeSearchTasksTransition`) rather than
rendering Search inline. Both dialogs render no provider logos. Ships behind the
default-off `searchCommands` flag shared by both dialogs (`resolveSearchCommandsMode` /
`isSearchCommandsApplied`, mirroring `resolveInspectorDockMode`): flag-off keeps the
legacy `SearchPalette` mounted exactly as today and keeps the legacy `CommandPalette`
UNMOUNTED exactly as today, so flag-off is a true no-op that instantiates neither new
dialog. SCOPE (honest): this claims the Search + Commands PRESENTATION, the
provider-locked result/navigation contract, the Commands→Search handoff, keyboard/a11y,
and flag safety only; live mounting into `App.tsx`'s overlay tree (real debounced fetch,
real `onOpen`/`onRun` handlers, real keyboard-shortcut dispatch replacing the legacy
`SearchPalette`/unused `CommandPalette` import) is a deferred data-wire staged for the
Task 9 `codexStyleShell` cutover, mirroring how Tasks 3–6 left their live mount as a
later data-wire (only the outermost `shellChrome`/`taskRail` cutover points are
live-switched in `App.tsx` today). TOOLING (honest): `design-lock.md` §7 names the
shadcn/Radix toolchain, but no M6 task (1–7) has installed shadcn/cmdk/Radix packages —
this slice, like the rest of `apps/web` including the legacy `SearchPalette`/
`CommandPalette` it supersedes, uses hand-rolled ARIA-correct primitives on the shared
token system, reusing the existing `Skeleton` component for loading and a `role="alert"`
region standing in for `Alert`; a full shadcn migration remains an unstarted, larger
follow-up. `nativeCodex` / `persistentClaude` / `searchCommands` requested-defaults stay
false.
