# DevHub Provider-Native Codex Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` only after the single design-approval gate. Follow this file task-by-task and keep checkboxes current.

**Goal:** Transform the existing brownfield application into DevHub, a provider-native Codex-quality environment for real OpenAI Codex and Anthropic Claude runtimes, without losing current routes, data, or utilities.

**Architecture:** A typed provider seam owns lifecycle and capability truth. A supervised Codex app-server peer and one persistent installed Claude CLI stream/control child per active native task normalize native events into one replayable UI event model while preserving raw diagnostic envelopes. DevHub stores rebuildable projections, UI preferences, and additive metadata only; native provider sessions remain authoritative.

**Tech stack:** TypeScript, Node.js, Fastify/WebSocket/SSE, React 19, Vite 6, Tailwind 4, Radix-based shadcn source components, SQLite projections, Ink TUI, Tauri 2/Rust, Codex app-server stdio JSONL, installed Claude CLI stream/control JSONL plus official Agent SDK session helpers, Vitest, Browser/IAB, Computer Use, ImageGen.

---

## Non-negotiable execution policy

- Use the current `campaign/auto-improve` branch.
- Do not create branches/worktrees, reset, stash, checkout, stage, commit, push, or discard unless the user explicitly asks.
- Preserve the 13-file dirty baseline in `baseline.md`; planning artifacts belong to this program, but pre-existing changes remain user-owned.
- One writer per overlapping file. Parallel agents may research, review, or test read-only; an assigned implementation lane owns its files until integration.
- No production frontend code is written before the single design approval.
- Do not delete a legacy path until side-by-side functional, persistence, restart/recovery, security, and visual gates pass.
- Every milestone ends runnable, with uncached targeted tests plus the applicable full gate.
- Provider capabilities are runtime/version facts. Unsupported controls are absent or explicitly disabled with an explanation.
- Live provider tests run sequentially and use at most two billable turns per provider, with one justified third only for an unresolved lifecycle state.
- No provider token, private transcript, auth payload, hidden reasoning, or credential enters browser state, URLs, fixtures, screenshots, or telemetry.

## Program feature flags

Introduce these additive settings through the existing settings store; default each to `false` until its parity gate passes:

```ts
export interface DevHubFeatureFlags {
  nativeCodex: boolean;
  persistentClaude: boolean;
  unifiedTaskIndex: boolean;
  codexStyleShell: boolean;
  crossProviderFork: boolean;
  workMode: boolean;
}
```

Environment aliases may exist for deterministic tests, but browser code reads resolved backend capabilities rather than environment variables directly.

## Locked file ownership map

| Responsibility | New/primary files | Notes |
|---|---|---|
| Provider-neutral types | `packages/engine/src/providers/types.ts`, `events.ts`, `capabilities.ts`, `task-key.ts` | No provider imports. |
| Native task leases | `packages/engine/src/providers/lease-store.ts`, `native-revision.ts` | Shared by both adapters. |
| Codex protocol | `packages/engine/src/providers/codex/protocol/*` | Generated stable binding + checked fallback; experimental isolated. |
| Codex process/adapter | `packages/engine/src/providers/codex/app-server-process.ts`, `rpc-peer.ts`, `supervisor.ts`, `adapter.ts` | One process per canonical effective `CODEX_HOME`. |
| Claude process/adapter | `packages/engine/src/providers/claude/cli-process.ts`, `session-helpers.ts`, `event-normalizer.ts`, `permission-bridge.ts`, `adapter.ts` | Persistent installed CLI is selected under API/cloud auth; official SDK helpers support native session operations. |
| Provider registry | `packages/engine/src/providers/registry.ts`, narrow exports in `packages/engine/src/index.ts` | Legacy engine APIs remain. |
| Server task API | `packages/server/src/routes/provider-tasks.ts`, `provider-task-ws.ts`, `provider-event-broker.ts` | Backend owns processes and credentials. |
| Unified index | `packages/engine/src/provider-index/*`, new additive SQLite migrations | Composite provider/native IDs. |
| Web task client | `apps/web/src/features/tasks/api.ts`, `types.ts`, `event-store.ts`, `useTask.ts` | Raw provider envelope is diagnostic-only. |
| Shell | `apps/web/src/features/shell/DevHubShell.tsx`, `TaskRail.tsx`, `TaskHeader.tsx` | Behind `codexStyleShell`. |
| Thread | `apps/web/src/features/thread/ThreadWorkspace.tsx`, `ActivityTimeline.tsx`, `Composer.tsx` | Keep current renderer adapters. |
| Inspectors | `apps/web/src/features/inspectors/*` | Diff, Files, Terminal, Browser, Artifacts. |
| Provider UI | `apps/web/src/features/providers/*` | Identity, model/mode/project controls, capability explanations. |
| Work/fork | `apps/web/src/features/work/*`, `apps/web/src/features/fork/*` | Real runtime only. |
| Shared UI primitives | `apps/web/src/components/ui/*`; facade `apps/web/src/components/ui.tsx` | Brownfield shadcn migration; facade removed last. |
| Desktop | `apps/desktop/src-tauri/*`, `apps/desktop/package.json` | Package/sidecar/IPC/identity after browser slice is stable. |
| Planning/QA | `.planning/devhub-codex-parity/*` | Evidence, concepts, design lock, ledgers. |

## Provider-neutral contract to implement in M2

```ts
export type ProviderId = "openai" | "anthropic";

export interface NativeTaskKey {
  readonly provider: ProviderId;
  readonly home: string;
  readonly nativeTaskId: string;
}

export interface ProviderCapabilities {
  list: boolean;
  read: boolean;
  start: boolean;
  resume: boolean;
  fork: boolean;
  send: boolean;
  steer: boolean;
  interrupt: boolean;
  subscribe: boolean;
  approveCommand: boolean;
  approveFileChange: boolean;
  approvePermissions: boolean;
  requestUserInput: boolean;
  mcpElicitation: boolean;
  archive: boolean;
  rename: boolean;
  skills: boolean;
  plugins: boolean;
  hooks: boolean;
  mcp: boolean;
  backgroundWork: boolean;
}

export interface ProviderRequestIdentity {
  readonly key: Readonly<NativeTaskKey>;
  readonly turnId: string | null;
  readonly requestId: string;
  readonly itemId: string | null;
  readonly approvalId: string | null;
}

export interface NativeRevision {
  updatedAt: number | null;
  status: string;
  lastTurnId: string | null;
  lastTurnStatus: string | null;
  lastItemId: string | null;
  fingerprint: string;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  capabilities(): Promise<ProviderCapabilities>;
  listTasks(input: ListTasksInput): Promise<Page<NativeTaskSummary>>;
  readTask(key: NativeTaskKey, includeTurns: boolean): Promise<NativeTask>;
  startTask(input: StartTaskInput): Promise<NativeTask>;
  resumeTask(key: NativeTaskKey, overrides?: TaskOverrides): Promise<NativeTask>;
  forkTask(key: NativeTaskKey, lastTurnId?: string): Promise<NativeTask>;
  send(key: NativeTaskKey, input: UserInput): Promise<NativeTurnRef>;
  steer(key: NativeTaskKey, expectedTurnId: string, input: UserInput): Promise<void>;
  interrupt(key: NativeTaskKey, turnId: string): Promise<void>;
  respond(request: ProviderRequestResponse): Promise<void>;
  archive(key: NativeTaskKey): Promise<void>;
  rename(key: NativeTaskKey, name: string): Promise<void>;
  subscribe(key: NativeTaskKey, sink: ProviderEventSink): Promise<Unsubscribe>;
}
```

Provider ownership is immutable. A provider switch always invokes the M7 cross-provider fork service and creates a new `NativeTaskKey`.

## M0 - Baseline and preservation

- [x] Capture initial branch, HEAD, tracked diff, staged diff, untracked files, stack versions, app versions, relevant hashes, and exact quality gates.
- [x] Create and verify the protected out-of-tree backup.
- [x] Inventory frontend routes, server surfaces, persistence, shortcuts, desktop/TUI integrations, features, and tests.
- [x] Write `baseline.md`, `preservation-matrix.md`, `risk-register.md`, and this implementation plan.
- [x] Record uncached baseline failures: two calendar-drift engine tests and DMG bundling.
- [x] Append the M0 review/result to `tasks/todo.md` and verify only planning artifacts were newly added.

M0 gate:

```bash
git status --short
/sbin/sha256sum -c /Users/ronak/.codex/backups/devhub-codex-parity/20260713T001908Z/source-files-sha256.txt
pnpm exec turbo run typecheck --force
pnpm exec turbo run build --filter=@devhub/engine --filter=@devhub/server --filter=@devhub/web --force
```

Expected: source status contains the original dirty set plus planning artifacts; backup and typecheck/build pass.

## M1 - Prove native provider contracts

M1 uses disposable harnesses under `/private/tmp`; it may add generated protocol bindings and planning evidence, but no production frontend code.

### Task M1.1 - Codex schema and handshake

Files:

- Create `packages/engine/src/providers/codex/protocol/generated/0.144.1/*` from the installed binary.
- Create `packages/engine/src/providers/codex/protocol/fallback/*` with the minimal stable envelopes used by DevHub.
- Create `packages/engine/test/codex-schema-compat.test.ts`.
- Record results in `provider-spike-results.md` and `adr-codex-app-server.md`.

Steps:

- [x] Generate stable JSON schema and TypeScript bindings from `/opt/homebrew/bin/codex`; separately generate experimental output into scratch for comparison.
- [x] Record binary version/hash and schema hashes. Stable reference hashes at M0 are `02a4e17...` aggregate JSON and `87147f9...` v2 bundle; regenerate and compare rather than trusting them.
- [ ] Add a compatibility test that parses the installed stable schema when available and verifies every fallback method/notification/request still exists with compatible required fields.
- [x] Start `codex app-server --stdio` in a scratch Git repository.
- [x] Prove pre-initialize rejection, one honest `clientInfo.name:"devhub"` initialize response, `initialized`, and duplicate-initialize rejection.
- [x] Capture sanitized `codexHome`, user agent, platform family/OS, method census, enabled feature states, and unknown notification handling.

Exact non-billable probe sequence:

```text
request initialize -> response
notification initialized
request account/read
request model/list
request modelProvider/capabilities/read
request permissionProfile/list
request skills/list
request hooks/list
request app/list
request plugin/list
request mcpServerStatus/list
request config/read
request configRequirements/read
request experimentalFeature/list
```

Pass: bounded JSONL exchange completes, no credential appears in captured output, and UI capabilities reflect runtime feature states rather than schema presence.

### Task M1.2 - Codex lifecycle, requests, and synchronization

- [x] Live turn 1: create a non-ephemeral app-server thread in the scratch repo, set a tagged name, stream text, exercise safe MCP/user-input elicitation only when enabled, complete, then list/read it with `sourceKinds:["appServer"]`.
- [x] Restart app-server and prove SYNC-1: list/read the same native ID, resume it, and continue with live turn 2.
- [ ] Live turn 2: exercise harmless scratch command/file approval paths: one accept, one decline, and one bounded timeout/cancel when the model/runtime requests them. Capture `serverRequest/resolved`, item completion, diff, and final turn state.
- [x] Prove interrupt using the second turn if possible. Use one justified third turn only if steer/interrupt cannot be isolated without it.
- [x] Prove fork, rename, archive/unarchive, read-source unchanged, and cleanup through app-server APIs only.
- [ ] Prove synthetic partial/malformed/oversized JSONL, unknown/duplicate notifications, notification-before-response, server-request timeout, crash/restart circuit breaker, stale responses, and stderr flood.
- [ ] Prove SYNC-2 with two harness processes and a 5-second heartbeat/15-second lease expiry; second writer refuses until expiry and rereads before taking over.
- [x] Inspect SYNC-3 in the installed ChatGPT/Codex GUI via Computer Use. Record visible/unsupported/blocked/unknown for build `26.707.51957 (5175)`.

Pass: start, stream, interrupt, persistence, app-server restart, and resume are proven with native IDs. Approval/input is either proven or capability-gated. No native file is directly edited.

### Task M1.3 - Claude transport selection and lifecycle

Files:

- Create scratch-only probe harness under `/private/tmp/devhub-claude-m1-*`.
- Create planning `adr-claude-transport.md`; no production adapter yet.

Selected default after live cross-runtime comparison:

```text
/Users/ronak/.local/bin/claude -p
  --input-format stream-json
  --output-format stream-json
  --verbose
  --include-partial-messages
  --include-hook-events
  --replay-user-messages
  --setting-sources user,project,local
```

Authentication is API key or a supported Bedrock/Vertex/Foundry provider. Subscription OAuth is never used as a silent fallback.

Steps:

- [x] Record absolute binary/version/hash and redacted auth method. Do not capture OAuth/API credentials.
- [x] Use a scratch Git repo and synthetic `CLAUDE_CONFIG_DIR` containing only probe settings, skill, agent, hook, safe MCP echo/wait server, and permission bridge.
- [ ] Feed fixture events through the prospective parser: known/unknown events, partials, hooks, approval allow/deny/modify/cancel/timeout, oversized lines, bounded stderr.
- [x] Live turn 1: start direct installed persistent CLI stream JSON, capture `system/init` native UUID and full safe metadata, and complete.
- [x] Stop the child, rediscover/read through official Agent SDK session helpers, launch a new SDK process with `resume`, recall a nonce through SDK MCP, and prove persistence/restart/resume with live turn 2.
- [x] Exercise native interruption during a safe wait through `client.interrupt()` and retain the acknowledgement/result evidence. One justified extra lifecycle turn was needed because the initial safe Bash command was auto-approved.
- [x] Prove native rename/fork/read-source-unchanged/delete through official SDK helpers without another model turn.
- [ ] Prove SYNC-2 local writer lease and revision invalidation across harness restart.
- [x] Record SYNC-3 as unsupported for CLI `-p`/Agent SDK sessions per official docs, then verify current Claude app behavior without inspecting private storage.
- [x] Prove real file-approval allow through the SDK permission callback. Capability-gate command approval variants, deny/cancel/timeout, user input, and MCP elicitation until their bridges round-trip.
- [x] Record the installed model mismatch: turn-1 init reported Haiku while message/usage metadata reported Sonnet 5. Gate reliable model selection.

Pass: under API-key auth, direct raw CLI start/stream/persist/settings/plugin inventory passes, and the installed CLI's restart/same-ID resume/MCP/hook/approval/interrupt contract plus official list/read/rename/fork-creation/delete helpers pass under SDK reference ownership. Persistent CLI is selected because live skill/subagent/background preservation did not satisfy the stricter SDK-selection gate; raw DevHub control parity remains an M4 flag gate.

### Task M1.4 - Write the provider gate package

- [x] Write `provider-capability-matrix.md` with stable/experimental/version-aware rows.
- [x] Write `provider-spike-results.md` with exact sanitized commands/envelopes and billable-turn counts.
- [x] Write `synchronization-contract.md` separating SYNC-1, SYNC-2, and SYNC-3.
- [x] Write `adr-claude-transport.md` and `adr-codex-app-server.md`.
- [x] Update `risk-register.md` and `tasks/todo.md` review sections.
- [ ] Stop before the UI rebuild if either provider fails mandatory native start/stream/persistence/restart/resume after three evidence-backed cycles.

## Reference capture - installed first-party environment

### Task R.1 - Capture manifest and safe repository

- [ ] Create a harmless scratch Git repository with known clean/dirty files and no secrets.
- [ ] Use Computer Use for the installed `com.openai.codex` app; use Browser/IAB for web/local implementation surfaces.
- [ ] Record app build, macOS build, theme, display scale, window dimensions, timestamp, source task/state, and capture path in `reference-capture-manifest.md`.
- [ ] Never approve destructive actions; do not inspect app private storage.

### Task R.2 - Capture observable states

- [ ] Launch, empty, new-task, sidebar grouping/hover/selection/context/search/collapse/resize.
- [ ] Repository/folder selection; model/effort/mode/permission/environment setup.
- [ ] Composer rest/focus/multiline/attachment/send/stop/steer/disabled.
- [ ] Streaming text/reasoning, plan/progress, tool/terminal/file/diff/browser/artifact, error/retry/reconnect/cancel.
- [ ] Approval and user-input states available without unsafe work.
- [ ] Rename/archive/fork/navigation, menus/settings/palette/shortcuts/tooltips/focus/accessibility labels.
- [ ] Diff/Files/Terminal/Browser/Artifacts inspectors.
- [ ] Wide, minimum-width, collapsed rail, narrow, and declared PWA/mobile behavior.
- [ ] Animation start/midpoint/end, interruption/reversal, and reduced motion.

### Task R.3 - Measure

- [ ] Record dimensions, gutters, row/panel sizes, typography, tracking, radii, borders, shadows, colors, icons/strokes, easings/durations, breakpoints, labels, and shortcut copy.
- [ ] Use image inspection and computed/observable measurements; do not rely on visual memory.
- [ ] Batch unavailable states into the single design package rather than creating an earlier user gate.

## Brownfield shadcn preview

- [x] Re-run `pnpm dlx shadcn@latest info --json` in `apps/web` and save sanitized output in planning evidence.
- [x] Copy the workspace to `/private/tmp/devhub-shadcn-preview-*` excluding `.git`, `node_modules`, `dist`, `.turbo`, and Rust `target`.
- [x] Add the `@/* -> ./src/*` TypeScript and Vite aliases in the disposable copy.
- [x] Run interactive/explicit Radix initialization in the copy with React/Vite, `rsc:false`, TypeScript, Tailwind v4, CSS variables, Lucide, and `src/index.css`; do not use forbidden flags. Result: CLI 4.13.0 Custom path redirected to preset creation and made no changes.
- [x] Diff package manifests, lockfile, CSS, `cn()`, aliases, and generated config. Result recorded in `shadcn-preview-ledger.md`; the post-command diff was empty.
- [ ] Search only `@shadcn`; fetch current Radix/shadcn docs; run `add --dry-run` and `add --diff` per proposed primitive.
- [ ] Do not initialize the real workspace before design approval.

## Reference-derived ImageGen concept phase

Read the complete ImageGen CLI and prompt references before generation. Use `gpt-image-1.5`, sequential calls, final files under `.planning/devhub-codex-parity/concepts/`, exact briefs beside outputs, maximum eight initial concepts and two targeted corrections, and fail fast on auth/quota/provider errors.

- [ ] Concept 1: new/empty desktop shell.
- [ ] Concept 2: active streaming + completed + plan/tool states.
- [ ] Concept 3: approval/input/error/retry/reconnect/cancel states.
- [ ] Concept 4: Diff/Files/Terminal/Browser/Artifacts inspectors.
- [ ] Concept 5: provider/model/mode/project setup and quiet provider identity.
- [ ] Concept 6: cross-provider fork preview and resulting linked task.
- [ ] Concept 7: DevHub Work mode with folder scope, permission, progress, artifacts, deliverables.
- [ ] Concept 8: search/palette/settings/utility/collapsed/narrow/supported mobile-PWA behavior.
- [ ] Inspect every output with `view_image`; reject unreadable, invented, generic-dashboard, decorative, or capture-inconsistent details.

## Single design and plan approval gate

- [ ] Present one numbered package connecting every concept to its governing real capture.
- [ ] Distinguish copied observable Codex behavior from DevHub-only additions.
- [ ] Include provider architecture/capability matrix, synchronization tiers, responsive/motion rules, milestone plan, limitations, risks, and one recommendation.
- [ ] Stop for explicit approval. This is the only mandatory approval gate.

No steps below execute before approval.

## Design lock after approval

- [ ] Write `design-lock.md`, `design-system.md`, `component-state-matrix.md`, and `surface-inventory.md`.
- [ ] Inventory exact visible copy, semantic tokens, content/chrome typography, spacing, rows/panels, radii/borders/shadows, icons, all interaction states, breakpoints, motion, and governing capture/concept.
- [ ] Move clay brand from `--accent` to `--brand`/`--primary`; reserve `--accent` for neutral interaction; map all Tailwind v4 colors through `@theme inline`.
- [ ] Preserve `data-theme`, `.dark`, reduced motion, and temporary legacy token aliases.

## M2 - Provider adapter seam

### Task M2.1 - Tests first

- [x] Add fixture tests for the `ProviderAdapter` interface, immutable provider keys, capability gating, event normalization, raw diagnostic retention, timeout denial, and provider failure isolation.
- [x] Add clock injection and repair the two `project-overview` calendar-drift tests with relative UTC fixtures.
- [x] Run targeted tests and confirm the new tests fail for missing provider seam while legacy tests retain their baseline behavior.

### Task M2.2 - Minimal seam

- [x] Implement the provider-neutral types above, including correlated request identity and browser-safe normalized events.
- [x] Wrap current Claude process-per-turn execution as `LegacyClaudeAdapter` without changing the current UI.
- [x] Wrap Codex rollout parser as `CodexHistoryFallbackAdapter` with read-only capability flags.
- [x] Add the full capability-gated provider registry and persist all six backend-resolved feature flags false by default.
- [x] Add server routes behind the registry with authenticated mutation boundaries.
- [x] Remove/default-disable raw OpenAI local tools, label it chat-only/dev-only, and require explicit opt-in plus authenticated REST/WS before any billable call.

M2 gate:

```bash
pnpm --filter @devhub/engine test -- --runInBand
pnpm --filter @devhub/server test -- --runInBand
pnpm exec turbo run typecheck test build --force
git diff --check
```

Expected: adapter fixtures pass, original UI remains byte/behavior compatible under flags off, raw tools cannot execute by default.

M2 result: exact engine/server commands passed with 637 and 135 tests; web passed 42 tests. The forced monorepo gate completed 11/11 tasks, including a successful release `.app` and DMG build. `git diff --check` passed after restoring the packager's one-line Cargo normalization to the preserved baseline. Independent closure review found and closed resolution-before-request replay, cross-task event ownership, shared-session OpenAI concurrency, non-default Codex-home ownership, and unsafe numeric JSON-RPC ID gaps. Full raw diagnostics remain backend-only; browser diagnostics are allowlisted. The pre-existing index-worker test path still logs its known synchronous fallback warning without failing.

## M3 - Native Codex vertical slice in the existing UI

- [x] Implement bounded RPC peer and one supervised app-server per canonical `CODEX_HOME`.
- [x] Correlate requests, dispatch server requests, preserve unknown notifications, bound queues/stderr, implement backpressure and crash circuit breaker.
- [ ] Reconcile after restart via list/read/resume; never replay uncertain turn starts. List/read and fail-closed synthetic resume pass; a second persisted live production-wrapper resume is blocked by the exhausted provider-turn cap.
- [x] Expose real list/read/start/resume/fork/send/steer/interrupt/respond/archive/rename/subscription through adapter and server, capability-gating unverified controls.
- [x] Add existing-UI Codex route behind `nativeCodex`; keep rollout fallback read-only.
- [ ] Test real/synthetic stream, plan/tools, approvals/input, interrupt race, crash/restart, DevHub restart, resume, schema mismatch, secret redaction, and unsupported methods. All synthetic/contract families and the bounded one-turn live path pass; production-wrapper live resume/continued conversation remains unproved.
- [ ] Enable `nativeCodex` only after the vertical slice gate passes.

M3 implementation result: production code, synthetic lifecycle, one-turn live start/stream/persistence/restart, Browser/IAB, accessibility, performance, fidelity, and cleanup gates pass. The feature remains disabled by default because the live production-wrapper resume artifact is unavailable within the explicit three-turn Codex cap. See `evidence/m3/live-runtime.md` and `tasks/todo.md`; this is not reported as completion.

## M4 - Persistent Claude vertical slice in the existing UI

- [x] Launch the validated installed CLI by absolute path with one persistent stream/control child per active native task.
- [x] Preserve native IDs, `CLAUDE_CONFIG_DIR`, user/project/local settings, skills/plugins/hooks/MCP/agents/subagents, and provider-native permission modes. Unknown/malformed protocol drift is retained only as bounded redacted backend-memory diagnostics; this is not selected-wrapper raw lifecycle evidence.
- [x] Implement correlated native permission/control and hook bridges; publish command approval variants, user input, and MCP elicitation as false until their own fixtures/live gates pass.
- [x] Implement interrupt/restart/same-ID resume and official-helper list/read/rename/fork semantics plus writer lease. Do not claim post-interrupt resume or fork continuation until those exact paths pass.
- [ ] Reproduce raw multi-query longevity, raw `--resume`, raw permission response, raw interrupt acknowledgement, and post-interrupt resume before enabling the feature flag.
- [x] Compare requested model, `system/init.model`, each `message_start`/assistant model, and billed usage; fail or surface a clear divergence instead of claiming the picker selection applied.
- [x] Keep `LegacyClaudeAdapter` as flagged fallback until side-by-side parity passes.
- [ ] Enable `persistentClaude` only after the lifecycle gate passes.

M4 deterministic implementation result: persistent transport, controls, event/model evidence, bounded backend drift diagnostics, helpers, leases, adapter/server/UI composition, and synthetic lifecycle are implemented. Exact-copy Browser recapture remains open and first-party Computer Use is host-blocked. Exact raw product-wrapper multi-query/resume/permission/interrupt/post-interrupt/fork-continuation proof remains unavailable within the exhausted three-turn live cap; the flag stays false. See `evidence/m4/` and `tasks/todo.md`. This is not reported as milestone completion.

## M5 - Unified task/index model

- [ ] Add composite `(provider, homeFingerprint, nativeTaskId, nativeTurnId, nativeItemId)` keys and idempotent replay.
- [ ] Add schema migration, dual-read/rollback path, cache invalidation, dedupe, leases, and external mutation behavior.
- [ ] Store only additive metadata: favorite, local label, provider-fork links, UI state, and explicitly local unsupported metadata.
- [ ] Reclassify mirrored transcript/archive data as rebuildable cache; prove deleting DevHub storage leaves native sessions intact and rebuilds correctly.
- [ ] Migrate URL/localStorage/env/archive/webhook identifiers with old-reader compatibility.
- [ ] Enable `unifiedTaskIndex` only after migration/rebuild/rollback tests pass.

## M6 - Approved Codex-style shell

### Brownfield shadcn initialization

- [ ] Apply only the reviewed disposable-copy alias/config/dependency/CSS changes.
- [ ] Before each primitive: official registry search, current docs, `add --dry-run`, `add --diff`, file inspection.
- [ ] Use Radix and official `@shadcn` only. Keep `ui.tsx` facade until imports reach zero.

### Strangler surface order

- [ ] DevHubShell and application chrome.
- [ ] TaskRail.
- [ ] TaskHeader and provider-aware setup.
- [ ] ThreadWorkspace and ActivityTimeline.
- [ ] Stable Composer.
- [ ] InspectorDock.
- [ ] Search/command palette.
- [ ] Settings and secondary utilities.
- [ ] Reduce `App.tsx` to composition/routing only after every extracted surface is covered.

Each slice requires current/minimum/narrow viewport screenshots, Browser/IAB workflow click-through, governing concept/reference inspection with `view_image`, at least five concrete comparison points, visible-copy diff, keyboard/a11y checks, and a `fidelity-ledger.md` entry before the slice flag advances.

## M7 - Cross-provider fork, Work mode, synchronization

- [ ] Implement an allowlisted, attributed handoff model excluding secrets, auth, hidden reasoning, approval credentials, and unreviewed sensitive output.
- [ ] Render preview with target provider/model/mode/cwd/transferred context; create a new native target task; preserve source hash; link both through additive metadata.
- [ ] Implement Work mode with real provider runtime, folder scope, permission profile, outcome progress, artifacts, and deliverables; keep distinct from Code and never call it Cowork.
- [ ] Prove SYNC-1/SYNC-2 continuously and show SYNC-3 only with current-build evidence.
- [ ] Enable fork/work flags only after redaction, source-immutability, native-target, and lease tests pass.

## M8 - Desktop packaging, cutover, performance, cleanup

- [ ] Rebrand visible Tauri/TUI/PWA copy to DevHub while preserving identifier/key migration compatibility.
- [ ] Fix deterministic server sidecar/IPC/API base, strict health identity, PATH-independent provider discovery, tray/hotkey/notification behavior.
- [ ] Preserve archive/export, TUI, analytics, overview, search, Ops/inbox, settings/config, and transcript utilities behind clean secondary navigation.
- [ ] Run browser/PWA and packaged `.app` closed-first-party-client smoke; then repair and verify DMG.
- [ ] Measure warm launch, cached switch, typing, stream cadence, long transcript, animation frames, rerenders, and bundle impact; fix material regressions.
- [ ] Remove legacy paths only after the preservation matrix is green.
- [ ] Remove disposable probes, QA servers, unintended screenshots/previews, mounted images, and temporary generated files.

Final gate:

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run typecheck test build --force
pnpm --filter @devhub/tui smoke
pnpm --filter @devhub/desktop build
git diff --check
git status --short
```

Add provider protocol suites, Browser/IAB workflows, accessibility checks, screenshot comparisons, packaged smoke, and performance commands to this gate as they land. A zero-task lint command is not evidence; introduce a real lint task or explicitly document its absence.

## Final handoff checklist

- [ ] Concise architecture and UX summary.
- [ ] Milestone evidence with exact commands/results.
- [ ] Provider capability and SYNC-1/2/3 tables.
- [ ] Approved concepts/reference/final screenshots.
- [ ] Fidelity ledger and at least five final comparison findings.
- [ ] Accessibility/performance results.
- [ ] Green preservation matrix and intentional deviations.
- [ ] Conditional capability status and remaining risks.
- [ ] Staff-engineer-quality signoff judgment.
- [ ] `tasks/todo.md` checks and review/results complete.
- [ ] Mark the persistent goal complete only after every mandatory DONE criterion has evidence.
