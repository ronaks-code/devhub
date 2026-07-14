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
