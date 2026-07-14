# M4 Browser/IAB QA

Date: 2026-07-13

Scope: the Anthropic presentation of the shared provider-native task pane, exercised against the deterministic M4 fixture. This is product UI evidence, not a substitute for the blocked raw live-Claude lifecycle gate.

## Method

- Browser/IAB was used first through the bundled browser client.
- The fixture ran with `DEVHUB_FIXTURE_PROVIDER=anthropic` on `127.0.0.1:8787`; Vite served `127.0.0.1:5173`.
- Authentication used the literal synthetic token `m3-fixture-token`. No provider credential entered the browser, screenshot, DOM, log, or fixture.
- The governing concepts `02-active-plan-tools.png` and `05-provider-setup.png` plus the implementation captures were reopened with `view_image` at original detail in the same QA pass.

## Workflow and evidence

| Workflow | Evidence | Result |
| --- | --- | --- |
| Select active Claude task | `browser-wide-active-claude.png` (`1280x720`) | `Anthropic · Claude` appears in the rail and header; plans, shell activity, diff summary, usage, turn state, and an unsupported request explanation render without pretending the control works. |
| Create Claude task | Final `browser-wide-create-exact-copy.png`, `browser-narrow-create-exact-copy.png`, and `browser-narrow-create-ready-exact-copy.png` | Provider is fixed; model selection is disabled with exact truthful disclosure; permission options are exactly `Manual`, `Accept edits`, `Plan`; required-field gating changes creation from disabled to enabled. |
| Complete a synthetic turn | `browser-narrow-completed-claude.png` (`768x720`) | Task creation, user message, plan, activity, assistant result, and follow-up composer render from native-provider-shaped events. |
| Regress terminal row status | `browser-narrow-completed-after-fix.jpg` (`768x720`) | A second terminal event leaves the selected task row `idle`, not stale `active`. |

The original create-copy screenshots predate the final exact-copy repair. The final Browser/IAB and Computer Use recaptures now prove:

- `Manual`, `Accept edits`, `Plan`;
- `Claude model selection unavailable until runtime support is verified.`;
- `Provider is fixed after creation. Fork to another provider to continue there.`;
- `First message (required)` for Anthropic creation;
- `Cancelled by you` only after an exact strict interrupt receipt and the proven `error_during_execution` result correlate.

The authoritative recaptures are `browser-wide-create-exact-copy.png`, `browser-narrow-create-exact-copy.png`, `browser-narrow-create-ready-exact-copy.png`, and the fresh Computer Use screenshots/trace. The older create captures remain useful only for historical geometry and state provenance.

## Final exact-copy recapture

- Browser/IAB at `1280x720` found exactly one model disclosure, provider-lock disclosure, required first-message textbox, permission combobox, and create button. Permission options were exactly `Manual`, `Accept edits`, `Plan`, with `Plan` selected.
- Browser/IAB at `768x720` returned the same exact copy/options. `Create task` was disabled before required input and enabled after synthetic cwd/message input.
- Wide body/document/client widths were exactly `1280`; narrow widths were exactly `768`. Neither viewport had horizontal overflow.
- The in-app Browser reported no warning/error console entries.
- Computer Use independently drove the matching Chrome workflow through create, completion, idle composer, and strict interrupt; see `computer-use-exact-copy-trace.md`.

## Responsive and accessibility checks

- At `1280x720`, body and document scroll width were exactly `1280`.
- At `768x720`, body and document scroll width were exactly `768`; no horizontal overflow was present.
- Browser accessibility snapshots exposed a named `Anthropic · Claude tasks` complementary region, a `Native Claude task history` listbox with selected options, a named `Selected native Claude task` region, a named transcript, status output, textbox, and send/interrupt buttons.
- Provider identity remains text, not a generated or first-party logo.
- Unsupported command approval rendered as `This provider interaction is not enabled for this task.` with no executable approval action.
- Final M6 still owns the one-rail responsive model, full keyboard/focus matrix, semantic tokens, and final visual parity. This M4 pass does not claim them.

## Browser-discovered defect and repair

Browser/IAB exposed that a terminal turn notification could leave the task-list row `active` even though the transcript said `completed`.

1. A new test for `projectTaskStatusFromTurnEvent` was run first and failed because the helper did not exist.
2. The helper now projects an active-like row to `idle` only when the event is terminal and no other active turn remains.
3. The focused/full web gate passed after the repair, and a second Browser turn produced the exact selected option `New native Claude task, Anthropic · Claude, idle`.

## Judgment

Synthetic Browser and Computer Use gates pass, including final exact-copy and responsive recapture. The live selected-runtime lifecycle gate remains blocked and recorded separately in `live-runtime.md`; `persistentClaude` remains false and M4 is not reported complete.
