# DevHub Component-State Matrix

Status: **design lock — implementation normative**. The user approved the recommended DevHub direction on 2026-07-12. This file resolves repeated-component behavior after that gate; it does not upgrade any proposed or capability-gated provider behavior to `verified`.

## 1. How to use this matrix

Implementers must apply, in order:

1. provider/runtime truth from the [provider capability matrix](./provider-capability-matrix.md) and [native synchronization contract](./synchronization-contract.md);
2. observed geometry and behavior from the real captures listed in the [approval package](./design-approval-package.md#2-real-reference-baseline);
3. the approved production clarifications and this matrix;
4. the selected generated concepts only for directional composition;
5. existing component behavior when it does not conflict with items 1–4.

The UI state is a projection of authoritative provider state. A visual state may never invent a provider capability, imply completion before an authoritative event, or turn an uncertain mutation into a retryable action.

Every interactive component must expose a single machine-readable UI state (`data-state` or an equivalent typed prop), separate from provider capability status. Do not infer capability from color, copy, provider name, or whether an event happened to appear once.

### Source keys

| Key | Governing source |
|---|---|
| `REF-EMPTY` | [Empty native task capture](./reference-captures/chatgpt-empty-task-1800x1130.png) |
| `REF-ACTIVE` | [Active persistent goal capture](./reference-captures/chatgpt-active-goal-1800x1130.png) |
| `REF-RICH` | [Completed rich task capture](./reference-captures/chatgpt-current-1800x1130.png) |
| `REF-SPARSE` | [Sparse interrupted task capture](./reference-captures/chatgpt-devhub-sync3-thread-1800x1130.png) |
| `REF-SEARCH` | [Current populated DevHub Search capture](./reference-captures/devhub-current-search-results.png) |
| `AP` | [Approved design, architecture, and plan package](./design-approval-package.md) |
| `C01`–`C08` | Corresponding production brief under [`concepts/`](./concepts/) and the caveat in `AP` section 3 |
| `CAP` | [Provider capability matrix](./provider-capability-matrix.md) |
| `SYNC` | [Native synchronization contract](./synchronization-contract.md) |
| `PRES` | [Brownfield preservation matrix](./preservation-matrix.md) |
| `PLAN` | [Implementation plan](./implementation-plan.md) |

## 2. Provider and version truth

### Capability presentation algorithm

Evaluate each control against the active task's provider, installed runtime version, effective home, adapter feature flag, live handshake, and task-specific prerequisites.

| Capability status | Rendering and action rule |
|---|---|
| `verified` | Enable only after the relevant production adapter and milestone gate pass. A provider-spike result alone does not enable a product control. |
| `schema-only` | Do not render as an available action. A contextual, non-interactive explanation may name the feature as unavailable. |
| `capability-gated` | Hide from routine menus or render a disabled explanatory row only where discovery is necessary. Never emit the provider request. |
| `unsupported` | Omit the action. In a surface whose purpose requires disclosure, render plain status such as `Not available for this task` or `Desktop required for terminal and diff`; do not render a dead primary button. |
| `degraded-fallback` | Label `Read-only fallback`; permit read/navigation only. Hide composer, approvals, interrupt, fork, archive, and other mutations. |
| unknown, stale, or version changed | Treat as capability-gated, show `Runtime capabilities need to be checked again`, retain safe read access, and schedule an explicit reprobe. Never reuse a previous version's positive flag. |

### Version-locked facts

| Runtime | Facts UI may use | Facts UI must not over-claim |
|---|---|---|
| OpenAI Codex CLI `0.144.1` | Native list/read/start/stream/persist/restart/resume with explicit policy, interrupt, fork, rename, archive/unarchive, installed model inventory, permission profiles, skills/hooks/MCP inventory. Direct native-ID visibility is verified only for Codex app build `26.707.51957 (5175)`. | Live command/file approvals and user input were not exercised; review/diff and several artifact/background surfaces are schema-only or experimental; `thread/shellCommand` must never be an automatic fallback; sidebar discovery is unproven. |
| Anthropic Claude CLI `2.1.207` | API-key-backed native UUID creation/stream/persistence and provider-runtime continuity were proved. Installed permission-mode inventory, hook activity, plugin inventory, helper list/read/rename/fork creation, and SDK-reference file allow exist. | Product controls remain behind the M4 persistent raw-CLI gate. User input, deny/cancel/timeout variants, fork continuation, post-interrupt resume, background work, and live skill/subagent invocation are not proved. Requested, session-reported, response-used, and billed models may diverge. |
| Claude Agent SDK `0.2.116` | Reference/helper evidence only. | It is not the selected execution owner and must not be named as the active task runtime. |

Provider identity is immutable for a native task. An apparent provider switch is forbidden. Cross-provider continuation always creates a new native target task through the reviewed handoff flow in section 13.

## 3. Universal visual and interaction states

The family tables below define family-specific deltas. These universal meanings still apply when a family row says `N/A`.

| State | Normative meaning |
|---|---|
| `rest` | Stable, current, and actionable when permitted. Neutral surfaces; no status color without text. |
| `hover` | Pointer-only preview. May reveal a quiet background or secondary actions; never changes selection, opens a destructive confirmation, or becomes the only way to discover an action. |
| `focus` | Keyboard focus is visible with the semantic focus-ring token and at least 3:1 contrast against adjacent colors. Focus is not the same as selection. |
| `selected` | Persistent current destination/item/value. Expose `aria-current`, `aria-selected`, or `aria-pressed` as appropriate; never communicate selection by color alone. |
| `disabled` | Known action, presently unavailable because of local prerequisites or a pending operation. Native `disabled` is used when the control need not be discoverable; otherwise `aria-disabled="true"` remains focusable and exposes the reason. |
| `loading` | A bounded read or creation is pending and no authoritative content exists yet. Preserve layout; set `aria-busy`; announce once, not on each animation frame. |
| `streaming` | Provider has acknowledged the active turn/item and deltas are arriving. Append in place; do not reset focus or scroll users who moved away from the tail. |
| `success` | An authoritative provider/server completion or persisted local write succeeded. Use restrained confirmation and a polite live-region announcement; transient chrome must not erase the durable result. |
| `error` | A bounded operation failed or provider returned an error. Retain transcript/input/context. Retry is allowed only when the operation is known read-only/idempotent or reconciliation proves the mutation did not occur. |
| `disconnected` | Connection/supervisor/lease continuity is unavailable or uncertain. Freeze new mutations, preserve reads/drafts, reconcile native revision, then explicitly restore actions. |
| `unsupported` | Provider, runtime version, adapter gate, platform, or viewport cannot execute the capability. State the limitation honestly; do not fake or silently substitute a different provider/API. |
| `destructive` | A user-triggered mutation can archive/delete/discard or replace durable local metadata. Require explicit confirmation with object/provider scope and a safe cancel; focus cancel initially. Never use red for ordinary failure. |

State precedence when more than one condition is true is: destructive confirmation > disconnected or stale revision > error > unsupported/capability-gated > disabled > loading > streaming > success > selected > focus > hover > rest. Focus styling remains visible on top of every applicable state.

### Cross-cutting accessibility and focus rules

- The shell contains one `main` landmark and a visible-on-focus skip link. Rail, transcript, inspector, and utilities use named landmarks.
- Icon-only controls have stable accessible names and tooltips. Provider identity, capability, success, error, and selection are never conveyed by icon or color alone.
- Dialogs/sheets use an accessible title, description when needed, focus containment, `Escape` close when safe, return focus to the invoker, and background inertness. Inline provider requests are not dialogs and must not trap focus.
- A newly arriving provider request is announced without stealing focus from active typing. Invoking its notification/shortcut moves focus to the safest action; resolving it restores focus to the composer or prior control.
- `prefers-reduced-motion` and the existing motion preference suppress transforms, pulsing, and smooth scrolling. Status spinners may rotate only while the status is genuinely pending; use a static status icon under reduced motion.
- Global preserved keys: Cmd/Ctrl+K Search; Cmd/Ctrl+Shift+P Commands; Cmd/Ctrl+P project switcher; `?` shortcut sheet; `Escape` closes the topmost safe overlay and restores focus.
- Do not register single-letter global shortcuts while focus is in an input, textarea, select, contenteditable, code editor, or any open picker/dialog.

## 4. Shell

Target: `DevHubShell`. Current migration anchors: `apps/web/src/App.tsx`, `apps/web/src/components/ResponsiveShell.tsx`. Governing sources: `REF-EMPTY`, `REF-ACTIVE`, `AP` sections 2, 3.1, 5, and `PRES` routes/shell preferences.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Wide desktop uses the measured 273-wide rail, 46-high header, `#181818` open canvas, 16-unit outer gutters, stable bottom composer, and content-height inspector. | Brand is exactly `DevHub`; never use provider branding as the app wordmark. One `main`, named rail navigation, optional named complementary inspector. |
| hover | Only the hovered chrome control/row changes neutral interaction fill; task canvas does not tint. | All revealed actions remain keyboard reachable. No provider-specific hover color or logo. |
| focus | Skip link and chrome controls show the common focus ring without reflow. | Tab order follows rail/header, task content/composer, then inspector; content order must remain logical when CSS placement changes. |
| selected | Current primary destination and task are independently selected; selecting a task restores its provider-locked workspace. | Use `aria-current="page"` for route and `aria-selected` within task lists. URL includes provider/native identity after M5 without breaking old URLs. |
| disabled | Shell itself is never globally disabled. Only scoped mutations freeze; navigation and safe reads remain available. | An auth gate may block task data, but must expose its reason and keep Settings/recovery reachable. |
| loading | Preserve measured rails/header/composer slots. Show content-shaped placeholders only for reads with no cached content. | `aria-busy` on the affected region, not the entire application. Do not show a fake empty task while list/read is pending. |
| streaming | Shell geometry does not move; only the selected row status, transcript, composer action, and relevant inspector data update. | Never announce each token. Provider event coalescing happens at browser fan-out, not by discarding native granularity. |
| success | Route/task changes settle without toast unless the action needs confirmation. | Native provider state remains source of truth; local route success alone is not task success. |
| error | Keep chrome, cached task list, draft, and navigation. Render scoped error/recovery in the failed region. | Do not replace the entire shell with a generic error for one provider failure. Provider failure isolation is required. |
| disconnected | Show one restrained persistent connectivity status; freeze provider mutations but preserve navigation, cached reads, and drafts. | Copy: `Connection lost — task status must be checked before continuing.` Reconcile `SYNC-2` before writes resume. |
| unsupported | No whole-shell unsupported state. Unsupported destinations disclose within their region. | Never redirect raw OpenAI Chat Completions as a Codex substitute. |
| destructive | Shell chrome never turns red. Destructive confirmations overlay or inline within the initiating utility and name the task/provider. | Background is inert; focus starts on `Cancel`; Escape cancels when cancellation is safe. |

## 5. Rail and task rows

Target: `TaskRail`, provider-aware task-row and section primitives. Current anchors: `App.tsx`, `ProjectsPane.tsx`, `SessionsPane.tsx`, `RecentMenu`. Governing sources: `REF-EMPTY`, `REF-ACTIVE`, `REF-RICH`, `C01`, `PRES` routes, lists, URL state, and metadata.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Compact text rows retain Codex density. Primary hierarchy is task-first; secondary destinations include `Scheduled`, `Plugins`, `Pull requests`, `Projects`, `Tasks`, and `Settings` when reachable. | Each task row includes accessible task title and provider text; provider may be visually quiet but never absent from the accessible name/details. |
| hover | Neutral row fill; reveal bounded row actions such as rename/archive in an overflow control. | Overflow is independently tabbable and labeled `Actions for {task}`; hover is not required to reach it. |
| focus | Roving focus lands on one row; focus ring is distinct from selection. | Arrow/J/K move; Home/End jump; Enter/Space open; `x` and Shift+X preserve existing selection semantics only in multi-select views. |
| selected | Measured compact selected fill, title readable/truncated, current task restored. Active work may add a quiet spinner without changing row height. | `aria-selected="true"`; full title in accessible name/tooltip. Selection does not mean a writer lease is held. |
| disabled | Rows may be `aria-disabled` only while identity/migration data is invalid. Local archive rows remain navigable for read. | Explain `Task identity is unavailable` or the exact prerequisite. Do not disable a Claude row merely because SYNC-3 is unsupported. |
| loading | List skeletons match row height; pagination appends without replacing existing rows. | Rail/list `aria-busy`; preserve active row and scroll anchor. |
| streaming | Active row shows restrained spinner and current status text in its accessible description. | Only show after authoritative turn start. Claude product status remains gated until persistent adapter is enabled. |
| success | Completed row swaps spinner for stable status without celebration or resorting unless the user's selected sort requires it. | Polite announcement: `{task title} completed`. Keep selection. |
| error | Row shows quiet error marker/text and remains openable. | Copy: `Task needs attention`; details live in task surface. Provider failure must not mark other-provider rows failed. |
| disconnected | Active row uses `Reconnecting…` only while reconnect is actually underway; stale reads remain openable. | No spinner implying work continues. Native revision reconciliation precedes send. |
| unsupported | Unsupported provider action is omitted from row overflow; task history remains readable. | Claude native archive is absent; if local archive exists label `Archive in DevHub` and explain that it does not archive Claude. |
| destructive | Archive/delete/bulk actions open explicit confirmation naming count, provider scope, and whether the provider-native record changes. | Never equate deleting DevHub cache with deleting native history. Confirmation focus starts on `Cancel`. |

## 6. Task header and provider-aware setup

Targets: `TaskHeader`, `TaskSetup`. Current anchors: `ChatPane` header, `ProjectDetailHeader`, `BranchSwitcher`. Governing sources: `REF-EMPTY`, `REF-SPARSE`, `C01`, `C05`, `AP` sections 3.1 and 3.5, `CAP` models/permissions.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Existing task: compact title plus quiet provider identity; no editable provider. New task: `New task` and an anchored compact setup popover, never a wizard or hero. | Shared setup fields: `Provider`, `Model`, `Mode`, `Project`, `Folder`; Codex then uses `Permissions`, Claude uses `Permission mode`; action `Create task`. Existing titles truncate with full accessible name. |
| hover | Header buttons and setup rows use neutral hover. Provider rows may preview selection only before creation. | Text-only providers; no OpenAI/Anthropic logos or decorative brand tiles. |
| focus | Opening setup focuses its title/first provider row; fields follow DOM order; closing restores focus to `New task`/provider trigger. | Popover has accessible name `New task setup`; arrow-key selection may supplement, never replace, Tab navigation. |
| selected | Before creation, selected provider/model/mode/project/folder/permission has textual and semantic selection. After creation, provider is locked and presented as identity, not a select. | Required disclosure: `Provider is fixed after creation. Fork to another provider to continue there.` |
| disabled | `Create task` is disabled until provider auth, project/folder, and required policy are valid. Runtime-gated selectors remain focusable explanatory rows. | Claude copy: `Claude model selection unavailable until runtime support is verified.` Codex resume/start must pass explicit permission policy. |
| loading | Provider/model inventory or folder resolution shows inline progress without clearing previous valid choices. Creation locks fields and shows progress on the primary action. | `Creating task…`; `aria-busy` on setup. Do not navigate until native ID is returned. |
| streaming | N/A in setup. Existing header may reflect selected task running status without animation beyond the shared quiet spinner. | Do not present a header-level token stream. |
| success | On authoritative native creation, close setup and navigate to the new provider-locked task. | Announce `Task created with OpenAI · Codex` or `Task created with Anthropic · Claude`. Persist native identity, not a temporary local ID. |
| error | Retain all setup choices and draft. Show scoped creation error; permit retry only after proving no native task was created or reconciling by correlation/native ID. | Copy must name provider and safe next step; never silently fall back providers. |
| disconnected | Freeze `Create task`; retain fields. | `Reconnect to create this task.` A locally filled form is not a created task. |
| unsupported | Hide unsupported permission/model choices, or show a disabled diagnostic row when the limitation is material. | Claude diagnostic labels are exactly `Requested`, `Session reported`, `Response used`, `Model differs from request`; show only for Claude model selection or detected divergence. |
| destructive | Changing folder/project may discard an unsent setup draft only if state would actually be lost; otherwise no confirmation. | Existing-task provider change is never offered, including in destructive styling. |

## 7. Provider identity and capability disclosure

Target: `ProviderIdentity` and `CapabilityDisclosure`. Governing sources: `AP` sections 1, 3.5, 4, 7; `C05`; `CAP`; `SYNC` identity.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Quiet text identity is exactly `OpenAI · Codex` or `Anthropic · Claude`; optional subdued provider dot is decorative. | Provider text is never replaced by a logo, generic `AI`, model name, or color. Include it in task accessible context. |
| hover | If identity opens details, hover only indicates interactivity; details show provider, runtime version, native ID (redacted/shortened), home label, capability status. | Tooltip must not contain secrets, full home paths when privacy mode applies, or credentials. |
| focus | Details trigger has visible focus and name `Show provider details`. | Enter/Space opens; Escape closes and restores focus. |
| selected | In pre-task provider choice only, selected identity uses `aria-checked`/`aria-selected`. Existing-task identity has no selected affordance. | Selected provider becomes immutable at native task creation. |
| disabled | Fixed existing-task identity is read-only text, not a disabled select. | Do not use disabled styling that implies it can later be changed. Show fork disclosure when relevant. |
| loading | During capability handshake, identity remains visible and detail status reads `Checking runtime capabilities…`. | Do not hide provider while model/capabilities load. |
| streaming | Identity does not animate. Runtime/model details may update response-used model as authoritative events arrive. | Claude keeps requested/session/response/billed distinctions; never overwrite requested with actual. |
| success | Capability check may show `Checked for {version}` in details. | Success is version-specific and task-home-specific. |
| error | Identity persists; detail shows `Could not verify runtime capabilities`. | Actions use conservative gate; identity must not change to another provider. |
| disconnected | Identity persists with connection state separated from provider name. | `Anthropic · Claude · Disconnected`, not `Claude unavailable` unless runtime is actually unsupported. |
| unsupported | Contextual disclosure states exact unsupported scope. | Claude: first-party app picker visibility unsupported. Codex SYNC-3: `Visible by direct task link in tested app build; sidebar discovery not verified.` |
| destructive | N/A. Provider identity is never destructive and never used as a confirmation button. | Cross-provider fork is separate and does not mutate this identity. |

## 8. Transcript, items, activity, Plan, and tools

Targets: `ThreadWorkspace`, `ActivityTimeline`, provider event renderers, and adapters over `MessageView`, `ToolGroup`, `ToolCard`, `LiveBubble`, `TurnFooter`. Governing sources: `REF-RICH`, `REF-SPARSE`, `REF-ACTIVE`, `C02`, `PRES` transcript/tool families, `CAP` stream/review/terminal, `SYNC` cache/external writers.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Assistant prose is unframed; user content may use compact right-aligned `#242424` bubbles. Consecutive native activity remains compact and chronological. Completed Plan rows expose checked/running/pending semantics. | Preserve Markdown/GFM/KaTeX, images, Bash, Edit/Write diff, Read, Grep/Glob, Task, TodoWrite, Web, unknown diagnostics. Tool summary buttons expose `aria-expanded`. |
| hover | Message/tool secondary actions (copy, permalink, expand) appear without shifting content. Tool rows use neutral hover. | Actions are also reachable on focus. Hover never marks a tool safe or approved. |
| focus | Each collapsible/activity action has visible focus. Transcript itself supports a predictable reading order and find/bookmark/error shortcuts. | Preserve Cmd/Ctrl+F, Enter/Shift+Enter match traversal, Alt+E/Alt+Shift+E errors, `[`/`]` bookmarks. Virtualization must not drop focused nodes. |
| selected | Selected find hit/bookmark/tool/file has a quiet persistent treatment distinct from focus. Expanded Plan/tool group preserves selection across streaming append. | `aria-current` for the active match, `aria-expanded` for disclosure, list semantics for Plan rows. |
| disabled | Edit/resend, regenerate, or provider mutations disable while unsafe or unsupported; reading/copying remains. | Explain capability or turn-state reason. Do not disable transcript because composer is blocked by a request. |
| loading | Initial/tail history uses content-shaped placeholders; tool subtranscript/result loads in place. | `aria-busy` on transcript or disclosure. Preserve scroll anchor during prepends. |
| streaming | Append native deltas to one in-progress assistant/item region with caret; compact activity rows may show real running state. Composer stays fixed and scrolled-up readers are never forced to tail. | One polite live region announces coarse status, not tokens. Copy may include `Working for 2m 18s`; status derives from elapsed acknowledged work, not a fabricated estimate. |
| success | Finalize the in-progress item only on authoritative completion. Tool success uses restrained `ok`/`Tests passing`; diff/goal summaries remain durable. | Example approved copy: `Read 6 files`, `Ran pnpm test`, `Edited 3 files`, `Tests passing`, `3 files changed +186 -24`. No celebration. |
| error | Preserve partial output and transcript. Show exact failed item, provider message, and safe recovery. `Retry` appears only for proved read-only/idempotent actions, paired with `Safe to retry`. | Mutation with uncertain outcome must offer `Check task status`, not blind retry. Unknown native events remain bounded raw diagnostics, never rendered as hidden reasoning. |
| disconnected | Freeze the streaming item as awaiting reconciliation; keep partial deltas and scroll position. | `Reconnecting…`; no running spinner once process state is unknown. After reconnect reread native revision before appending/continuing. |
| unsupported | Unsupported native item gets a compact disclosure or bounded raw diagnostic, not a fabricated familiar tool. | Review/diff, background, subagent, skill invocation, and artifact claims follow `CAP`. Hooks are real external activity and may be shown when observed. |
| destructive | Transcript deletion/rollback/discard is never an inline one-click activity action. Any destructive utility names the native/local scope and retains source-of-truth rules. | Hook-produced file changes are external provider activity and must not be attributed solely to DevHub. |

Plan substate mapping: pending has an empty status glyph and text; running uses the single quiet spinner and `aria-current="step"`; complete uses a check and text; failed uses an error label; omitted/unknown provider plan events are not synthesized from prose.

## 9. Composer

Target: `Composer`. Current anchor: `ChatPane` composer, `SlashPalette`, `MentionPicker`, `SnippetLibrary`, `useDraft`, and `usePromptHistory`. Governing sources: `REF-EMPTY`, `REF-ACTIVE`, `C01`, `C02`, `C03`, `PRES` Claude composer and keyboard contract, `CAP` send/interrupt/steer.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Measured 736x98 composer, 16 bottom gutter, stable provider/mode/permission footer. Existing task has fixed provider identity. New-task placeholder is `Describe the outcome or change…`. | Draft is task/provider scoped and survives navigation/reload. Textarea has an explicit accessible label, not placeholder-only labeling. |
| hover | Footer controls and send use neutral hover; attachments expose remove action. | Provider text is not a hover-only disclosure. |
| focus | Focus-within ring wraps composer without geometry change. Mention/slash/snippet pickers preserve textarea ownership. | Enter sends; Shift+Enter newline; boundary Up/Down history only while idle; mention/slash arrows, Enter/Tab, Escape preserved. |
| selected | Selected Code/Work, permission profile, or goal control exposes pressed/selected semantics. Provider remains read-only on existing task. | Values are provider-native: Codex `Workspace`; Claude `Default`, etc. Never translate permission names by string equality. |
| disabled | Send disables for empty draft, blocking request, missing writer lease, disconnected/stale revision, unsupported send, or pending creation. Text editing and draft preservation remain unless security requires otherwise. | Disabled reason is accessible. During a blocking request, announce `Respond to the request before sending.` |
| loading | Attachment upload/model inventory/lease acquisition stays local to its control. Send-in-progress becomes acknowledged streaming only after provider turn ID/event. | Never clear draft until send is accepted and correlation/native turn identity is secured. |
| streaming | Geometry is unchanged. Send becomes verified Stop in the same action slot; if queued follow-ups are supported by the active adapter, queue is a separate explicit action/state. | Stop shown only when native interrupt is product-enabled. For Claude it remains gated until M4 raw controls pass. Do not relabel a failed interrupt as success. |
| success | Clear accepted draft; retain prompt history; restore focus to textarea. Cancellation restores resting composer. | `Cancelled by you` is transcript/recovery copy, not a toast-only event. |
| error | Retain draft on send failure. If turn was accepted but stream failed, reconcile instead of resending. Attachment failures stay removable/retryable without losing text. | Copy distinguishes `Message was not sent` from `Task status is uncertain`. |
| disconnected | Textarea/draft remains editable; mutation buttons freeze. | `Reconnect to send. Your draft is saved.` Reacquire lease and reread revision before enabling send. |
| unsupported | Hide unsupported steer/queue/attachment/model actions or expose a compact reason. In degraded fallback render no composer. | PWA limits are in section 15. Raw OpenAI chat is never used as Codex send. |
| destructive | Clearing a non-empty draft or removing a completed upload asks only when content cannot be restored; Stop is interruptive, not destructive styling. | Stop has accessible name `Stop current turn`; no confirmation if provider interrupt is safely reversible by a later turn. |

## 10. Approvals, input requests, failure, reconnect, expiry, and cancellation

Targets: inline `PermissionRequest`, `InputRequest`, `RecoveryRow`. Current anchors: `PermissionCard`, `EditableApproval`, `DenyFeedback`, `TurnError`, `useApprovalKeyboard`. Governing sources: `C03` plus its correction brief, `AP` section 3.3, `CAP` approval/input rows, `SYNC` request ownership.

The current `PermissionCard` exposes `Once`, `This session`, and `Always`. **Do not expose that component unchanged in the new task surface.** The approved contract contains only provider-proved actions and explicitly forbids `Always allow`.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Requests sit inline at transcript/composer width on subtle `#262626` surfaces; no modal. Permission shows operation and exact target. Input shows question/options. | Titles: `Permission request`, `Input requested`. Include provider/task/request identity in hidden accessible description, never secrets. |
| hover | Available actions use normal neutral/primary hover; no action becomes preselected. | Hover must not imply persistent scope. No `Always allow`. |
| focus | Arrival announces but does not steal typing focus. When explicitly opened, focus lands on `Cancel` or `Deny`, not Allow. | No implicit form submission. Tab traverses request body/actions; Escape invokes Cancel only when provider cancel is supported, otherwise returns focus without deciding. |
| selected | Radio/input choice has native checked semantics; queued request has active position. No approval action is selected by default. | J/K or arrows may move queued requests; A/S/D/E shortcuts only when the adapter truthfully supports the mapped response and focus is outside typing controls. |
| disabled | All actions disabled until the selected production adapter proves the exact lifecycle. Input send disabled until a valid explicit answer exists. | `Unavailable until runtime support is verified`. Claude file Allow remains product-disabled until M4; Codex approvals/input remain gated for `0.144.1`. |
| loading | After an explicit response, lock actions and show `Sending response…` until provider resolution or timeout. | Keep request visible; correlate provider + task + turn + request ID + item ID. |
| streaming | N/A for the request control. The blocked turn may remain active but composer send stays disabled. | Never render approval as streaming acceptance. |
| success | Remove pending UI only on provider `resolved`, turn completion, or correlated acknowledgement. Restore composer focus. | Allow/Deny outcome may be recorded as restrained activity without credentials or edited sensitive input. |
| error | Keep request and chosen input if response definitively failed. If outcome uncertain, freeze and offer `Check task status`; late responses are no-ops. | Safe-read failure copy: `Read failed`, `Retry`, `Safe to retry`. Mutation failures do not expose blind Retry. |
| disconnected | Freeze all decisions and show `Reconnecting…`, `Check task status`, and `Cancel` only when cancel remains valid. | Reconnect cleanup removes stale requests after authoritative reread. Never queue an Allow across disconnection. |
| unsupported | Render a disabled specimen only in explanatory/testing contexts; in routine task use, omit unexecutable requests and show provider error/status. | Plate caption/source truth: `Proposed Claude request states — capability-gated until persistent runtime verification`. |
| destructive | Deny/Cancel are protective, not destructive. Any provider-supported broad grant is a separate high-risk confirmation and is absent until explicitly proved; `Always allow` remains forbidden. | Timeout resolves to `Request expired — no action taken`: command/file/MCP cancel, permissions empty grant, user input empty only under provider auto-resolution semantics. |

Required terminal states: `Request expired — no action taken` has no approval action; cancellation is independently `Cancelled by you` with the resting composer restored.

## 11. Inspector dock

Target: `InspectorDock` with a persistent non-tab `Environment` summary plus the five destinations `Diff`, `Files`, `Terminal`, `Browser`, and `Artifacts`. Current anchors: `DiffView`, `FileChangeSummary`, `GitPanel`, `WorktreePanel`, and repository APIs. Governing sources: `REF-RICH`, `C04`, `AP` section 3.4, `CAP` review/diff/terminal, `PRES` repository utilities.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | One measured 300-wide, content-height, rounded surface with 16 padding; compact persistent `Environment` summary, then destinations and native scroll. It is not a permanent full-height IDE pane. | `Environment` owns only backed environment/repository/subagent/source rows and is not a sixth tab. Tabs exactly `Diff`, `Files`, `Terminal`, `Browser`, `Artifacts`; footer `Availability follows the task runtime`. Named complementary landmark. |
| hover | Tabs/rows use neutral hover; file/artifact actions reveal without reflow. | No neon syntax or provider brand colors. Actions remain keyboard reachable. |
| focus | Tablist uses roving focus: Left/Right, Home/End; Tab enters selected panel. Tree/file rows use standard tree/list keyboard semantics. | `role="tablist"`, `tab`, `tabpanel`; selected panel labelled by its tab. Focus returns to inspector trigger when dock closes. |
| selected | Exactly one destination selected below the unchanged Environment summary. File/tree selection is separate and persistent. | Only the selected destination panel renders. `aria-selected`; selection does not imply provider capability. An unavailable destination may be selected to read its explanation. |
| disabled | Mutating inspector actions disable on missing lease/policy. Destination tabs remain discoverable and can show an unsupported empty state. | Disabled action exposes reason. Terminal never presents an automatic unsandboxed input fallback. |
| loading | Panel-local skeleton/output progress preserves tab strip and dimensions. | `aria-busy` on selected panel. Switching tabs does not cancel provider work unless explicitly designed. |
| streaming | Diff/file/output append in place only from real provider events. Terminal is provider-emitted output; Browser updates only from a real browser runtime. | Do not invent shell prompts. Coalesce output accessibly and preserve user scroll. |
| success | Durable summary may show `2 files · +84 -19`, `pnpm test`, `622 passed`, `Build report`, or `Screenshot` only from actual events/artifacts. | Use polite coarse completion announcement. Never use sample brief values as production data. |
| error | Panel retains prior content and shows scoped error. Read-only retry is permitted; mutations reconcile first. | `Could not load diff`, etc.; do not convert terminal errors into whole-task failure. |
| disconnected | Cached panel remains readable and marked stale; live controls freeze. | `Showing cached data — reconnect to refresh.` Revision reread precedes diff mutation actions. |
| unsupported | Panel body says `Not available for this task` with exact cause when useful. Empty Artifacts says `No artifacts`, which is distinct from unsupported. | Codex review/diff is not product-enabled from schema alone; Claude native persistent review remains gated. Browser/Artifacts follow live runtime capability. |
| destructive | Discard/unstage/worktree deletion uses explicit repository utility confirmation; never place destructive actions in the tab itself. | Name files/worktree and explain provider task is unaffected. Existing authenticated mutation boundaries remain. |

## 12. Search and Commands

Targets: separate `SearchDialog` and `CommandPalette`. Current anchors: `SearchPalette`, `CommandPalette`, `ProjectSwitcher`, `FindBar`, `ShortcutOverlay`. Governing sources: `REF-SEARCH`, `C08`, `AP` section 3.8, `PRES` Search/commands and keyboard contract.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Search is a dedicated `Search tasks and messages` dialog with focused query, Global/current-project scope, date facets, result count/status, title/project/highlighted snippet rows. Commands is separately `Search commands and tasks`. | Command actions include `New task`, `Search tasks`, `Toggle inspector`, `Open Settings`, `Go to Ops`. `Search tasks` closes Commands then opens Search. |
| hover | Result/command row gets neutral hover and becomes pointer-active without altering keyboard active item unexpectedly. | Highlighted query marks are textual/semantic, not only color. |
| focus | Open focuses query. Arrow keys move active descendant; Enter opens/runs; Escape closes and restores invoker. Focus remains inside dialog. | Use dialog title, combobox/searchbox, listbox/option or an equally valid accessible command pattern; announce result count. |
| selected | Keyboard-active row is distinct from current scope/date selection. Opening a result navigates to provider-locked task and highlighted message. | `aria-activedescendant` or roving focus; scope uses pressed/radio semantics. |
| disabled | Project scope disables only when no project is active and explains why. Commands failing capability prerequisites are hidden or explanatory-disabled. | Do not show a command that silently invokes another provider. |
| loading | Search keeps query/facets visible with `Searching…`; commands normally filter locally without loading. | Debounced requests cancel stale reads; `aria-busy` and polite result status. |
| streaming | N/A. Search results update as complete bounded result sets, not token streams. | Live index progress may appear separately and must not steal focus. |
| success | Results show count and keyboard-selected first row without auto-opening. Command closes before action mutates state. | Footer: `↑↓ navigate`, `↵ open`/`↵ run`, `esc close`. |
| error | Search shows a distinct error state inside the same dialog and retains query/facets; it must not collapse to `No results`. | Offer read retry. Commands report action failure in the destination/toast with focus restored. |
| disconnected | Local command filtering remains; provider/index-dependent Search reports offline/stale status and may show cached results explicitly. | Opening cached result is read-only until task reconciliation. |
| unsupported | Provider-specific commands follow runtime capability; Search itself remains provider-neutral across indexed tasks. | Degraded history results carry `Read-only fallback`; raw OpenAI sessions are not labeled Codex. |
| destructive | Destructive commands never execute from row selection alone; selection opens the same explicit confirmation as the destination surface. | Command label includes target scope. Focus starts on confirmation Cancel. |

## 13. Settings and secondary utilities

Targets: provider-aware `Settings`, Ops, Inbox, Dashboard, config and maintenance utilities. Current anchors: `SettingsPane` and `components/config/*`, `LiveOpsBoard`, `InboxPane`, `DashboardPane`. Governing sources: `C08`, `AP` sections 3.8 and 6, `PRES` routes/config/maintenance/persistence.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Settings uses simple groups such as `Appearance`, `Providers`, and `Permissions`; all current preferences, budgets, memory, MCP, hooks, webhooks, agents, skills, plugins, integrity, index, and archive workflows remain reachable. Ops/Inbox/Dashboard stay secondary utilities, not task-home cards. | Provider-specific fields are explicitly grouped/labeled. Preserve old key/env/schema readers during migration. |
| hover | Neutral row/control hover; no decorative dashboard lift. | Secondary navigation remains keyboard reachable. |
| focus | Form labels are programmatically bound; section navigation uses tab/list semantics; focus moves to section heading on route change only when user initiated. | Cmd/Ctrl+, may open Settings once implemented; approved Commands must expose `Open Settings`. |
| selected | Current section/field choice has semantic selection. Provider settings never imply global equivalence across provider vocabularies. | Use `aria-current`/`aria-selected`; full provider/version in capability details. |
| disabled | Save/mutations disable while pending or when route/capability is absent. Read-only inventory remains readable. | Explain exact runtime/version gate. Claude skill/plugin inventory may render; unproved invocation/mutation stays absent. |
| loading | Section-local loaders retain navigation and labels. | `aria-busy` on section; never flash an empty unsupported state before capability fetch completes. |
| streaming | Ops may update real running statuses; hooks/index progress may stream coarse events. Settings forms do not stream. | Status is provider-scoped; no whole-dashboard claim of background work. |
| success | Persisted save shows restrained `Saved`; maintenance results report exact scope. | A browser-local save is labeled local. Provider config success requires provider/server acknowledgement. |
| error | Retain dirty form fields and show field/section error. Other Settings sections remain usable. | Never log/display tokens. Provide bounded retry for reads/saves with known failure. |
| disconnected | Local preferences remain editable when safely local; provider/server mutations freeze. | Clearly distinguish `Saved in this browser` from `Not synced`. |
| unsupported | Unsupported provider settings are absent or read-only with reason, not mapped to approximate settings. | Claude archive is local additive metadata; first-party picker visibility is unsupported. Codex experimental features do not appear as stable toggles. |
| destructive | Reindex/repair/export/import, permission changes, webhook delete, discard, and archive actions state affected store/provider and reversibility. | Cache/database deletion never calls provider delete. Confirm high-impact operations; focus Cancel; no credentials in summaries. |

## 14. Cross-provider fork

Targets: `CrossProviderForkReview`, `HandoffPreview`, additive fork provenance. Governing sources: `C06` production clarification (which supersedes generated permission copy), `AP` section 3.6, `SYNC` identity/cache rules, `CAP` fork rows.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Three stages: unchanged source, reviewed handoff preview, new native target. Entry action is `Create cross-provider fork`. Preview shows source/target, requested model, mode, folder, target-native permission, transferred context, locked exclusions, and attributed body. | Required disclosures: `The source task remains unchanged. A new native task will be created.` and `The resulting link is local to DevHub.` |
| hover | Review rows/actions use neutral hover. Locked exclusion rows do not look selectable. | Exclusions are text/status, never checkboxes. |
| focus | Dialog traps focus; heading first on open; Tab reaches review then `Cancel` and `Create fork`; closing restores invoker. | Source/target provider and IDs are included in accessible summary. |
| selected | Target provider/model/mode/folder/permission and explicitly included review categories expose selection. Exclusions remain immutable. | The target decides vocabulary: Claude uses `Permission mode` and an installed Claude value (the approved specimen uses `Default`), while Codex uses `Permissions` and an installed Codex permission profile. Never cross-map labels or values. |
| disabled | `Create fork` disables until target auth/runtime/start capability, redaction, required review, and a stable source revision pass. | Explain missing prerequisite. Provider-native same-provider fork continuation is irrelevant: this flow starts a new native task with the other provider; same-provider native fork actions follow a separate capability. |
| loading | During redaction/preview, show bounded review progress. During creation, lock inputs and primary action; source remains readable and unchanged. | `Creating new [target provider identity] task…`; do not display a target ID before that provider returns it. |
| streaming | No transcript stream in preview. After target creation/navigation, the target follows normal streaming rules. | Handoff body is a reviewed complete context item, not hidden-reasoning stream. |
| success | Navigate only after new native target ID and attributed handoff persist. Add DevHub-local backlink/provenance without mutating source. | Target shows `Forked from [source provider identity]` and `Linked by DevHub`; first body starts `Handoff from [source provider identity] task [source native ID]`. OpenAI-to-Claude is the approved visual specimen, not a directional restriction. |
| error | Source remains byte-for-byte unchanged. Preserve preview. Before retry, reconcile whether a target was created using operation correlation/native IDs. | `Could not confirm whether the target task was created — check task status.` Never create duplicates blindly. |
| disconnected | Freeze creation and retain preview. If disconnect occurs after submit, reconcile target existence before enabling retry. | No offline/local pseudo-fork. |
| unsupported | Hide flow unless target provider can create a native task and source context can be safely reviewed. Explain provider/runtime issue from capability truth. | Never present a provider switch, move, merge, or same-session continuation. |
| destructive | Fork itself is non-destructive. `Cancel` discards only the local preview. Any later target deletion is a separate provider-aware destructive flow. | Confirmation copy must never imply the source will be replaced. |

Transferred context allowlist: user messages, goal summary, selected files, reviewed tool outputs. Mandatory locked exclusions: secrets and auth, hidden reasoning, approval credentials, unreviewed sensitive tool output. Visible redaction markers replace excluded content; excluded contents never enter the browser preview.

## 15. DevHub Work

Targets: Work mode composer choice, outcome strip, `WorkInspector`. Governing sources: `C07` and correction brief, `AP` section 3.7, `CAP` background/skills/subagents, `PRES` utilities.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | `DevHub Work` is a provider-neutral outcome/deliverable mode using the real selected runtime. Transcript stays primary; measured narrow outcome card and content-height inspector remain secondary. | Never use `Cowork`. Show fixed `Anthropic · Claude`/`OpenAI · Codex`, real folder scope, provider-native permission mode, and `Code`/`Work`. |
| hover | Code/Work and deliverable rows use neutral hover; no card lift or KPI treatment. | Work remains a mode choice, not provider choice. |
| focus | Code/Work is an accessible radio/toggle group; outcome/progress/deliverable details follow transcript in reading order. | Arrow keys may switch pre-task mode; existing task mode changes follow explicit task semantics and do not change provider. |
| selected | `Work` visibly and semantically selected. Outcome row may show `Outcome`, goal text, and `3/5`; statuses are `Ready`, `In progress`, `Pending`. | Example scope for Claude: `Folder scope` / `…/active/claude-ui`, `Permission mode` / `Default`. |
| disabled | Work disables until `workMode` flag, real provider send, folder scope, permission policy, and deliverable persistence pass. | Explain `Work mode is not available for this runtime yet.` Do not substitute background jobs. |
| loading | Outcome/deliverables load in place; starting Work task follows normal native creation. | `aria-busy` on outcome/inspector, not transcript. |
| streaming | Real narrative and compact tool rows stream normally. Outcome progress changes only on persisted/authoritative step updates. | Example activity (`Checked package outputs`, etc.) must come from real events, not canned copy. |
| success | Deliverable becomes `Ready` only when its artifact/verification exists. Outcome complete uses restrained text/check. | No celebration, confetti, or claim that work continued offline. |
| error | Failed step/deliverable retains prior output and names recovery. Overall task may continue. | No dashboard-wide failure. Mutation retry obeys reconciliation rules. |
| disconnected | Freeze progress and new mutations; retain outcome, deliverables, transcript, and draft. | `Progress paused while task status is checked.` Never imply background continuation. |
| unsupported | Hide background/subagent controls and any Cowork interoperability. Inventory may render separately when verified; invocation is gated. | Claude `--bg` is not a supported persistent JSON supervisor; Codex background/experimental schema is not a product claim. |
| destructive | Removing a deliverable link affects only additive metadata unless an explicit file action says otherwise. Cancel/stop follows normal interrupt semantics. | Any file deletion/discard uses repository destructive flow and names exact scope. |

## 16. Responsive shell and PWA

Targets: wide/minimum/narrow `DevHubShell`, rail sheet, inspector trigger, read/reply PWA. Current anchor: `ResponsiveShell`. Governing sources: `AP` section 5, `C08`, `PRES` responsive and desktop/TUI contracts.

| State | Required rendering and allowed action | Copy, accessibility, and provider/version rule |
|---|---|---|
| rest | Wide uses measured shell. Below 1024 px preserve existing one-pane browse drill-down until M6 tests lock exact minima. Proposed narrow task view uses slim/collapsed rail or accessible sheet, transcript primary, inspector behind explicit control, no horizontal overflow. PWA supports task read/reply and safe navigation. | PWA is not native mobile. Preserve `Projects → Sessions → Transcript` breadcrumb semantics where legacy browse remains. |
| hover | Pointer hover only on devices that support it; never required on touch. | All hover-revealed actions have persistent/focus/touch equivalents. |
| focus | Opening rail/inspector sheet moves focus to its heading/first item, traps appropriately, and restores trigger. Viewport changes never strand focus in hidden content. | Back/crumb controls have names; logical DOM order does not follow visual reordering incorrectly. |
| selected | Current narrow pane/sheet destination uses current-page/selected semantics. Hidden inspector selection persists when closed. | No duplicate selected routes between hidden desktop rail and visible sheet. Hidden duplicate controls are inert. |
| disabled | Desktop-only inspector actions may be explanatory-disabled in PWA. Reply disables under normal composer gates. | Required copy: `Desktop required for terminal and diff`. Do not render elevated permission actions in PWA. |
| loading | Preserve active pane and header; skeleton only its content. Sheets do not open automatically on load. | `aria-busy` scoped to pane. Avoid layout shift and horizontal overflow at all supported widths. |
| streaming | Transcript may stream/reply within supported PWA scope; composer remains anchored without covering the focused line/input. | No forced autoscroll; reduced-motion respected. Streaming support still follows provider adapter gate. |
| success | Reply completion updates transcript and status without navigation. Viewport rotation/resize preserves route, draft, and reading position. | No native push/offline/background success claim. |
| error | Retain read content and draft; show scoped retry/status. | Network loss is not `No results` or task failure. |
| disconnected | PWA becomes cached-read/draft mode only when data is actually available; send freezes. | `Reconnect to send. Your draft is saved.` No offline task execution. |
| unsupported | Terminal, diff, elevated permissions, native mobile, offline operation, push, background work, and full desktop parity are excluded. | Use the desktop-required disclosure; do not show inert full desktop controls squeezed into mobile. |
| destructive | Destructive repository/provider actions are absent from PWA unless separately proved with full confirmation, auth, and recovery. Local draft clear uses the standard recoverability rule. | Narrow sheets never place destructive action where the system Back gesture can trigger it. |

## 17. Implementation assertions and test hooks

Each family must ship with stable role/name/state selectors; tests should prefer accessible role and name over styling classes. At minimum, fixtures and browser tests must assert:

1. every state in this matrix has a deterministic fixture or an explicit `N/A` assertion;
2. provider/version capability changes remove or explain controls without changing provider identity;
3. focus, selection, disabled, and unsupported remain distinguishable in dark/light themes and forced-colors mode;
4. all overlays restore focus, inline requests do not steal focus, and no hidden narrow/desktop duplicate remains tabbable;
5. reduced motion covers rest → loading/streaming → success/error, reconnect, interruption, and reversal;
6. timeout never emits Allow; late request responses are no-ops;
7. a disconnect after a mutation submit requires reconciliation before retry;
8. Search and Commands stay separate and `Search tasks` transfers focus correctly;
9. existing transcript, composer, metadata, config, utility, URL, localStorage, TUI, and desktop contracts in `PRES` remain reachable until their side-by-side gates pass;
10. no browser state, URL, accessible description, fixture, screenshot, log, or telemetry contains provider credentials, approval credentials, hidden reasoning, or excluded handoff content.

This matrix is version-specific where it references provider behavior. A runtime binary/app change invalidates positive capability presentation until the reprobe ledger is updated; visual design remains locked, but actions conservatively fall back to safe read/unsupported states.
