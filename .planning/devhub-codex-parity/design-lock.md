# DevHub Approved Design Lock

Status: approved and locked for implementation on 2026-07-12. The user explicitly approved the recommended DevHub direction and the narrowly scoped auditable custom-Radix-preset deviation. This document converts that approval into binding production decisions; it does not upgrade capability-gated provider behavior into a supported claim.

## 1. Governing sources and precedence

Resolve behavioral and visual conflicts separately.

Behavioral precedence:

1. The provider capability matrix and synchronization contract govern whether an action exists, which native state it may mutate, and which recovery semantics are honest.
2. Real current DevHub behavior and the preservation matrix govern existing functionality that must survive, including the populated Search-results contract.
3. `component-state-matrix.md` and `surface-inventory.md` govern allowed states, exact copy, primitive ownership, persistence, and cutover gates, but they may never promote an unproved provider capability.

Visual precedence, after the behavioral gate is satisfied:

1. Real installed Codex captures and measurements in `reference-capture-manifest.md` govern surfaces actually observed in Codex.
2. Real current DevHub behavior and the preservation matrix govern preserved surfaces.
3. The selected concept plus its governing production brief/clarification governs DevHub-only additions. Verbatim `*-generation-brief.md` files are provenance only.
4. `design-system.md`, `component-state-matrix.md`, and `surface-inventory.md` resolve repetition, state, copy, primitive, accessibility, and ownership details.

Generated misspellings, malformed tabs, rejected permission terms, contradictory states, oversized crops, and invented geometry never become implementation requirements.

## 2. Selected visual specification

| Area | Governing source | Locked interpretation |
|---|---|---|
| Wide shell / completed task | `chatgpt-current-1800x1130.png` | Codex-density shell, open transcript, compact Environment inspector, resting composer. |
| Sparse / interrupted task | `chatgpt-devhub-sync3-thread-1800x1130.png` | Right-aligned user bubbles, unframed assistant prose, title truncation, intentional negative space. |
| Active work | `chatgpt-active-goal-1800x1130.png` | Same-thread narrative, compact activity, spinner, diff pill, narrow goal card, stable stop composer. |
| Empty existing task | `chatgpt-empty-task-1800x1130.png` | Blank central canvas; no welcome hero, suggestions, onboarding cards, or illustration. |
| New task | `01-new-task-empty.png`, `05-provider-setup.png`, exact briefs | Compact provider-aware setup using measured shell geometry; reject concept 1's oversized overlapping inset. |
| Plans / tools | `02-active-plan-tools.png` plus active capture | Inline activity and expandable plan within the transcript, never a progress dashboard. |
| Intervention | corrected concept 3 plus the initial concept's independent cancellation tile | Capability-gated inline requests; expiry and cancellation are distinct; timeout never approves. |
| Inspectors | `04-inspector-dock.png` plus `04-inspector-dock-brief.md` | One 300-unit dock with five destinations; reject generated tab/copy inconsistencies. |
| Fork | `06-cross-provider-fork.png` plus corrected production brief | Unchanged source, locked exclusions, attributed reviewed/redacted handoff, new native target, additive backlink. |
| Work | corrected concept 7 | `Work` selected, provider-native folder/permission scope, transcript progress, compact deliverables; never Cowork. |
| Search / Commands / responsive | concept 8, corrected production brief, current DevHub Search capture | Search remains a dedicated results surface; Commands remains an action palette; narrow/PWA behavior is proposed and gated by implementation QA. |

## 3. Identity and provider ownership

- Product name is `DevHub` in shell, title, Settings, packaging, and user-facing copy.
- Provider identity is quiet text: `OpenAI · Codex` or `Anthropic · Claude`. Use no generated logos and imply no first-party affiliation.
- Provider appears in the task row, task header/setup, and compact composer/footer context where useful; it does not become a second visual language.
- Provider is immutable after native task creation. No provider picker appears inside an existing task.
- Provider change is always `Create cross-provider fork`, producing a new native provider task and leaving the source unchanged.
- Raw OpenAI Chat Completions is labeled `OpenAI Chat — development only` if retained. It never carries Codex identity and is never a Codex fallback.

## 4. Locked container and geometry model

- Logical wide reference: `1800x1130`.
- Left task rail: 273 units. Header: 46 units. Main canvas: open `#181818`, without a page card.
- Transcript and composer share a 736-unit column. Resting composer is 736x98 with a 16-unit bottom gutter and approximately 21-unit radius.
- Desktop inspector is a 300-unit, content-height surface with a 12-unit top gutter, 16-unit right gutter, and approximately 16-unit radius. It is not a full-height split pane.
- Selected task row is a compact 256x30 row at an 8-unit rail inset. User bubbles are right-aligned, max roughly 566 units, on the transcript column.
- Active diff and goal state remain compact bottom-local controls. The composer does not move when send becomes stop or activity appends.
- Rail hierarchy is an open list, not nested cards. Assistant prose and normal activity are unframed. Only requests, user bubbles, compact controls, composer, and inspector use surfaces.
- Secondary utilities do not invade the core task canvas. No dashboard grid, KPI cards, marketing copy, decorative badges/pills, gradients, glows, or generic IDE chrome.

Exact tokens, typography, radii, spacing, borders, focus, icon, elevation, responsive, and motion rules live in `design-system.md`.

## 5. Task setup and provider-aware control rules

New task setup may expose only fields supported by the selected provider/version:

- `Provider`
- `Model`
- `Mode`
- `Project`
- `Folder`
- provider-native permission field
- `Create task`

The setup states `Provider is fixed after creation. Fork to another provider to continue there.` Codex uses its real model/reasoning/permission inventory. Claude displays requested, init/session-reported, and response-used model when they diverge and states `Model differs from request`; it must not claim that the requested model ran.

Permission strings are provider-native. Codex `Workspace` and Claude `Permission mode / Default` are not interchangeable labels. Unsupported or unproven controls are absent or disabled with a capability explanation; CSS state never substitutes for a missing runtime contract.

## 6. Thread, activity, and composer rules

- The transcript is the task. Active work stays in the same vertical narrative as completed work.
- User content uses compact right-aligned bubbles. Assistant prose, tables, lists, code, reasoning disclosure, and ordinary tool rows remain unframed.
- Plans, commentary, tools, file edits, tests, sources, subagents, and provider events use compact typed rows backed by native events.
- Unknown provider events remain bounded diagnostic activity; they do not crash replay and do not invent a user-facing semantic state.
- Streaming keeps one anchor and stable composer geometry. Replayed events are idempotent on provider/native IDs.
- Stop/interrupt is visible only when a real native interrupt path is enabled. Acknowledged cancellation and terminal provider subtype are correlated rather than inferred from one string.
- Steer, inline approval, user input, MCP elicitation, skills, subagents, hooks, and background work render only when their provider/version capability is proven and the production adapter gate passes.
- The composer shows the real folder/permission/model/mode context compactly. It never exposes credentials or an unsandboxed shell fallback.

## 7. Requests, recovery, and destructive semantics

- Approval and user-input requests are inline task activity, not modal AlertDialogs.
- Permission actions are `Allow`, `Deny`, and `Cancel` only when the adapter can answer the exact native request. No `Always allow` action is approved.
- A timeout produces `Request expired — no action taken`; it never defaults to approval.
- Generic retries are prohibited for uncertain mutations. A retry may appear only when the operation is identified as safe/idempotent, e.g. `Read failed`, `Retry`, `Safe to retry`.
- Reconnect exposes `Check task status` and `Cancel`; it reconciles native state before allowing another write.
- `Cancelled by you` is a terminal state with transcript retained and the resting composer restored. It never shares expiry copy.
- Destructive confirmation uses AlertDialog only for a destructive user action such as delete; ordinary approval remains inline.

## 8. Inspector, Search, Commands, Settings, and utilities

- `InspectorDock` begins with a persistent compact `Environment` summary region for backed environment/repository/subagent/source rows, followed by exactly five selectable destinations: `Diff`, `Files`, `Terminal`, `Browser`, and `Artifacts`. `Environment` is not a sixth tab. Each selected destination reports `Not available for this task` when gated.
- Terminal contents must be provider-emitted; DevHub never invokes `thread/shellCommand` automatically or implies an unsandboxed terminal.
- `No plugins` and `No artifacts` are valid empty states. `Not supported by this provider` is unsupported. `Unavailable until runtime support is verified` is gated. `Local to DevHub` marks additive metadata.
- Search is a dedicated dialog with query, global/project scope, date facets, highlighted result rows, keyboard selection, status/count, and open/close navigation. Search result selection opens the correct provider-locked native task/message.
- Commands is a separate Command-in-Dialog action palette. `Search tasks` transitions into Search rather than replacing Search.
- Settings uses accessible field groups for Appearance, Providers, Permissions, and preserved configuration surfaces.
- Ops, Inbox, Dashboard/Overview, analytics, project overview, configuration, archive/export, and transcript utilities remain preserved secondary destinations.

## 9. Cross-provider fork and DevHub Work

Cross-provider fork:

- preview target provider, requested model, mode, folder, and target-provider permission mode;
- show transferred user messages, goal summary, selected files, and reviewed tool output;
- lock and automatically exclude secrets/auth, hidden reasoning, approval credentials, and unreviewed sensitive tool output;
- show an attributed `Handoff from <source provider> task <native id>…` body with visible redactions before creation;
- create a new native target task, preserve source, and store only additive DevHub provenance/backlinks;
- call it a fork, never switch/move/same-session continuity.

DevHub Work:

- is a provider-neutral DevHub mode only where the runtime supports its required operations;
- always displays folder scope and provider-native permission mode;
- keeps progress/outcome in the transcript and compact goal strip; deliverables remain secondary in the inspector;
- never claims Anthropic Cowork interoperability, persistent background execution, or subagent work unless independently proven.

## 10. Responsive, motion, keyboard, and accessibility lock

- Wide desktop follows measured geometry. Below the current preserved 1024-unit boundary, use a one-pane drill-down with accessible rail/inspector sheets and no horizontal overflow.
- PWA scope is safe task reading/reply/navigation. Use `Desktop required for terminal and diff` where applicable. No native-mobile, offline, push, background, or full-parity claim.
- Static observations lock only continuity: activity appends inline, task spinner is quiet, and send swaps to stop without layout shift.
- Unmeasured motion uses the approved 120–220 ms fallback only after design-system documentation; it must support interruption/reversal, focus restoration, and `prefers-reduced-motion`.
- Keyboard-first behavior, logical tab order, visible focus, accessible names, status/stream announcements, Escape, arrow navigation, focus traps/restoration, scroll locking, and contrast are mandatory gates.

## 11. Shadcn / Radix substrate decision

- Use official `@shadcn` registry source only, Radix base, React/Vite, `rsc:false`, TypeScript, Tailwind v4 CSS variables, Lucide, `src/index.css`, and an `@/*` alias to `apps/web/src/*`.
- Approved tooling deviation: create one transparent custom Radix preset from locked choices solely because shadcn CLI 4.13.0 cannot initialize without a preset. Inspect its complete URL/config and disposable diff. Stop if it cannot be audited.
- No named visual preset, `--defaults`, page block, `apply`, `--force`, `--reinstall`, `--overwrite`, `add --all`, or default shadcn styling is approved.
- Move the clay brand token from `--accent` to the distinct `--dh-brand`/`--brand` semantic; reserve shadcn `--primary` for the neutral high-contrast action treatment and `--accent` for neutral hover/selection. Preserve and temporarily alias legacy tokens as documented in `design-system.md`.
- Keep `apps/web/src/components/ui.tsx` as a compatibility facade until no imports remain. Do not flag-day migrate controls.
- Use shadcn primitives for accessible behavior while styling through semantic tokens to match the reference. Do not wrap the virtualized transcript in ScrollArea.

## 12. Component architecture and migration lock

Target ownership:

- `DevHubShell`
- `TaskRail`
- `TaskHeader`
- `ThreadWorkspace`
- `ActivityTimeline`
- `Composer`
- `InspectorDock`
- provider controls/adapters
- Search and Commands
- Settings and preserved utility routes
- Cross-provider fork
- DevHub Work

Canonical production component identifiers are `DevHubShell`, `TaskRail`, `TaskHeader`, `ThreadWorkspace`, `ActivityTimeline`, `Composer`, `InspectorDock`, `TaskSetup`, `TaskSearchDialog`, `CommandDialog`, and `CrossProviderForkReview`. Earlier prose aliases map as follows and must not create parallel owners or files: `TaskShell` -> `DevHubShell`; `TaskComposer` -> `Composer`; `TaskInspector` -> `InspectorDock`; `NewTaskSetup` -> `TaskSetup`; `SearchTasksDialog` -> `TaskSearchDialog`. `TaskTranscript` names the semantic transcript region inside `ThreadWorkspace`, with typed activity owned by `ActivityTimeline`; it is not a second workspace owner.

`App.tsx` becomes composition/routing incrementally. Each migration slice stays behind an explicit false-by-default feature flag until functional, persistence, recovery, accessibility, and visual parity pass. Existing routes/data remain live throughout. Legacy paths are deleted only when their preservation rows are green.

## 13. Rejected generated details and intentional deviations

- Reject stray `Codex` product wordmarks in DevHub concepts.
- Reject oversized concept headings, setup overlays, and cropped Work outcome surfaces; measured geometry wins.
- Reject malformed generated copy, paths, tab names, tab selections, and artifact contradictions.
- Reject concept 3 corrected cancellation tile; use the independent initial cancellation tile.
- Reject Claude `Workspace`; use `Permission mode / Default` in the approved fork/setup states.
- Reject selectable exclusion categories and handoffs without an attributed reviewed/redacted body.
- Reject a permanently visible Claude model warning beside a selected Codex task; show it only when Claude is selected and divergence exists.
- Reject concept screenshots as shipped UI. All visible product text, controls, icons, lists, dialogs, and state remain code-native.

## 14. Change control and exit criteria

No additional design approval checkpoint is required for faithful implementation. A new user decision is required only if an upstream/runtime constraint forces a materially different product behavior or source-hierarchy departure.

The design lock is complete when the companion design system, component-state matrix, and surface inventory are present; links resolve; visible-copy/source ownership is internally consistent; `git diff --check` is clean; and a staff review finds no evidence overclaim. Production implementation then proceeds M2 through M8 with the milestone gates in `implementation-plan.md`.
