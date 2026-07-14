# DevHub Single Design, Architecture, and Plan Approval Package

Status: **awaiting explicit user approval**. This is the one mandatory design gate. No production frontend code has been changed.

## 1. Decision requested

Approve the recommended **reference-first DevHub task environment** as the production specification:

- preserve the captured Codex shell, density, open transcript, stable composer, compact activity, and content-height inspector;
- brand the shell DevHub and add quiet text identity for `OpenAI · Codex` or `Anthropic · Claude`;
- lock every task to its native provider and expose only provider/version-proven controls;
- treat cross-provider continuation as a reviewed, redacted fork into a new native task;
- add DevHub Work as an outcome/deliverable mode without claiming Cowork interoperability;
- keep functional Search results distinct from the command palette, and move secondary utilities behind command/search and narrow navigation rather than turning the task surface into a dashboard.

Approval locks the source hierarchy, interaction direction, and intentional caveats below. It does **not** convert proposed or capability-gated states into provider claims. Real captures always outrank generated concepts, governing production briefs/clarifications outrank malformed or rejected generated details, and the post-approval design lock will resolve repeated-component details. Verbatim generation briefs remain provenance only.

## 2. Real reference baseline

Captured from ChatGPT/Codex desktop `26.707.51957 (5175)` on macOS `26.5.1 (25F80)`, dark theme, at `1800x1130` logical pixels. The Computer Use host rejected control of `com.openai.codex`, so the approved fallback used the screenshot skill, direct native-task navigation, and `view_image`. This limitation is why unavailable transient states are proposals rather than claimed observations.

| Real capture | Directly observed use |
|---|---|
| [Completed rich task](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-current-1800x1130.png) | Dense transcript, grouping, selected row, resting composer, Environment inspector. |
| [Sparse interrupted native task](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-devhub-sync3-thread-1800x1130.png) | User bubbles, unframed assistant prose, interrupted-history spacing, title truncation, direct-navigation SYNC-3 evidence. |
| [Active persistent goal](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-active-goal-1800x1130.png) | Inline commentary/tool rows, task spinner, diff pill, goal card, stable composer, stop control, active inspector. |
| [Empty existing native task](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-empty-task-1800x1130.png) | Blank canvas, intentional negative space, disabled send, active-window rail, compact inspector. |
| [Current DevHub populated Search](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/devhub-current-search-results.png) | Preservation-only reference for the existing functional Search-results contract: query, scopes/date facets, highlighted results, keyboard selection, and navigation instructions. This is not a Codex reference. |

Measured anchors: 273-wide rail; 46-high header; `#181818` open canvas; 736-wide transcript/composer; 736x98 composer with 16 bottom gutter; 300-wide inspector with 16 right gutter; compact selected row, user bubble, diff pill, and goal-card geometry. Static captures do not establish exact font metadata, icon strokes, focus rings, or animation timing.

Full evidence: [reference-capture-manifest.md](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-capture-manifest.md).

## 3. Numbered concept set

The exact briefs, hashes, two correction decisions, and visual discrepancies are recorded in [00-concept-ledger.md](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/00-concept-ledger.md). All images are 1536x1024 design references generated sequentially with `gpt-image-1.5`; shipped UI remains code-native.

### 3.1 New task / empty shell

- Real reference: [empty native task](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-empty-task-1800x1130.png)
- Selected concept: [01-new-task-empty.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/01-new-task-empty.png)
- Copied from Codex: measured rail/header, blank canvas, stable composer, disabled send, compact inspector, negative space.
- Added for DevHub: provider-aware task creation, provider lock, project/folder/mode/permission setup.
- Caveat: global pre-task setup was not observed. Ignore the stray `Codex` wordmark and oversized/overlapping generated inset; the capture and brief govern production geometry.

### 3.2 Active plan and tool activity

- Real reference: [active goal](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-active-goal-1800x1130.png)
- Selected concept: [02-active-plan-tools.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/02-active-plan-tools.png)
- Copied from Codex: same-thread narrative, compact activity, spinner, diff summary, goal strip, stable composer, stop control, content-height inspector.
- Added for DevHub: quiet provider identity, expanded plan treatment, provider-adapter scenario.
- Caveat: expanded Plan was not directly captured; generated rail/body copy and oversized title are non-authoritative.

### 3.3 Permission, input, failure, reconnect, expiry, and cancellation

- Real reference: [active goal](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-active-goal-1800x1130.png)
- Selected concept: [03-intervention-states-corrected.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/03-intervention-states-corrected.png) for gating/permission/input/failure/reconnect/expiry, plus the readable bottom-right cancellation tile in [03-intervention-states.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/03-intervention-states.png)
- Copied from Codex: typography, inline activity language, restrained surfaces, stable task context.
- Added for DevHub: explicitly capability-gated Claude permission/input, safe-read retry, reconnect, expiry, and cancellation components.
- Caveat: none were visually observed in Codex. The corrected plate's cancellation tile is explicitly rejected because it repeats expiry; the initial plate's independent `Cancelled by you`/restored-composer tile governs cancellation only. Unverified actions remain disabled, and timeout never authorizes.

### 3.4 Inspector family

- Real reference: [completed rich task](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-current-1800x1130.png)
- Selected concept: [04-inspector-dock.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/04-inspector-dock.png)
- Copied from Codex: 300-wide rounded inspector, compact rows, restrained elevation and density.
- Added for DevHub: Diff, Files, Terminal, Browser, and Artifacts destinations with runtime-dependent availability.
- Caveat: generated tabs/selections are inconsistent and the artifact specimen mixes populated and empty examples. Approve the container/component family only; the exact brief and capability matrix govern labels and contents.

### 3.5 Provider-aware task setup

- Real reference: [empty native task](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-empty-task-1800x1130.png)
- Selected concept: [05-provider-setup.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/05-provider-setup.png)
- Copied from Codex: empty shell, composer anchoring, inspector placement, restrained setup surface.
- Added for DevHub: provider/model/mode/project/folder controls, permanent provider lock, and requested/session/actual Claude model divergence.
- Caveat: setup is proposed. The Claude diagnostic appears only for Claude selection or detected divergence; permission terms stay provider-specific.

### 3.6 Cross-provider fork

- Real reference: [sparse interrupted task](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-devhub-sync3-thread-1800x1130.png)
- Selected concept: [06-cross-provider-fork.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/06-cross-provider-fork.png) plus the governing [production clarification](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/06-cross-provider-fork-brief.md)
- Copied from Codex: sparse thread, right-aligned user bubble, open canvas, compact surface language.
- Added for DevHub: unchanged source, reviewed target-provider preview, locked redaction categories, new target native ID, and DevHub-local backlink.
- Caveat: generated `Workspace` is rejected for the Claude target, exclusions are locked/non-interactive, and the preview plus target must show a readable `Handoff from OpenAI · Codex task …` reviewed/redacted body. Production uses `Permission mode / Default` for Claude and never mutates the source.

### 3.7 DevHub Work

- Real reference: [active goal](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-active-goal-1800x1130.png)
- Selected concept: [07-work-mode-corrected.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/07-work-mode-corrected.png)
- Copied from Codex: active narrative, compact progress, bottom goal location, stable composer, secondary inspector.
- Added for DevHub: selected Work mode, fixed Claude identity, folder scope, Claude-native permission mode, outcome progress, and deliverables.
- Caveat: Work is proposed and is not Cowork. The oversized cropped lower surface resolves to the measured narrow goal-card geometry, and no background/subagent behavior appears until proven.

### 3.8 Search, commands, utilities, narrow desktop, and PWA

- Real references: [empty native Codex task](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-empty-task-1800x1130.png) for shell language and [current populated DevHub Search](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/devhub-current-search-results.png) for preserved Search behavior.
- Selected concept/specification: [08-command-responsive.png](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/08-command-responsive.png) plus the governing [Search/Commands production clarification](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/concepts/08-command-responsive-brief.md).
- Copied from Codex: desktop palette, density, rail hierarchy, and composer language. Preserved from current DevHub: a distinct populated Search dialog with query, project/global scope, date facets, highlighted result rows, keyboard selection, and open/close navigation.
- Added for DevHub: separate command palette, Ops/Inbox placement, narrow Settings navigation, collapsed rail, and a read/reply PWA view with desktop-only capability disclosure. `Search tasks` in Commands opens the dedicated Search dialog rather than substituting for it.
- Caveat: Codex Search visuals, command behavior, narrow layout, and PWA behavior were not observed; generated copy is non-authoritative. No native-mobile, offline, push, terminal, diff, or elevated-permission parity is implied.

## 4. Provider architecture and capability matrix

M1 passes native lifecycle for both providers. It proves the provider contracts, not the production adapters.

| Area | OpenAI / Codex | Anthropic / Claude | Production rule |
|---|---|---|---|
| Selected runtime | One supervised `codex app-server --stdio` per canonical `CODEX_HOME`. | Long-lived installed Claude CLI stream-JSON child per active native task. Agent SDK is a reference/helper, not execution owner. | Backend owns processes and credentials. |
| Native authority | Native thread/turn/item IDs and rollouts. | Native UUID and session store under explicit `CLAUDE_CONFIG_DIR`. | DevHub persists rebuildable projections and additive metadata only. |
| Core lifecycle | Start, granular stream, persistence, restart, same-ID resume/continuity, interrupt verified. | Direct CLI start/stream/persist plus restarted installed CLI under the SDK reference client for same-ID resume/continuity, file allow, and interrupt. | M1 passes; raw Claude controls remain an M4 feature-flag gate. |
| Approvals/input | Schemas exist; live approval and user-input flows were not exercised. | File-write allow verified under the SDK reference client; deny/cancel/timeout and user input remain unproven. | Capability-gated; timeout never authorizes. |
| Fork/archive | Fork/rename/archive/unarchive verified; native fork provenance disappeared after archive round-trip. | Rename/fork creation/inherited history/source immutability/delete verified; no native archive contract. | Preserve additive fork provenance; label Claude archive local. |
| Models/permissions | Seven models and read-only/workspace/danger-full-access profiles verified. | Permission modes/effort inventory verified; requested/init/actual model diverged. | Render provider-native vocabularies; Claude model selection remains gated. |
| Skills/hooks/MCP/plugins | Inventory/hooks and nine MCP servers verified; interactive elicitation remains gated. | Inventory/settings hooks/plugin/SDK MCP/permission callback verified; live skill/subagent invocation remains gated. | Inventory may render; unproven actions stay hidden/disabled. |
| Synchronization | SYNC-1 verified. SYNC-3 verified by direct native-ID navigation only for app build 5175; sidebar discovery unproven. | SYNC-1 contract verified. First-party GUI picker visibility unsupported by documented contract. | SYNC-2 leases/revision reconciliation are M5 work; never claim control over external clients. |
| Fallback | Rollout parsing is read-only degraded history. Raw OpenAI chat is never a Codex fallback. | Legacy process-per-turn remains visibly limited until M4 passes. | No fallback may masquerade as native parity. |

Evidence versions: Codex CLI `0.144.1`; Claude CLI `2.1.207`; Agent SDK `0.2.116`. Full version-specific detail: [provider-capability-matrix.md](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/provider-capability-matrix.md), [provider-spike-results.md](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/provider-spike-results.md), and [synchronization-contract.md](/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/synchronization-contract.md).

## 5. Responsive and motion behavior

- Wide desktop uses the measured shell. The inspector remains a 300-unit content-height surface rather than a permanent full-height pane.
- Preserve the current repo's one-pane browse drill-down below 1024 px while M6 establishes measured minimum-width rules. Proposed narrow behavior uses a slim/collapsed rail or accessible sheet, hides the inspector behind an explicit control, and forbids horizontal overflow.
- Supported PWA scope is task reading/reply and safe navigation. Terminal and diff may disclose `Desktop required`; native mobile, offline operation, push, and full desktop parity are excluded.
- Static captures establish continuity, not timing: the composer remains fixed; send swaps to stop with no geometry change; activity appends inline; active rows use a quiet spinner.
- Animation start/mid/end, interruption/reversal, timing/easing, focus restoration, and reduced motion remain unobserved. The design lock will use measured values if capture becomes possible and a documented 120–220 ms fallback otherwise, then verify all required frames.

## 6. Milestone plan after approval

| Milestone | Deliverable and gate |
|---|---|
| Design lock | Write allowed-copy, tokens, component-state matrix, surface inventory, responsive/motion rules, and governing source per surface. |
| M2 | Provider adapter seam with typed native IDs/capabilities/events, fixtures, legacy Claude wrapper, and unchanged UI. |
| M3 | Real Codex vertical slice: history/start/stream/activity/control/restart/resume, with rollout parsing degraded read-only. |
| M4 | Persistent Claude vertical slice reproducing raw CLI resume/permission/interrupt behavior; process-per-turn remains flagged until parity. |
| M5 | Provider-locked unified index, idempotent replay, migrations, additive metadata, leases, revisions, stale-cache/external-mutation handling. |
| M6 | Strangler migration of shell, rail, header/setup, thread/activity, composer, inspector, command/search, Settings/utilities under flags. |
| M7 | Reviewed/redacted cross-provider fork, functional DevHub Work, and synchronization gates. |
| M8 | Browser/PWA and Tauri packaging, cutover, performance/accessibility/fidelity/preservation gates, legacy cleanup. |

Every milestone keeps the app runnable, preserves routes/data, remains reversible behind a feature flag, and closes with targeted plus applicable full verification. `App.tsx` is decomposed incrementally. The existing compatibility facade remains until imports are migrated.

Shadcn adoption remains an accessible Radix substrate, not the visual design. The disposable `shadcn` 4.13.0 preview proved that no-preset initialization is impossible: the CLI requires a named preset or a custom preset produced through `shadcn/create`, and selecting `Custom` alone is a no-op.

**Explicit tooling deviation requested in this gate:** permit one transparent custom **Radix** preset generated from the approved design-lock choices solely to satisfy shadcn CLI 4.13.0 initialization. Its complete URL/config and disposable-copy diff must be reviewed before applying it. It may not introduce a named visual preset, opaque defaults, page blocks, default shadcn styling, or overwrite existing CSS/`cn()`/theme behavior. If that exact custom path cannot be audited safely, initialization stops rather than choosing a named preset or manually bypassing `init`.

## 7. Known limitations and explicit gates

### Codex upstream/current build

- Honest DevHub initialization classified new threads as `vscode`, not `appServer`.
- Resume without explicit overrides reported `dangerFullAccess`; production must pass and verify policy explicitly.
- No documented compare-and-swap protects `turn/start` from unknown external clients.
- Archive/unarchive lost native fork provenance.
- Approval/user-input features are disabled, under development, or unproven in this installed version.
- Several review/diff/background/artifact surfaces are schema-only or experimental.
- `thread/shellCommand` is unsandboxed and must never run automatically.

### Claude upstream/current build

- CLI/SDK sessions are excluded from the first-party Claude app picker.
- Third-party use requires API-key or supported cloud authentication, not Free/Pro/Max OAuth.
- No proven persistent JSON background supervisor contract exists; `--bg` cannot combine with `-p`.
- A direct turn requested/initialized Haiku but emitted and billed Sonnet 5; requested/session/actual must remain distinct.
- No comparable native archive contract was found.
- Fork continuation and post-interrupt resume were not exercised.
- User input, permission variants beyond allow, MCP elicitation, live skills/subagents, and background supervision remain gated.

### DevHub implementation gates

- Build bounded supervisors, correlation, backpressure, crash recovery, circuit breakers, fail-closed timeouts, and secret-safe diagnostics.
- Reproduce Claude controls through the selected raw CLI peer before enabling them.
- Add composite provider/native IDs, leases, revision fingerprints, invalidation, refusal/takeover, and provider failure isolation.
- Quarantine unsafe raw OpenAI tooling and secure localhost mutation APIs.
- Reprobe capability flags whenever installed provider versions change.

## 8. Recommendation and approval language

**Recommendation: approve this direction.** It is the closest faithful path to Codex quality without over-claiming unavailable first-party behavior. It keeps the task transcript as the primary surface, makes provider identity quiet but unambiguous, and treats capability truth as part of the design rather than a backend footnote.

Approval means:

1. Accept the four Codex captures as the visual authority for observed first-party surfaces and the current DevHub Search capture as preservation authority for Search behavior only.
2. Accept concepts 1–8 as directional specifications subject to their governing production briefs and caveats, including the initial cancellation detail beside corrected concept 3 and the Search supplement beside concept 8.
3. Accept the persistent CLI/app-server architecture, provider-lock rule, capability gates, corrected Claude fork semantics, Work distinction, responsive scope, and M2–M8 sequence.
4. Approve the narrowly scoped, fully audited custom-Radix-preset deviation required by shadcn CLI 4.13.0; no named visual preset is approved.

To approve, reply: **Approve the recommended DevHub direction.** Otherwise, list the numbered concept or architecture item to revise; no production frontend work starts until the direction is explicit.
