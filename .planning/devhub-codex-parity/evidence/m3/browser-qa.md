# M3 Browser/IAB QA

Date: 2026-07-13 (America/Los_Angeles)

Surface: Vite `http://localhost:5173/?tab=codex-history` against the Node/TypeScript fixture in `qa/m3-fixture-server.ts`. Authentication used DevHub's real `AuthGate` with the fixture token. No Python process or live provider turn was used.

Synthetic data is explicitly synthetic. It validates DevHub's production browser client, routes, state machine, accessibility tree, and rendering; it is not evidence that unadvertised installed-runtime capabilities work.

## Workflows

| Workflow | Browser result | Evidence |
| --- | --- | --- |
| Wide active task | Provider identity, title, native plan/activity/diff/usage, command request, active turn, stable composer | `browser-wide-active.png` |
| Stream completion | User message, streamed plan/activity/assistant completion, resting composer | `browser-wide-completed.png` |
| New task | Setup form opened; one create request selected the new native key; blank task rendered | `browser-wide-new-task.png` |
| Empty task | Blank transcript region, zero children, no SVG or central copy; exact `Ask for follow-up changes` placeholder | `browser-narrow-empty-task-after-fix.png` |
| Archive dialog | `alertdialog`, `aria-modal=true`, inert app root, body scroll lock, initial Cancel focus; Shift-Tab/Tab trapped focus; Escape closed; focus restored to trigger | `browser-wide-archive-dialog.png` |
| Archive success | Created task disappeared only after success; status announced; focus restored to task list | Browser DOM log from the same run |
| Roving task list | ArrowDown moved focus; Enter selected the focused task; Home/End/j/k behavior has focused unit coverage | Browser DOM log plus 140-test web suite |
| Rename/fork | Fork preserved source; rename updated the selected native task | Browser DOM log from the same run |
| Loading | Delayed provider response rendered a bounded `Loading native task…` state | `browser-narrow-loading.png` |
| Offline uncertain mutation | Backend was stopped; Resume returned an uncertain outcome; all mutations and interventions froze; cached transcript/draft remained; `Check task status` appeared | `browser-narrow-disconnected.png` |
| Reconciliation | Restarted delayed backend; check showed Cancel; authoritative read required explicit review; policy verification then reconnected | `browser-narrow-reconnecting.png`, `browser-narrow-recovered.png` |
| Unsupported capabilities | Start/resume/fork/send/interrupt/respond/archive/rename false: controls absent and task read-only; pending request had no action buttons | `browser-narrow-unsupported.png` |
| Guarded input request | Input request rendered, but absent bounded question metadata produced no response action | `browser-narrow-input-request-guard.png` |
| Request cancellation | Cancel response produced an exact `request-resolved` event; pending intervention disappeared and late response race remained non-actionable | `browser-narrow-intervention-cancelled.png` |
| Minimum width | 768x720: document, body, and header scroll widths all equal 768px after repair | `browser-narrow-after-fix.png` |
| Light theme | Computed body background `rgb(250, 250, 250)`, foreground `rgb(24, 24, 27)`, `data-theme=light`; preference restored to dark | `browser-wide-light-theme.png` |
| Reduced motion | `Motion: auto` -> forced reduced motion set `data-reduce-motion=true`; full-motion and auto states both rendered; preference restored to auto | Browser DOM log |

## Keyboard and focus details

- All tested actions were located by semantic role and exact accessible name after a fresh DOM snapshot.
- The task transcript is a named region; live announcements use a bounded atomic polite status node.
- The archive dialog focus trap, Escape close, inert background, scroll lock, and focus restoration passed.
- Reconciliation and unsupported states removed or disabled mutation controls instead of leaving clickable dead controls.
- The composer retained focus across streamed events in the completed-turn workflow.

## Current limitations

- First-party Computer Use is host-blocked; see `computer-use.md`.
- The fixture can prove fail-closed input handling, but installed Codex input/approval capabilities remain false because they were not live-exercised.
- Expiry-specific visible copy is not present because `request-resolved` lacks a reason field; broker timeout behavior is covered outside Browser and remains fail-closed.
- The approved one-rail narrow shell is M6 work. M3 proves no horizontal overflow at the minimum desktop viewport while retaining the existing two-rail shell.
