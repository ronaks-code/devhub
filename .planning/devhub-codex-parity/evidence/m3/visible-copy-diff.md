# M3 visible-copy diff

Authority: `surface-inventory.md` section 6 (`T-*` target copy and temporary `L-*` allowances).

## Exact target copy now present

- `DevHub`
- `OpenAI · Codex`
- `Plan`
- `Allow`
- `Deny`
- `Cancel`
- `Input requested`
- `Retry native runtime`
- `Reconnecting… task mutations remain paused.`
- `Check task status`
- `Ask for follow-up changes`
- dynamic task title, folder, model, status, counts, diff, usage, and provider-native event text

The previous unapproved empty-task strings `Ready for a native Codex turn` and `Continue this task below. Provider identity stays fixed after creation.` were removed. An empty existing task is now a blank transcript canvas.

## Temporary M3 compatibility copy

These strings describe the native vertical slice truthfully but are not final M6 shell copy:

- `Native history`
- `New native Codex task`
- `Loading native history…`
- `Loading native task…`
- `Resume`
- `Rename native task`
- `Fork native task`
- `Archive native task`
- `Continue native Codex task` (screen-reader label)
- `Send to native Codex task` (screen-reader action)
- `Interrupt active Codex turn`
- reconciliation explanations such as `Native task state was refreshed after the uncertain resume. Review it before enabling another mutation.`

They remain only inside the feature-gated M3 surface. M6 must adopt the final `T-header`, `T-setup`, `T-composer`, and `T-intervention` labels (`Task actions`, `New task`, `Start a task`, `Folder`, `Permissions`, `Send`, `Stop`, and the exact approved disclosures).

## Rejected/generated copy

- No malformed ImageGen labels, invented Inbox copy, fake provider names, or generated paths were shipped.
- No `Always allow` action exists.
- No raw OpenAI Chat surface is called Codex.
- No unavailable approval/input capability is presented as actionable.

## Open copy gaps

- `Request expired — no action taken` cannot yet be rendered because normalized `request-resolved` events do not carry a resolution reason. Timeouts remain fail-closed in the broker and are not mislabeled; reason-bearing presentation remains open for the M6 intervention contract.
- `Working for [duration]` and the persistent `Goal` strip are not in the M3 preserved-shell slice; they remain M6 composition work.
- The new-task form still uses M3 compatibility labels (`Working folder`, `Permission mode`, `Workspace write`) rather than the final provider-aware setup vocabulary. This is recorded, not treated as parity.
