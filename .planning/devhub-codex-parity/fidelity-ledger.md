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
