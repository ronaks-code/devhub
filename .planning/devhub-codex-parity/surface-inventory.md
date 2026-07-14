# DevHub Surface Inventory

Status: **locked after user approval of the recommended DevHub direction on 2026-07-12**. This is an implementation contract, not evidence that an unimplemented or provider-gated control already works.

This inventory connects every current, preserved, and approved-new web surface to an owner, governing visual source, exact static copy, provider/metadata authority, Radix-backed shadcn substrate, feature flag, responsive rule, data dependency, and cutover gate. The real Codex captures outrank generated concepts for observed surfaces. The production clarifications outrank malformed generated text. Provider capability truth outranks both.

Frontend owner paths in the tables are relative to `apps/web/src/` unless an absolute package path is written explicitly.

## 1. Reading rules

### Surface status

- **Observed**: visible in a captured first-party Codex build.
- **Current**: implemented in the present DevHub repository.
- **Preserved**: current behavior/data that may move or restyle but may not disappear.
- **Approved-new**: approved DevHub-only behavior; it is not a claim about Codex or Claude first-party UI.
- **Conditional**: render or enable only when the selected provider/version reports and passes the named capability gate.
- **Degraded**: read-only fallback; never a native execution path.

### Governing-source keys

| Key | Source |
|---|---|
| `R-complete` | `reference-captures/chatgpt-current-1800x1130.png` |
| `R-sparse` | `reference-captures/chatgpt-devhub-sync3-thread-1800x1130.png` |
| `R-active` | `reference-captures/chatgpt-active-goal-1800x1130.png` |
| `R-empty` | `reference-captures/chatgpt-empty-task-1800x1130.png` |
| `R-search` | `reference-captures/devhub-current-search-results.png`; preservation authority for Search behavior only |
| `C1` | `concepts/01-new-task-empty.png` + `01-new-task-empty-brief.md` |
| `C2` | `concepts/02-active-plan-tools.png` + `02-active-plan-tools-brief.md` |
| `C3` | `concepts/03-intervention-states-corrected.png`, initial concept's independent cancellation tile, and both intervention briefs |
| `C4` | `concepts/04-inspector-dock.png` + `04-inspector-dock-brief.md` |
| `C5` | `concepts/05-provider-setup.png` + `05-provider-setup-brief.md` |
| `C6` | `concepts/06-cross-provider-fork.png` + governing production clarification `06-cross-provider-fork-brief.md` |
| `C7` | `concepts/07-work-mode-corrected.png` + correction brief |
| `C8` | `concepts/08-command-responsive.png` + governing production clarification `08-command-responsive-brief.md` |
| `P0` | `preservation-matrix.md` and current source/tests |

### Copy notation

- Text in backticks is exact, allowed visible chrome copy.
- Bracketed values such as `[task title]`, `[model]`, `[count]`, and `[provider output]` are dynamic data, not additional static copy.
- User messages, assistant prose, file content, terminal output, diff content, project names, task names, provider-returned model names, native IDs, and paths are data. They are not constrained to a fixed phrase list, but their labels and provenance are.
- Generated misspellings, invented rail labels, oversized concept titles, the stray concept-1 `Codex` wordmark, concept-4 malformed tabs, concept-6 `Permissions / Workspace` for Claude, and corrected-concept-3's repeated expiry-as-cancellation tile are explicitly rejected.
- Accessible names may add context without becoming visible copy; they must still use the same nouns as this inventory.

### Cutover-gate keys

| Gate | Required evidence |
|---|---|
| `F` | Real workflow and deterministic fixture coverage are side-by-side green. |
| `P` | Persisted URL/localStorage/SQLite/native-session behavior survives restart and rollback; old readers still work where required. |
| `R` | Crash, reconnect, stale revision, writer lease, and external mutation behavior are proven where the surface writes native state. |
| `S` | Capability, auth, approval, redaction, origin, and secret-handling tests pass; unsupported actions are absent or disabled honestly. |
| `V` | Browser/IAB workflow, current/minimum/narrow viewport, keyboard, accessibility, exact-copy, and governing-image fidelity gates pass. |
| `D` | The replacement is enabled under its flag, telemetry/diagnostics show no fallback dependence, and all imports/callers of the legacy path are gone. |

No legacy surface is deleted on a subset of these gates. `apps/web/src/components/ui.tsx` is removed only after `D` proves zero imports.

## 2. Identity and metadata authority

### Provider identity locations

Provider is immutable after native task creation.

| Location | Required treatment |
|---|---|
| Task-rail row | Quiet visible suffix `Codex` or `Claude`, plus accessible full name `OpenAI · Codex` or `Anthropic · Claude`; text only, no generated or imitation logo. |
| Task header | Full quiet identity `OpenAI · Codex` or `Anthropic · Claude`, adjacent to but visually secondary to `[task title]`. `DevHub Work` may follow only when Work mode is active. |
| New-task setup | Full provider names in the provider picker and the permanent-lock disclosure. |
| Composer footer | Full fixed provider identity for an existing task; never an editable provider picker. New-task composer may open provider setup before creation. |
| Search result | Quiet `Codex` or `Claude` provenance derived from the composite task key; never inferred from model text. |
| Inspector/request/fork surfaces | Full identity wherever an action can affect provider-native state. Fork preview shows both source and target identities. |

The shell is always branded `DevHub`. Top-level navigation is provider-neutral; the current `Claude` and `OpenAI` rail sections are legacy organization, not the target information architecture.

### Authority table

| Field or behavior | Authority | Required presentation |
|---|---|---|
| Provider, effective native home, native task/turn/item/request IDs | Provider-native contract | Never editable after creation. Composite key includes provider. Native ID may appear in diagnostics/fork preview. |
| Native title, lifecycle status, turns, messages, plans, tool events, hooks, skills, plugins/apps, MCP, terminal/diff/browser/artifact events | Provider-native contract | Render the provider event; unknown events retain a bounded raw diagnostic envelope. Do not manufacture activity. |
| Requested model, session/init model, response-used model, billed model | Provider-native request/events | Keep distinct. Show `Requested`, `Session reported`, `Response used`, and `Model differs from request` only when relevant. |
| Reasoning effort and permission profile/mode | Provider-native vocabulary and capability probe | Never normalize Codex and Claude by string equality. An unavailable choice is hidden/disabled with an explanation. |
| Folder/cwd, git branch/status, provider-emitted changes | Native task plus explicit repository APIs | Label the source; do not imply an unsandboxed shell was run by the UI. |
| Favorite, pin, tags, notes, bookmarks, local label, read/replay/minimap state | DevHub-local additive metadata or UI preference | Never presented as provider state. Must survive the M5 provider-dimension migration. |
| Claude archive, provider-fork backlink, `Linked by DevHub`, triage-cleared state | DevHub-local additive metadata | Say `local` where provider support is absent. Never mutate/recreate the native source to simulate it. |
| Search index, analytics, recent list, cached projection | Rebuildable DevHub projection | May be stale/offline; invalidates against native revision. Never becomes transcript authority. |
| Theme, density, reduced motion, rail/inspector visibility, draft, prompt history, search scope | DevHub UI preference | Dual-read `claude-ui:*`, write `devhub:*` after migration, preserve rollback read. |
| Credentials, provider tokens, approval credentials | Backend/provider only | Never enter browser state, URLs, copyable diagnostics, screenshots, fixtures, or telemetry. |

## 3. Route and destination inventory

The current router is query-state based: `?tab=&project=&session=`. All nine current tab values remain readable. M5 adds an unambiguous provider dimension to native task URLs while retaining the old reader; the exact encoding belongs to the task-key migration, not to visual code. Browser `popstate` and transcript hashes remain supported.

| ID | Route/destination and status | Current owner -> target owner | Governor / copy set | Provider identity and primitive substrate | Flag / milestone / responsive behavior | Persistence and API dependency | Deletion or cutover gate |
|---|---|---|---|---|---|---|---|
| `RT-01` | `?tab=home`; Current + Preserved secondary overview | `HomePane.tsx` -> bounded utility route composed by `DevHubShell` | `P0`; `L-home` | Provider-labelled data rows; shadcn `Button`, `Empty`, `Skeleton`, `Separator`; cards may remain only because this is the preserved analytics utility, never the primary task shell | Always reachable; provider-aware quick start lands in new-task setup in M6. Narrow becomes one scroll column | `/api/projects`, per-project sessions, `/api/codex/sessions`, `/api/codex/stats`; projections only | Keep route until information, provider provenance, quick start, empty/loading/error, and restart behavior pass `F/P/V`; remove legacy `New Claude Session` copy only after provider-aware creation passes `F/S/V` |
| `RT-02` | `?tab=browse&project=&session=` plus message hash; Current + Preserved history/browser | `ProjectsPane`, `SessionsPane`, `ResponsiveShell`, `ProjectDetailHeader`, `TranscriptPane`, `ProjectOverview` -> `features/tasks` index + `ThreadWorkspace`, retaining renderer adapters | `P0`, `R-complete`, `R-search`; `L-browse`, `L-transcript` | Each row gains true provider suffix; `Sidebar`/list buttons, `ContextMenu`, `DropdownMenu`, `Badge`, `Tooltip`, `Collapsible`; native transcript scroll stays virtualized, never `ScrollArea` | Existing one-pane drill-down below 1024 px remains until M6 replacement passes; wide primary task shell under `codexStyleShell` | Projects/sessions/messages/overview, session PATCH, notes/tags/autotag, git/files, local bookmarks/read mode; M5 unified index/native read | No pane or URL reader deleted until direct URL/hash, filters, metadata, long-transcript anchor, responsive drill-down, provider dimension, rebuild and rollback pass `F/P/R/V/D` |
| `RT-03` | `?tab=chat`; Current Claude live route + Preserved fallback | `ChatPane.tsx` -> `ThreadWorkspace` + `Composer` backed by `PersistentClaudeAdapter`; `LegacyClaudeAdapter` remains side-by-side | `P0`, `R-active`, `C2`, `C3`; `L-chat` plus target task copy sets | Header/composer show `Anthropic · Claude`; `InputGroupTextarea`, `Button`, `Popover`/`Command`, `Select`, `ToggleGroup`, `Collapsible`, inline `Alert`/request components | `persistentClaude` M4, visual migration under `codexStyleShell` M6. One transcript/composer column on narrow | Native Claude CLI events/control plus attachments/files, drafts/history/snippets; legacy `/api/ws/session` until parity | Legacy route/process-per-turn deleted only after raw persistent CLI multi-query, resume, permission response, interrupt, post-interrupt resume, capability honesty and `F/P/R/S/V/D` pass |
| `RT-04` | `?tab=ops`; Current + Preserved secondary utility | `LiveOpsBoard`, `MultiSessionGrid` -> `features/ops/OpsRoute` behind secondary navigation | `P0`, `C8`; `L-ops` | Every live row/panel shows provider; `Tabs`, `Button`, `DropdownMenu`, `Empty`, `Badge`, `Tooltip`; grids are allowed here as preserved utility, not in core task UI | Always reachable; relocated under secondary navigation in M6-M8. Narrow stacks or opens one panel at a time | `/api/running`, existing live session WS, process-stop route; provider-native status required | Do not remove board/grid or six-panel capability until real multi-provider status/open/send/stop and narrow tests pass `F/P/R/S/V/D` |
| `RT-05` | `?tab=inbox`; Current + Preserved triage utility | `InboxPane.tsx` -> `features/inbox/InboxRoute` | `P0`, `C8`; `L-inbox` | Provider suffix per row; local tags/pin/notes/archive are explicitly DevHub metadata. `Button`, `InputGroup`, `Badge`, `DropdownMenu`, `Empty` | Always reachable; secondary navigation M6-M8; single list at narrow width | `/api/all-sessions`, session PATCH; optimistic cleared IDs are UI-only | Current archive bug must be fixed; provider-dimension/local-archive labels and metadata restart round-trip must pass `F/P/V/D` |
| `RT-06` | `?tab=dashboard`; Current + Preserved analytics utility | `DashboardPane` + dashboard modules -> `features/analytics/DashboardRoute` | `P0`; `L-dashboard` | Provider facets/source caveats on analytics. shadcn `Tabs`, `ToggleGroup`, `Table`, `Progress`, `Empty`, `Skeleton`; existing charts stay native | Always reachable; secondary destination only. One-column/natively scrollable narrow layout | stats, rollups, tool stats, budgets, projects/git/running projections | Never move dashboard cards into task shell. Route survives until all current sections, provider dimensions, error/empty states and real links pass `F/P/V/D` |
| `RT-07` | `?tab=settings`; Current + Preserved configuration | `SettingsPane` + `components/config/*` -> `features/settings/SettingsRoute` with provider-specific panels | `P0`, `C8`; `L-settings` | Provider selector/scoping is explicit. `Tabs`, `FieldGroup`, `Field`, `FieldSet`, `Select`, `Input`, `Switch`, `Button`, `Alert`, `Progress`, `Table`, `Dialog`; no generic form cards | Always reachable. Narrow uses slim/sheet navigation, one field group column, no horizontal overflow | settings/budget/config/MCP/hooks/webhooks/permissions/agents/skills/plugins/index/archive APIs; browser connection prefs local | No config writer or section removed until provider support is labelled, every write round-trips, narrow/a11y passes, and old settings remain readable: `F/P/S/V/D` |
| `RT-08` | `?tab=openai-chat`; Current dirty raw experiment | `OpenAIPane.tsx` + raw OpenAI server path -> quarantined `features/raw-openai/ChatOnlyRoute` or later removal | `P0`; `L-raw-openai` | Must say `OpenAI Chat — development only`; must never say Codex. `Alert`, `InputGroupTextarea`, `Select`, `Button`; local tool controls absent/disabled by default | Development-only flag, M2-M3; supported viewports only while retained | `/api/openai/*`, WS, local cwd preference; local bash/read/write default-disabled | Never fallback for Codex. Retain/remove decision only after native Codex slice. Removal requires no consumer and explicit data decision; until then quarantine/security tests `F/S/D` |
| `RT-09` | `?tab=codex-history`; Current read-only fallback | inline `CodexHistoryPane` -> `features/history/CodexHistoryFallbackRoute` | `P0`; `L-codex-fallback` | `OpenAI · Codex`; `Empty`, `Skeleton`, list rows, `Badge` | Degraded badge/description in M3; secondary only | `/api/codex/sessions`, `/api/codex/stats`, read-only rollout parser | Keep only as degraded fallback after native history is green; may be removed only after native list/read/restart/schema-mismatch and fallback-off diagnostics pass `F/P/R/D` |
| `RT-10` | Provider-native primary task URL; Approved-new extension of legacy query state | `features/tasks` route composition in `App.tsx` -> `DevHubShell` / `ThreadWorkspace` | `R-complete`, `R-active`, `R-empty`, `C1-C5`; `T-shell`, `T-rail`, `T-header`, `T-empty`, `T-setup`, `T-thread`, `T-active`, `T-composer`, `T-intervention`, `T-inspectors` | Full identity in header/composer, row suffix in rail; shell/task primitives below | `nativeCodex`, `persistentClaude`, `unifiedTaskIndex`, then `codexStyleShell`; M3-M6. Wide measured shell; narrow one-pane; PWA read/reply subset | provider task API/WS, composite task key, native revision/lease, local UI state | Becomes default only after both native vertical slices, URL migration, restart/recovery, shell fidelity, Search/Commands and preserved-route reachability pass `F/P/R/S/V`; legacy URLs never become unreadable |
| `RT-11` | Cross-provider fork flow; Approved-new, not a provider switch | `features/fork/*` | `R-sparse`, `C6`; `T-fork` | Both full provider identities; custom inspector-region preview composed from `FieldGroup`, `Separator`, `Alert`, `Button`; not desktop `Sheet` and not `AlertDialog` | `crossProviderFork`, M7. Full preview fits wide; narrow uses titled `Dialog`/single-column review | redaction/allowlist service, two adapters, new native target ID, additive local bidirectional link | Hidden until source immutability, redaction, target-native creation, attributed handoff, rollback and fork continuation gates pass `F/P/R/S/V` |
| `RT-12` | DevHub Work; Approved-new provider-neutral mode | `features/work/*` | `R-active`, `C7`; `T-work` | Header full provider identity + `DevHub Work`; `ToggleGroup`, `Progress`, `Badge`, `Collapsible`, inspector rows | `workMode`, M7. Transcript primary; narrow inspector becomes titled overlay; PWA safe read/reply only | real provider adapter, folder scope, provider-native permission mode, additive outcome/deliverable projection | Hidden until real runtime, folder enforcement, permission semantics, progress/artifacts and no-background-claim tests pass `F/P/R/S/V`; never labelled Cowork |

## 4. Primary shell and task-family inventory

| ID | Surface/status | Owner target | Governor / exact copy set | Provider/metadata rule | shadcn/Radix substrate | Flag/milestone + responsive rule | Data/API dependency | Cutover gate |
|---|---|---|---|---|---|---|---|---|
| `SF-01` | Application shell/chrome; Observed skeleton + Approved DevHub identity | `features/shell/DevHubShell.tsx` | `R-*`; `T-shell` | Product is `DevHub`; no provider in global brand | Custom layout + `Sidebar`, `Separator`, `Tooltip`, `Button`; custom audited Radix preset only | `codexStyleShell`, M6; 273-unit rail and 46-unit header at reference width; no horizontal overflow | route state, feature flags, UI prefs | Existing `TopBar`/fixed nav stay until all routes and global shortcuts pass `F/P/V/D` |
| `SF-02` | Task rail groups, rows, selection, status, context actions; Observed + provider addition | `TaskRail.tsx` | `R-complete`, `R-active`, `R-empty`; `T-rail` | Each task row derives provider from composite key; local pin/favorite/labels are additive. Active spinner comes from native status | shadcn `Sidebar` without cookie persistence/shortcut; `Collapsible`, `ContextMenu`, `DropdownMenu`, `Tooltip`, native scrolling | `codexStyleShell` + `unifiedTaskIndex`, M5-M6; wide 273; narrow collapsed strip or accessible titled `Sheet`; PWA navigation screen | task list projection, native status/revision, local metadata | Context/menu/search/collapse/resizing not claimed observed; advance only after behavior/a11y/visual tests. Delete old nav only on `F/P/R/V/D` |
| `SF-03` | Task header; Observed + provider addition | `TaskHeader.tsx` | `R-sparse`, `R-empty`; `T-header` | Native title/status; full provider identity; local fork/work label explicitly additive | `Button`, `DropdownMenu`, `Tooltip`, `Badge` only when semantically needed | M6; 46 high wide, truncates before overflow. Narrow keeps title, back, provider, and overflow | native task summary, rename/archive capabilities, local links | Rename/archive/fork actions capability-gated. Old headers remain until exact title truncation/focus/menus pass `F/P/R/S/V/D` |
| `SF-04` | Empty existing native task; Observed | `ThreadWorkspace.tsx` | `R-empty`; `T-empty` | Existing native task; provider identity still in header/composer | `Empty` is **not** used: the observed center stays blank. Only composer/inspector render | M6; preserve intentional negative space at all desktop widths | native task with zero turns | Any welcome/suggestion/onboarding card is a hard visual failure. Gate `F/V` |
| `SF-05` | New-task setup; Approved-new | `features/providers/TaskSetup.tsx` + `Composer.tsx` | `C1`, `C5`; `T-setup` | Provider chosen once; provider lock disclosure mandatory; provider-specific models/modes/permissions | `Popover` + `Command`/Combobox for searchable provider/model/project/folder; `Select` only for short static lists; `ToggleGroup`; `FieldGroup`; `Button` | M6 after M3/M4 capabilities. Compact anchored popover wide; titled `Dialog` at narrow; never a wizard/dashboard | provider capabilities/models, projects/folders, resolved auth, startTask | Create disabled until required values and runtime are valid. No provider change after creation. `F/P/R/S/V` |
| `SF-06` | Thread transcript: user bubbles, unframed assistant prose, Markdown/code/images; Observed + Preserved renderers | `ThreadWorkspace.tsx` plus existing renderer adapters | `R-complete`, `R-sparse`; `T-thread`, `L-transcript` | Provider-native ordered content; hidden reasoning remains hidden; local permalink/bookmark labels remain local | Semantic markup, existing Markdown/tool renderers, `Button`, `Tooltip`, `Badge`; **native virtualized scroll, never `ScrollArea`** | M3-M6; 736-unit content column wide, full available width with safe gutters narrow | normalized events/native read, attachments/assets, local metadata | Current renderer deleted only when provider fixture corpus, unknown-event diagnostics, long-anchor and copy/fidelity pass `F/P/R/S/V/D` |
| `SF-07` | Streaming, reasoning disclosure, Plan, tool/activity rows, completed state; Observed active language + Approved plan detail | `ActivityTimeline.tsx` | `R-active`, `C2`; `T-active` | Every row comes from native event and carries native status; no invented parallel/background work | Independent `Collapsible` sections, `Progress`, `Spinner`, `Badge` where semantic, `Alert` for persistent errors | M3/M4 data, M6 visuals; append inline without layout jump; reduced motion removes nonessential animation | provider event subscription/replay | Each provider enables only proven event families; start/mid/end/interruption/replay tests and `F/R/S/V` |
| `SF-08` | Stable composer: rest/focus/multiline/attachment/send/queue/steer/stop/disabled | `Composer.tsx` | `R-complete`, `R-active`, `R-empty`, `C1-C3`; `T-composer`, `L-chat` | Provider fixed; model/mode/permission from provider capabilities; stop invokes real interrupt; attachment is DevHub-owned input | `InputGroup` + `InputGroupTextarea` + `InputGroupAddon`, `Button`, `Popover`/`Command`, `ToggleGroup`, `Tooltip`; no raw input controls | M3/M4 then M6; 736x98 and 16 bottom gutter wide; stable geometry on send->stop; full-width safe gutters narrow/PWA | draft/history/attachments, provider send/steer/interrupt, capability state | No inert stop/steer/approval. Legacy composer retained until typing, queue, attachments, menus, interrupt, reconnect and `F/P/R/S/V/D` pass |
| `SF-09` | Diff summary pill + Goal/Outcome strip; Observed goal family + Approved Work variant | `ActivityTimeline.tsx` / `Composer.tsx` | `R-active`, `C2`, `C7`; `T-active`, `T-work` | Diff count provider/repository-derived; goal may be provider-native; outcome/deliverables are explicitly DevHub Work metadata | `Button`, `Progress`, `Collapsible`, compact custom strip; not a dashboard card | M6-M7; immediately above composer, narrow single line then disclosure | provider diff/goal events; Work projection | Hide if source absent. Exact geometry/content provenance and `F/P/V` |
| `SF-10` | Permission request, user input, failure, retry, reconnect, expiry, cancellation; Approved-new Conditional | `features/thread/requests/*` | `C3`; `T-intervention` | Request key includes provider/task/turn/request/item. Late/stale response no-op. Timeout never accepts | Inline custom request surface using `FieldGroup`/`FieldSet`, `RadioGroup`, `Button`, `Alert`, `Spinner`; **never modal `AlertDialog`** | M3/M4 capability gates, M6 visuals; inline in thread; narrow stacks actions | provider request bridge/resolution, task status reread | Per-action live/fixture gate. Disabled explanatory state permitted; unproven functional action forbidden. `F/R/S/V` |
| `SF-11` | Desktop inspector dock container; Observed container + Approved destinations | `features/inspectors/InspectorDock.tsx` | `R-complete`, `R-active`, `C4`; `T-inspectors` | Availability follows current provider/task runtime; local UI tab selection is a preference | Custom content-height 300-unit dock; `Tabs`, `Collapsible`, `Separator`, `Empty`, `Alert`, `Tooltip`. Desktop dock is not shadcn `Sheet` | M6; x/right gutter and content-height follow reference; narrow/PWA uses titled `Sheet` or explicit unavailable disclosure | task capabilities/events, repository APIs, artifacts projection | Old transcript rails remain until every preserved utility has a destination and each inspector passes `F/P/S/V/D` |
| `SF-12` | Diff inspector; Approved-new Conditional | `features/inspectors/DiffInspector.tsx` | `C4`; `T-inspectors` | Provider/repository diff only; no automatic unsandboxed shell | `Tabs`, `Collapsible`, `ScrollArea` allowed inside bounded non-virtualized diff only, `Button` | M6; desktop dock, narrow titled `Sheet`, PWA `Desktop required for terminal and diff` | native diff/review events + explicit git diff API | Hidden/unavailable until provider capability; exact paths/counts dynamic. `F/S/V` |
| `SF-13` | Files inspector; Approved-new + Preserved file-change utilities | `features/inspectors/FilesInspector.tsx` | `C4`, `P0`; `T-inspectors` | Provider file items and explicit repository API; local selection only | `Tabs`, `Collapsible`, list/tree, `ContextMenu`, `Tooltip` | M6; same dock/sheet rules | session files/file-change summary/files API | Existing file-change summary remains until functional parity and `F/P/S/V/D` |
| `SF-14` | Terminal inspector; Approved-new Conditional | `features/inspectors/TerminalInspector.tsx` | `C4`; `T-inspectors` | Provider-emitted output only by default. Never invoke `thread/shellCommand` automatically | `Tabs`, `Alert`, `Empty`; output uses native scroll/monospace. No input prompt unless an explicit safe terminal product is separately authorized | M6; desktop only for PWA declaration | native command/tool output | Capability/security gate and no auto-shell proof: `F/S/V` |
| `SF-15` | Browser inspector; Approved-new Conditional | `features/inspectors/BrowserInspector.tsx` | `C4`; `T-inspectors` | Provider/browser activity only; empty is honest | `Tabs`, `Empty`, `Alert`, URL row | M6; desktop/narrow sheet; PWA capability-dependent | browser activity/artifact events | `Not available for this task` until real capability; `F/S/V` |
| `SF-16` | Artifacts inspector; Approved-new Conditional | `features/inspectors/ArtifactsInspector.tsx` | `C4`, `C7`; `T-inspectors`, `T-work` | Provider artifact or explicit DevHub deliverable, labelled by source | `Tabs`, list, `Badge`, `Empty`, `Button` | M6-M7; dock/sheet; PWA download only when safe | provider artifact events/DevHub attachments & deliverables | No synthetic artifact; retention/ownership/download and `F/P/S/V` |
| `SF-17` | Provider/model/mode/permission diagnostic disclosure | `features/providers/*` | `C5`; `T-setup` | Requested/init/actual/billed remain distinct; permission vocabularies never cross-map by text | `Popover`, `Select`, `ToggleGroup`, `Alert`, `Collapsible`, `Tooltip` | M4-M6; inline/anchored wide, stacked narrow | versioned capability census and events | Claude model picker remains disabled until model divergence is resolved; Claude provider selection follows native create capability. `F/S/V` |
| `SF-18` | Search tasks/messages dialog; Current + Preserved + Rethemed | `SearchPalette.tsx` -> `features/search/TaskSearchDialog.tsx` | `R-search`, `C8`; `T-search` | Result provider comes from composite key; snippets are rebuildable projection with native navigation target | `Command` inside titled `Dialog`, `ToggleGroup` for scope/date where appropriate, `Skeleton`, `Empty`, `Alert` | M5-M6; centered desktop; nearly full-width narrow/PWA; focus restored | `/api/search`, scope/date query, provider-aware task/message URL; persisted search scope | **May not be merged into Commands.** Empty/loading/error/no-result plus populated results, keyboard and URL target must pass `F/P/V/D` |
| `SF-19` | Commands palette; Current code but presently not mounted; Approved repaired surface | `CommandPalette.tsx` -> `features/commands/CommandDialog.tsx` | `C8`; `T-commands` | Runs DevHub-local navigation/actions; provider actions appear only when capability-valid | Separate `Command` inside titled `Dialog` | M6; same focus/viewport rules as Search | local command registry; explicit backend APIs for reindex/health/export | Current `commandOpen`/shortcut/state exist but no `<CommandPalette>` is mounted in `App.tsx`; do not call it preserved-functional until repaired. `Search tasks` closes Commands and opens Search. `F/S/V/D` |
| `SF-20` | Toasts, persistent alerts, loading/empty feedback; Current + Preserved | shared UI layer | `P0`; `T-feedback` | Messages name the source/provider when relevant | `sonner` for transient toast; `Alert`/`Progress` for persistent state; `Skeleton`, `Spinner`, `Empty` | M6 incremental; never causes layout jump; reduced motion | action/error/event state | Replace bespoke `Toast`/`Skeleton`/`ui.tsx` only after same semantics/a11y and `F/V/D` |

## 5. Preserved supporting surfaces

These are not permitted to clutter the primary task canvas. They remain reachable through the applicable route, Search, Commands, Settings, inspector, or a compact overflow action.

| Family | Current owners | Target placement / primitive | Provider and persistence rule | Cutover gate |
|---|---|---|---|---|
| Project/session organization | `ProjectsPane`, `SessionsPane`, `TagFilterBar`, `ProjectDetailHeader`, `ProjectOverview` | Task rail/history route; `Sidebar`, `ContextMenu`, `DropdownMenu`, `InputGroup`, `Badge`, `Tooltip` | Provider suffix is native; favorite/pin/tags/notes/archive are local unless provider-native support is explicit | All filter, multi-select, bulk, overview, URL, keyboard and metadata tests `F/P/V/D` |
| Transcript utilities | `FindBar`, filters, errors, outline, minimap, timeline/replay, bookmarks, reading mode, notes, tags, compare, permalinks | Compact task-header overflow and inspector destinations; `Dialog`, `Collapsible`, `Tabs`, `Tooltip`, `Button` | Transcript stays provider-native/read-only; bookmarks/notes/tags/view state local | Long transcript, anchor, hash, keyboard, metadata restart, compare and direct navigation `F/P/V/D` |
| Tool renderers | Bash, edit/write diff, read, grep/glob, task/subagent, TodoWrite, web, image, Markdown/GFM/KaTeX components | `ActivityTimeline` and inspectors; `Collapsible`, `Alert`, `Badge` | Native event type decides renderer. Unknown stays diagnostic, not dropped | Provider fixture corpus + security and visual states `F/S/V/D` |
| Repository/Git/worktree/editor | `GitPanel`, `GitDiffView`, `BranchSwitcher`, `WorktreePanel`, `CommitComposer`, `GitSync`, `OpenInEditor` | Inspector/Commands/overflow, never automatic; `Tabs`, `Dialog`, `AlertDialog` only for destructive confirmation, `DropdownMenu` | Explicit repository API; no provider credential/browser shell | Auth/origin, confirmation, repo-state, failure/recovery `F/P/S/V/D` |
| Session comparison | `SessionCompare` | Titled `Dialog`, read-only | Provider-aware source labels; no transcript writes | Compare fixture, focus trap/restore, narrow layout `F/V/D` |
| Project switcher/recent menu | `ProjectSwitcher`, inline `RecentMenu` | Commands/rail; `Command` in `Dialog`, `DropdownMenu` | Recent list local; project source from index | Keyboard, focus, persistence `F/P/V/D` |
| Shortcut sheet/onboarding/auth gate | `ShortcutOverlay`, `FirstRun`, `AuthGate` | Titled `Dialog`; onboarding may remain only for a truly new install; auth uses `FieldGroup`/`InputGroup` | Local onboarding flag; access token secret stays client-auth storage and never URL/log | Reconciled real shortcuts, DevHub/provider-neutral copy, focus/security `F/P/S/V/D` |
| Archive/export/import/index maintenance | Settings config components + command actions | Settings/Commands; `FieldGroup`, `Alert`, `Progress`, `Dialog`, `Button` | Rebuildable projection/additive metadata only; never writes/deletes native transcripts | Round-trip, old archive reader, native-session immutability, authenticated mutation `F/P/S/V/D` |
| Desktop/TUI/tray/hotkey/notifications | Tauri/Rust and TUI packages | M8 identity/cutover; web primitives do not own native chrome | Preserve installed identifiers/aliases until upgrade migration is proven | Packaged closed-client smoke, server identity, PATH discovery, hotkey/tray/notification and TUI tests `F/P/S/V/D` |

## 6. Exact visible-copy inventory

The `T-*` and approved-new lists below are exhaustive for target stable product chrome covered by this lock. Dynamic data slots are bracketed. Until a named preserved route passes its cutover gate, its current-source visible copy remains allowed and must survive unchanged unless this inventory explicitly replaces or prohibits it. Copy QA must compare that route's before/after visible-string snapshot; examples include `Server name`, `Config (JSON)`, `Label (optional)`, `Fire on`, `Plugins not available here`, and `All projects (full archive)`. This temporary source allowance ends per surface, not globally, when that surface passes its cutover gate.

### `T-shell` — global shell

- `DevHub`
- `Skip to main content`
- `Search`
- `Settings`
- `Keyboard shortcuts`
- Dynamic indexing/source counts: `indexing [done]/[total]`, `[count] sessions`, `[count] projects`

No visible `Claude UI` is allowed. No global brand may read `Codex`, `ChatGPT`, `Claude`, `OpenAI`, or `Anthropic`.

### `T-rail` — task rail and secondary destinations

- `New task`
- `Scheduled` — hidden unless a real supported scheduling workflow exists; never inert
- `Plugins` — opens real provider-aware inventory/settings
- `Pull requests` — opens a real repository workflow; otherwise hidden
- `Projects`
- `Tasks`
- `Ops`
- `Inbox`
- `Settings`
- `No tasks`
- Task-row provider suffixes: `Codex`, `Claude`
- Dynamic: `[project name]`, `[task title]`, `[status]`

Generated concept rail strings not listed here are not approved.

### `T-header`

- Dynamic header: `[task title]`
- Provider identity: `OpenAI · Codex` or `Anthropic · Claude`
- Mode identity when applicable: `DevHub Work`
- Accessible overflow name: `Task actions`

### `T-empty`

- Empty existing task: **no central empty-state text, illustration, suggestions, or card**
- Provider identity remains visible in the task header and composer.

### `T-thread`

- Transcript utility labels retained where applicable: `Marks`, `Changes`, `Outline`, `Read`, `Replay`, `Notes`, `Tags`, `Compare`, `Continue this chat`, `Jump to latest`
- History loader: `Showing recent messages — load older history`
- Empty filtered states: `No prose to read here`, `This session is all tool calls — turn off reading mode to see them.`, `No messages match these filters`, `Adjust or clear the filter chips above to see the rest of the transcript.`
- Dynamic metadata: `[count] errors`, `[count] msgs`, `[count] tok`, `[size]`, `[count] subagents`, `[cwd]`, `[branch]`

### `T-setup` — new task and provider controls

- `New task`
- `Start a task`
- `Describe the outcome or change…`
- `Provider`
- `OpenAI · Codex`
- `Anthropic · Claude`
- `Model`
- `Reasoning`
- `Mode`
- `Code`
- `Work`
- `Project`
- `Folder`
- `Choose folder`
- `Permissions` for Codex setup
- `Permission mode` for Claude setup
- `Create task`
- `Provider is fixed after creation. Fork to another provider to continue there.`
- `Claude model selection unavailable until runtime support is verified.`
- `Requested`
- `Session reported`
- `Response used`
- `Model differs from request`
- Example/dynamic values from the approved brief: `Codex 5.6`, `High`, `claude-ui`, `…/active/claude-ui`, `[provider model]`, `[project]`, `[folder]`
- Codex permission labels: `Read only`, `Workspace`, `Full access`
- Claude permission labels: `Plan`, `Default`, `Accept edits`, `Auto`, `Bypass permissions`, `Manual`, `Don't ask`; render only installed/supported values

### `T-composer`

- Existing task placeholder: `Ask for follow-up changes`
- New task placeholder: `Describe the outcome or change…`
- Provider: `OpenAI · Codex` or `Anthropic · Claude`
- Mode: `Code` or `Work`
- Active goal label: `Goal`
- Actions/accessibility: `Send`, `Stop`, `Attach`, `Open provider settings`
- Queue/stream labels retained from current behavior: `[count] queued`, `Regenerate`, `Switch model`, `Slash commands`, `session command`, `No session commands available — start a chat to load them.`
- Edit continuation disclosure: `Editing an earlier message — sending will continue this session, forking the conversation from here.` and `Cancel`

The provider control is not a picker in an existing task. `Always allow` is prohibited.

### `T-active` — plan, activity, diff, and goal

- `Working for [duration]`
- `Plan`
- Approved specimen rows: `Define provider contracts`, `Add native IDs`, `Stream provider events`, `Verify restart`
- Approved activity specimens: `Read 6 files`, `Ran pnpm test`, `Edited 3 files`, `Tests passing`
- Diff specimen/dynamic pattern: `[count] files changed +[added] -[removed]`
- `Goal`
- Approved specimen: `Implement provider adapter seam`
- Dynamic progress: `[done]/[total]`

Specimen task/activity text demonstrates composition. Production event labels come from normalized native events and must remain truthful.

### `T-intervention`

- `Proposed Claude request states — capability-gated until persistent runtime verification`
- `Permission request`
- `Write`
- `[path]`
- `Allow`
- `Deny`
- `Cancel`
- `Unavailable until runtime support is verified`
- `Input requested`
- `Which target should I verify?`
- `Browser + desktop`
- `Browser only`
- `Send response`
- `Read failed`
- `Retry`
- `Safe to retry`
- `Reconnecting…`
- `Check task status`
- `Request expired — no action taken`
- `Cancelled by you`
- `Anthropic · Claude`
- `Default`

Expiry and cancellation are independent. Retry appears only for an operation proven safe to retry. Timeout never authorizes.

### `T-inspectors`

- Persistent non-tab summary heading: `Environment`
- Tabs: `Diff`, `Files`, `Terminal`, `Browser`, `Artifacts`
- `Availability follows the task runtime`
- Diff dynamic labels: `[file path]`, `[count] files · +[added] -[removed]`
- Terminal dynamic output; approved specimen `pnpm test`, `622 passed`
- Browser unavailable label: `Not available for this task`
- Artifact examples: `Build report`, `Screenshot`, `No artifacts`
- Environment rows retained when backed: `Changes`, `Local`, `[branch]`, `Commit or push`, `Create pull request`, `Pull request status unavailable`, `Subagents`, `No active subagents`, `Sources`, `Web search`, `View all`

The Environment summary persists above the tablist and owns only backed environment/repository/subagent/source rows; it is not a selectable destination. Below it, only the selected inspector tab's content renders. The concept's malformed `Filfs`, mismatched selected tabs, and mixed empty/populated artifact state are rejected.

### `T-search` — distinct Search dialog

- Accessible title: `Search tasks and messages`
- Query placeholders: `Search all tasks and messages…`, `Search [project name]…`
- Scopes: `Global`, `[project name]` or `Project`
- Date facets retained: `Today`, `7d`, `30d`, `90d`, `Custom`
- Date controls/accessibility: `After date`, `Before date`, `Clear date range`, `clear`
- States: `Type to search`, `Searching…`, `No results`, `Search failed`
- Dynamic status: `[count] results`
- Footer: `↑↓ navigate`, `↵ open`, `esc close`, `all projects` or `[project name]`
- Result row data: `[task title]`, `[project name]`, `[highlighted snippet]`, `Codex` or `Claude`

Search opens provider-locked task/message results. It is not the command palette.

### `T-commands` — separate Commands dialog

- Accessible title/input: `Search commands and tasks`
- Approved primary rows: `New task`, `Search tasks`, `Toggle inspector`, `Open Settings`, `Go to Ops`
- Approved shortcuts: `⌘N`, `⌘K`, `⌘⇧I`, `⌘,`
- State/footer: `No commands`, `↑↓ navigate`, `↵ run`, `esc close`
- Preserved action families may use their existing exact labels: `Go to Home`, `Go to Browse`, `Go to Chat`, `Go to Live Ops`, `Go to Inbox`, `Go to Dashboard`, `Keyboard shortcuts`, `Rebuild index`, `Check index health`, `Export archive`, `Toggle theme (now: [preference])`, `Toggle reduced motion (now: [preference])`, `Use model [model]`, `Jump to [project]`, `Reopen [task]`

Choosing `Search tasks` closes Commands and opens `T-search`.

The current unmounted implementation's placeholder `Run a command…` is replaced at target cutover; it is not an alternate label for the approved Commands surface.

### `T-fork`

- Stage captions: `Unchanged source task`, `Handoff preview`, `Newly created linked target task`
- `Create cross-provider fork`
- `Source task`
- Dynamic source identity: `[source provider identity]`
- `Target provider`
- Dynamic target identity: `[target provider identity]`
- `Requested model`
- `Runtime default`
- `Mode`
- `Code`
- `Folder`
- Dynamic target permission label: `Permissions` for Codex or `Permission mode` for Claude
- Dynamic target permission value: `[target provider-native permission value]`
- `Transferred context`
- `User messages`
- `Goal summary`
- `Selected files`
- `Reviewed tool outputs`
- `Excluded automatically`
- `Secrets and auth`
- `Hidden reasoning`
- `Approval credentials`
- `Unreviewed sensitive tool output`
- Attributed dynamic prefix: `Handoff from [source provider identity] task [source native ID]`
- `The source task remains unchanged. A new native task will be created.`
- `The resulting link is local to DevHub.`
- `Cancel`
- `Create fork`
- Target backlink: `Forked from [source provider identity]`
- `Linked by DevHub`
- Dynamic native IDs: `[provider]: [native ID]`

Excluded rows are locked/non-interactive. OpenAI-to-Claude with `Permission mode` / `Default` is the approved visual specimen, not the only direction. A Claude target must never show `Permissions` / `Workspace`; a Codex target must never show Claude's `Permission mode` / `Default` labels.

### `T-work`

- `Prepare release audit` is the approved specimen task title; production uses `[task title]`
- `Anthropic · Claude` or the actual fixed provider identity
- `DevHub Work`
- `Code`
- `Work`
- Approved activity specimens: `Checked package outputs`, `Ran desktop smoke test`, `Collected release notes`
- `Outcome`
- `Ship a release-ready package`
- `[done]/[total]`
- `Work scope`
- `Folder scope`
- `[folder]`
- Provider-specific permission label: `Permissions` for Codex or `Permission mode` for Claude
- `[provider-native permission value]`
- `Deliverables`
- `Build report`
- `Desktop package`
- `Release notes`
- `Ready`
- `In progress`
- `Pending`
- `Progress [done] of [total]`

`Cowork` is prohibited. No background/subagent/offline claim appears until proven.

### `T-responsive`

- Narrow navigation/accessibility: `Back`, `Projects`, `Sessions`, `Transcript`, `Open navigation`, `Close navigation`, `Open inspector`, `Close inspector`
- Presentation labels used only in QA/concept material, not product chrome: `Desktop`, `Narrow`, `PWA`
- PWA limitation: `Desktop required for terminal and diff`

PWA scope is task reading/reply and safe navigation. No visible copy may claim native mobile, offline, push, background work, elevated permission, or full desktop parity.

### `T-feedback` — shared transient and persistent state

- Generic actions: `Retry`, `Dismiss`, `Close`, `Cancel`
- Success: `Saved`, `Index healthy`, `No issues found.`
- Maintenance warning: `[count] index issue found` or `[count] index issues found`, `Open Settings → Index health to review and repair.`
- Unsupported/failure: `Index health unavailable`, `This server doesn't support the health check yet.`, `Couldn't check index`, `Not available for this task`, `Unavailable until runtime support is verified`
- Export: `Exporting archive…`, `Your browser will download the .json file.`
- Dynamic provider/runtime state: `[operation] failed`, `[provider-safe error message]`, `Working…`, `Reconnecting…`

Transient feedback uses a toast; state that blocks or materially changes a task remains inline. Provider-safe error text is sanitized backend output and must never contain credentials, hidden reasoning, or raw auth payloads.

### `L-home` — preserved legacy route copy

- `Home`, `Your AI coding workspace`, `Overview`
- `Claude — this month`, `Codex — this month`, `Total Claude`, `Total Codex`, `sessions`, `all time`
- `Recent Activity`, `No recent activity yet.`, `Quick Start`
- Legacy-only `New Claude Session`; target replacement is `New task`
- Dynamic provider badges `Claude`, `Codex`, model, project/path, relative time

### `L-browse` — preserved legacy project/session copy

- `Projects`, `Filter projects`, `No projects`
- `Sessions`, `Filter sessions`, `Overview`, `No sessions`, `No sessions match the current filter`, `Select a project`
- Bulk/local metadata: `[count] selected`, `Pin`, `Unpin`, `Tag`, `Tag name…`, `Clear selection`, `Hover a row's checkbox (or press x) to multi-select`
- Project overview: `Total tokens`, `Est. cost`, `Active`, `By model`, `Daily usage`, `Top tools`, `Tags`, `No daily usage recorded yet.`, `No tool usage in this project yet.`, `No tags on this project's sessions yet.`
- Overview errors: `Project overview isn't available on this server`, `Couldn't load the project overview`

### `L-transcript` — preserved legacy transcript copy

- `Select a session`
- `Pick a project, then a chat to read its full transcript — rendered the way Claude Code shows it.`
- Transcript utilities, history loading, filtering, and empty states are listed in `T-thread`.

### `L-chat` — preserved legacy Claude route copy

- Dynamic title `[project name]`, `[cwd]`
- `Anthropic · Claude` is added during migration; current route currently omits it
- `reconnecting…`, `Model`, `Permission mode`, `Set as project default`, `New chat`
- Empty: `Chat in [project name]`, `Resuming this session. Type a prompt below to continue where it left off.`, `Type a prompt below to start a live Claude Code session in this project. Enter to send, Shift+Enter for a new line.`
- Runtime: `working`, `[count] queued`, `Regenerate`, `Stopped: interrupted by you`
- Composer/palette text is listed in `T-composer`

### `L-ops`

- `Live ops`, `[count] running`, `[count] need you`, `Refresh`, `Open session`
- `No sessions running right now`, `Live Claude Code sessions show up here the moment they start — busy, waiting, or needing your input.`
- Ops subviews: `board`, `grid`, `Multi-session`, `[count]/6 watching`, `Add panel`, `Running sessions`, `No running sessions.`, `Add a session to watch`
- `Use “Add panel” to watch and drive up to six live sessions side by side.`

Target copy changes `Live Claude Code sessions` to provider-neutral `Live provider tasks` only when the target multi-provider route replaces the legacy Claude-only board.

### `L-inbox`

- `Inbox`, `[count] to triage`, `[count] cleared`, `Refresh`
- `Recent sessions that haven't been sorted yet — no tags, no notes, not archived. Tag, pin, or archive them to clear the queue.`
- `Inbox zero`, `Every recent session is sorted. New, untagged sessions will appear here for triage.`
- `Open in Browse`, `tag…`, `Pin`, `Unpin`, `Archive`
- Quick tags: `#keep`, `#review`, `#reference`, `#wip`, `#done`

### `L-dashboard`

- `Running now`, `Total sessions`, `Projects`, `Total tokens`, `Est. cost`
- `Usage over time`, `Tokens`, `Sessions`, `No usage in this period.`, `Usage rollups aren't available on this server yet.`
- `Activity heatmap`, `sessions`, `tokens`, `When you work`, `By model`, `By tool`
- `Top projects`, `No project usage yet.`, `Project leaderboard`, `Uncommitted changes`, `Cost forecast`, `Top spenders`, `Activity (30 days)`, `No recent activity.`
- `No sessions running right now`, `Live Claude Code sessions will show up here as they start.` remains legacy-only until provider-aware data lands

### `L-settings`

- Route/tabs: `Settings`, `Preferences`, `Budget`, `Memory`, `MCP servers`, `Hooks`, `Webhooks`, `Permissions`, `Agents`, `Skills`, `Plugins`
- Preferences: `Default model`, `Used when starting a new chat.`, `Default permission mode`, `How edits/commands are approved.`, `Theme`, `Density`, `Monthly budget (USD)`, `No budget`, `Save settings`, `Saved`
- Connection: `Connection`, `local only`, `Groundwork for connecting to a remote engine. Stored only in this browser.`, `API host`, `(same origin)`, `API token`, `(none)`
- Maintenance/config headings: `Search index`, `Index health`, `Backup & transfer`, `CLAUDE.md`, `MCP servers`, `Hooks`, `Webhooks`, `Permissions`, `Installed plugins`, `Marketplaces`, `This month`
- Budget fields: `Monthly cap (USD)`, `No cap`, `Warn threshold (%)`, `Enforce the cap`, `Spent`, `Projected end of month`, `Remaining`
- Empty inventory: `No subagents found`, `No skills found`, `No plugins installed`, `No marketplaces configured.`
- Provider-specific descriptions must name `OpenAI · Codex` or `Anthropic · Claude`; existing Claude-only explanatory sentences remain only in the legacy Claude settings panels

### `L-raw-openai`

- Required quarantine title: `OpenAI Chat — development only`
- `Model`, `New session`, `Message OpenAI…`, `Please wait…`, `Starting session…`, `Generating…`, `Stop generation`, `Send message`
- Required persistent warning: `Chat-only experiment. This is not Codex. Local tools are disabled by default.`
- The current hint claiming `The bash tool runs in your chosen CWD.` is prohibited once quarantine lands.

### `L-codex-fallback`

- `Codex Session History`
- `[count] sessions`, `[count] turn`, `[count] turns`
- `No Codex sessions yet`
- `Run the Codex CLI in a project to see your session history here.`
- `Codex history unavailable (server may not support it yet).`
- Required target disclosure: `Read-only fallback`

### `L-overlays-auth-onboarding`

- Search uses `T-search`; Commands uses `T-commands`
- Project switcher: `Jump to a project…`, `No projects`, `current`, `↑↓ navigate`, `↵ jump`, `esc close`
- Shortcuts: `Keyboard shortcuts`, `Global`, `Lists (projects & sessions)`, `Transcript`, `Approvals (live chat)`, and the exact shortcut/action labels from `preservation-matrix.md`
- Shortcut footer: `Press ? any time to open this. Esc to close.`
- Auth: `DevHub`, `Access token required`, `This server is locked for remote access. Paste the access token to continue — it’s saved on this device so you won’t be asked again.`, `Access token`, `Checking…`, `Unlock`, `Log out`
- First run: `Welcome to DevHub`, `Your personal dev hub — browse Claude & Codex sessions, start new chats, track usage across all your AI tools.`, `Browse past chats`, `Read every Claude Code session across all your projects, search by content, and pick up where you left off.`, `Chat live`, `Start a new Claude Code session in any project's working directory — approvals, diffs, and tools, right here.`, `Dashboard & oversight`, `Watch running sessions on the Live Ops board and track tokens, spend, and activity across everything.`, `Handy shortcuts`, `You can reopen shortcuts any time with ?`, `Get started`
- First-run body must be rewritten provider-neutrally before shell cutover; no visible `Claude UI` or implication that all tasks are Claude

## 7. Search and Commands are separate contracts

This distinction is mandatory:

| Concern | Search | Commands |
|---|---|---|
| Purpose | Query indexed task/message content and open a provider-locked result/message | Run navigation or explicit DevHub actions |
| Shortcut | `Cmd/Ctrl+K` | `Cmd/Ctrl+Shift+P` |
| Input title | `Search tasks and messages` | `Search commands and tasks` |
| Backing data | `/api/search`, provider-aware index, scope/date facets | In-memory command registry plus explicit action APIs |
| Results | Task title, project, provider, highlighted message snippet, result count/status | Action label, group, shortcut/current value |
| Empty/error | `Type to search`, `Searching…`, `No results`, `Search failed` | `No commands` |
| Relationship | Independent dialog | `Search tasks` closes Commands, then opens Search |

Current-source note: `CommandPalette.tsx`, `commandOpen`, shortcut wiring, and command construction exist, but `App.tsx` does not mount `<CommandPalette>`. The current populated Search surface is real; current Commands reachability is a defect to repair, not a reason to merge the two.

## 8. shadcn adoption and ownership constraints

- Current preview state: shadcn CLI 4.13.0, Vite, React Server Components false, TypeScript, Tailwind v4, `src/index.css`, no `components.json`, no alias, and zero installed shadcn components. The disposable no-preset `init` was a verified no-op.
- Use only official `@shadcn`, Radix base, `rsc:false`, TypeScript, Tailwind v4, CSS variables, Lucide, `src/index.css`, and `@/* -> apps/web/src/*`.
- Initialization is blocked until the approved transparent custom Radix preset has a complete audited URL/config and disposable-copy diff. The preset may not introduce a named visual preset, page block, opaque default, or overwrite existing CSS, `cn()`, theme behavior, or dependencies unexpectedly.
- No default shadcn visual styling survives when it differs from the measured captures/design lock.
- `Sidebar` owns accessible rail mechanics but not its default cookie persistence or shortcut.
- `Sheet` is restricted to narrow rails/inspectors. The wide desktop inspector and fork preview are not `Sheet`.
- Search and Commands each use their own titled `Dialog` containing `Command`.
- Approvals/requests are inline and never `AlertDialog`; `AlertDialog` is reserved for destructive confirmation.
- `InputGroupTextarea` owns the composer. `ToggleGroup` owns Code/Work and other compact option sets. Settings uses `FieldGroup`/`Field`/`FieldSet` rather than generic layout divs.
- Every `Dialog`, `Sheet`, and `Drawer` has a title; icon-only controls have accessible names; focus restore, Escape, arrow navigation, portalling, scroll locking, and reduced motion are mandatory.
- Native/virtualized transcript scrolling is preserved and is never wrapped in `ScrollArea`.
- `apps/web/src/components/ui.tsx` remains a compatibility facade until imports reach zero. `sonner`, `Alert`, `Progress`, `Skeleton`, `Spinner`, and `Empty` replace bounded legacy feedback only after side-by-side parity.

## 9. Responsive ownership

| Tier | Contract |
|---|---|
| Reference wide desktop | Match the measured 1800x1130 shell: 273 rail, 46 header, open canvas, 736 transcript/composer, 736x98 composer with 16 bottom gutter, 300 content-height inspector with 16 right gutter. |
| Existing narrow browser | Preserve the current below-1024 one-pane Browse drill-down until the approved replacement passes. No horizontal overflow. |
| Target narrow desktop / minimum packaged width | Slim rail or titled temporary `Sheet`; transcript remains primary; inspector opens explicitly as a titled overlay; composer stays reachable and stable. Current Tauri minimum 920x600 remains supported unless a later evidence-backed lock changes it. |
| PWA | Task list/back navigation, transcript reading, safe reply, Search, Commands, and safe settings only. Show `Desktop required for terminal and diff`. No offline/push/native-mobile/full-parity claim. |

Static captures do not establish motion timing. Until a measurable reference is available, the design-system documented 120-220 ms fallback applies only to non-streaming UI transitions. Reduced motion removes nonessential movement; streaming content, send-to-stop, rail selection, overlay reversal, and focus restoration must show zero layout shift.

## 10. Final cutover checklist for this inventory

- Every route row has a real reachable workflow test or an intentional supported relocation.
- Every task surface derives provider identity from the composite native key.
- Every DevHub-local metadata field is labelled/local by behavior and never overwrites provider-native state.
- Search remains distinct from Commands, and both are actually mounted, keyboard-operable, and focus-restoring.
- Every visible static chrome string matches one of the copy sets above; provider/user data occupy only dynamic slots.
- Capability-gated controls are absent or disabled with the exact explanation; timeout never accepts.
- Every surface names its governing capture/concept and is verified against it with Browser/IAB plus `view_image`.
- Current/minimum/narrow/PWA scopes pass without overflow or hidden required controls.
- All old URL/localStorage/archive/env/webhook readers required by `preservation-matrix.md` remain until migration/rollback tests pass.
- No legacy path, route, facade, or identifier is removed before its row's complete `F/P/R/S/V/D` gate is green.
