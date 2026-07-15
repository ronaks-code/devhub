STATE: ACTIVE — RESUMED BY RONAK 2026-07-15 (full software implementation authorized; hard gates held)
# STATUS — DevHub
<!-- SOURCE OF TRUTH. Any fresh Claude/Codex chat reads this FIRST, before touching code. -->
<!-- Update rule: edit this file in the SAME commit as the work it describes. Never let it drift. -->

Last updated: 2026-07-15 by Codex goal 019f6268-781e-77a2-898c-2dadacae509f
Goal: Deliver the mandatory M0-M8 DevHub goal as a provider-native Codex-quality environment for real Codex and Claude runtimes, with preservation, review, verification, and conditional gates reported honestly.

Pause authority: Ronak explicitly paused this goal for migration to a background runner. There are zero autonomous next-actions. No agent may resume a test, review, implementation, promotion, or cutover until Ronak explicitly resumes the goal and names the execution target.

Progress: 3 / 9 milestones done (33%) — denominator FROZEN at 9. Do not change it; partial M3-M8 work receives no percentage credit.

Blocker legend:
  [SOFTWARE]    = unblocked, any agent can start now
  [ALEX]        = waiting on Alex (external human)
  [HARDWARE]    = waiting on a physical device / bench test
  [S3]          = waiting on data/asset in S3
  [RONAK-GATE]  = needs Ronak's decision or approval before proceeding

## Core tasks (counts toward %)
- [x] M0  Baseline, backup, preservation, and execution plan                 [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/baseline.md`
- [x] M1  Native provider contracts, reference package, and design approval  [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/provider-spike-results.md`
- [x] M2  Provider-neutral adapter seam and disabled-by-default flags         [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/implementation-plan.md#M2---Provider-adapter-seam`
- [ ] M3  Native Codex vertical slice, including production-wrapper resume    [RONAK-GATE] → RESOLVER: `tasks/HANDOFF.md` (BLOCKED: extra billable proof turn; see Blocked)
- [ ] M4  Persistent Claude vertical slice, including raw lifecycle parity    [RONAK-GATE] → RESOLVER: `tasks/HANDOFF.md` (BLOCKED: extra billable proof turns; see Blocked)
- [ ] M5  Unified provider-locked task/index model                            [RONAK-GATE] → RESOLVER: `.planning/devhub-codex-parity/m5-implementation-plan.md` (PAUSED: explicit resume required)
- [ ] M6  Approved reference-first Codex-style shell                          [RONAK-GATE] → RESOLVER: `.planning/devhub-codex-parity/design-lock.md` (PAUSED: explicit resume required)
- [ ] M7  Cross-provider fork, DevHub Work mode, and synchronization           [RONAK-GATE] → RESOLVER: `.planning/devhub-codex-parity/implementation-plan.md#M7---Cross-provider-fork-Work-mode-synchronization` (PAUSED: explicit resume required)
- [ ] M8  Packaging, cutover, performance, preservation, and cleanup           [RONAK-GATE] → RESOLVER: `.planning/devhub-codex-parity/implementation-plan.md#M8---Desktop-packaging-cutover-performance-cleanup` (PAUSED: explicit resume required)

## Blocked — needs a human (agents STOP here, do not loop)
- GOAL [RONAK-GATE] Ronak must explicitly resume the DevHub goal and identify the background runner/checkout that owns execution. Until then, every remaining item below is paused and no autonomous action is authorized.
- M3  [RONAK-GATE] Needs Ronak to authorize the additional billable Codex production-wrapper resume/continued-conversation proof turn. Added 2026-07-14; keep `nativeCodex=false`.
- M4  [RONAK-GATE] Needs Ronak to authorize additional billable Claude selected-wrapper raw multi-query/resume/permission/interrupt/post-interrupt/fork-continuation proof turns. Added 2026-07-14; keep `persistentClaude=false`.
- M5-T3A [RONAK-GATE] After explicit resume only, the exact next code unit is RED-first bounded FIFO per-locator lanes, operation reservations, observation epochs, `observeListPage`, and `observeTask` in the clean `m5-task3-lanes` worktree based on tested `cdbff7d`. No tests or implementation for this unit have started.
- M5-T3B [DONE 2026-07-15] Shared native->indexed projector + coordinator `readThrough`/degraded-cache/verified-legacy routing landed RED-first on `wip/devhub-background-runner`. 605/605 provider-index tests (16 new in `coordinator-readthrough.test.ts`), full engine 2099/2099, typecheck + public-surface + `git diff --check` clean. Independent SPEC + QUALITY/SECURITY GO recorded below. Flags unchanged (`nativeCodex`/`persistentClaude`/`unifiedTaskIndex` false). NOT promoted to `campaign/auto-improve`.
- M5-T3C [DONE 2026-07-15] Bounded `coordinator.rebuild({provider,home,signal?})` landed RED-first on `wip/devhub-background-runner`: `beginStage` -> paginate native list (`includeArchived:true`, `limit=pageSize`) honoring defaults + hard caps, reject oversized pages/non-canonical (1..4096 UTF-8) / exact-repeat cursors, dedupe locators (winner = greatest non-null revision `updatedAt`, tie -> later page/item), point-read every final locator `includeTurns:true` in serialized-locator order via `stageSnapshot` only, pass exact five counts (`taskCount=snapshotCount=receiptCount=unique`, turn/event totals recomputed) to `promoteStage` with `providerVersion=null`. Synchronous non-overlapping heartbeat (cadence `max(250, floor(stageLeaseMs/3))`) via injected timers before/after each provider call and before each stage write/promotion; injected `now` is sole monotonic deadline authority (throw/regress/invalid -> CLOCK_FAILURE). Pre-abort -> CANCELLED before `beginStage`; mid-run cancel/deadline invalidates a run token, drains the heartbeat, aborts the exact stage, and reports cleanup/stage-loss ahead of CANCELLED/REBUILD_TIMEOUT. Per-locator observation epochs pinned + rechecked before promotion (newer read -> STALE_OBSERVATION). Single-flight REBUILD_BUSY; observation reservations released on all terminal paths; zero provider mutation calls; failed/aborted rebuilds `abortStage` and retain the prior active generation. New `coordinator-rebuild.test.ts` (23 tests). Changed files: `provider-index/coordinator.ts` + the new test only. 628/628 provider-index, 2122/2122 engine, typecheck + public-surface + `git diff --check` clean. NOT promoted to `campaign/auto-improve`; flags unchanged.
- M5-T4-9 [RONAK-GATE] After Task 3 promotion, complete Tasks 4-9 serially under their existing review, induced-failure, cutover, and rollback gates.
- M6 [RONAK-GATE] Resume the approved reference-first shell only after Ronak resumes the goal and M5 is complete.
- M7 [RONAK-GATE] Resume cross-provider fork/Work-mode/synchronization only after Ronak resumes the goal and M6 is complete.
- M8-SOFTWARE [RONAK-GATE] Resume packaging/performance/preservation/cleanup software work only after Ronak resumes the goal and M7 is complete.
- M8  [RONAK-GATE] If signed/notarized distribution is required and Apple credentials are absent, Ronak must provide/authorize them. Conditional as of 2026-07-14; do not fake-pass signing.
- QA  [RONAK-GATE] First-party `com.openai.codex` Computer Use requires a host build whose allowlist permits that bundle. Added 2026-07-14; DevHub's own browser/Computer-Use QA remains allowed.

No [ALEX], [HARDWARE], or [S3] dependency exists for this project.

## Added after freeze (does NOT count toward %)
- None.

## Active worktrees / WIP branches
- `wip/devhub-background-runner` at `this commit` — PAUSED handoff branch (sole resume target unless Ronak names another checkout). Carries additive, un-promoted WIP built in the background runner: Task 3 M5 coordinator observation lanes (`observeListPage`/`observeTask`, bounded per-locator FIFO lanes, `maxObservationOperations` reservations, per-locator observation epochs). 589/589 provider-index tests, full engine 2083/2083, typecheck + public-surface + `git diff --check` clean. NOT promoted to `campaign/auto-improve`; no independent SPEC/QUALITY/SECURITY GO yet; `nativeCodex`/`persistentClaude`/`unifiedTaskIndex` remain false; no rebuild/read-through/server/flag work. The goal-level pause still stands.
- `campaign/auto-improve` at `cdbff7d` — tested shared branch; M5 E/F plus the Task 3 native-missing, verified-legacy mapping, opaque observation, atomic-missing, and coordinator-foundation prerequisites are integrated after exact mainline gates and independent SPEC/QUALITY/SECURITY GO.
- detached `m5` at `3808d21` — exact reviewed M5 E source retained read-only after promotion; current goal coordinator.
- detached `m5-f` at `4244c39` — historical reviewed F internal-foundation source; read-only and never replayed wholesale.
- detached `m5-facade` at `6e1804c` — exact reviewed M5 F facade source retained read-only after promotion; current goal coordinator.
- detached `m5-task3-contracts` at `537891d` — exact reviewed Task 3 native-missing source retained read-only after promotion; current goal coordinator.
- detached `m5-task3-store` at `364d736` — exact reviewed verified-legacy mapping source retained read-only after promotion; current goal coordinator.
- detached `m5-task3-observation` at `307c223` — exact reviewed Task 3 observation/atomic-missing source retained read-only after promotion; current goal coordinator.
- detached `m5-task3-coordinator` at `1836785` — exact reviewed Task 3 coordinator foundation/initialization source retained read-only after promotion; no lanes/rebuild/read-through/server/flag scope.
- `m5-task3-lanes` worktree — checked out on `wip/devhub-background-runner`; RED-then-green landed for the M5 coordinator observation-lanes slice (`observeListPage`, `observeTask`, FIFO per-locator lanes, `maxObservationOperations` reservations released on all terminal paths, per-locator observation epochs). New test file `packages/engine/test/provider-index/coordinator-observe.test.ts` (12 tests); only `coordinator.ts` and that test changed. Owned paths clean. THEN: M5-T3B landed on the same worktree/branch — a shared backend-only native->indexed projector (`projectNativeTaskSummaryForIndex`/`projectNativeTaskSnapshotForIndex` in `store-codec.ts`, reusing the codec's registered-home/containment/redaction/identity/fingerprint prepare rules) plus `ProviderTaskIndexCoordinator.readThrough({locator,projection,allowDegradedCache})` and `resolveVerifiedLegacySession(sessionId)`. New test file `packages/engine/test/provider-index/coordinator-readthrough.test.ts` (16 tests). Changed files this slice: `provider-index/coordinator.ts`, `provider-index/store-codec.ts`, `index.ts`, and the new test. 605/605 provider-index, 2099/2099 engine, typecheck+public-surface+diff-check clean. THEN: M5-T3C landed RED-first on the same worktree/branch — `coordinator.rebuild({provider,home,signal?})` (bounded rebuild/dedupe/final reads/staging/promotion + heartbeat/cancel/deadline lifecycle; see the M5-T3C DONE entry above). New test file `coordinator-rebuild.test.ts` (23 tests). Changed files this slice: `provider-index/coordinator.ts` and the new test only. 628/628 provider-index, 2122/2122 engine, typecheck+public-surface+diff-check clean.

## M5-T3B independent gate record (2026-07-15)
- SPEC GO — Matches the T3B contract: home resolution (store `UNKNOWN_HOME`) before provider access; native success wins and writes through under the pre-captured opaque observation token (pre-promotion returns the frozen path-free projection with no published generation); authoritative-missing (`NATIVE_TASK_MISSING`) calls `markNativeTaskMissing(token)` in the store's owned txn and never consults cache/gzip; other failures drop the token without mutation and use cache only when `allowDegradedCache` and `cacheDetail` matches (snapshot requires `cacheDetail:'snapshot'`; summary consumes either) else rethrow the registry-sanitized provider error with cache corruption outranking it; token drift fails `RECONCILIATION_CAS_MISMATCH`; `RECONCILIATION_REQUIRED` never enters the missing transition. Scope note: verified-legacy routing is engine-only here (delegates to `getVerifiedLegacySessionMapping`, which is written only post-native-verification via `mapVerifiedLegacySession`; unresolved provenance returns null → stays on the legacy path). Broader sessionId→adapter wiring stays with later Task-3 server/web units.
- QUALITY GO — Projector reuses the codec `prepare*` rules (no rule duplication); token lifecycle is a single `try/finally` with a tolerant post-commit drop; small explicit field-maps for summary/cache projections; removed now-dead `void this.registry`. Focused RED-first suite; no changes outside authored files.
- SECURITY GO — Outputs are path-free (canonical home used only to build the backend registry key/registration, never returned); errors stay value-free/sanitized (tests assert no `/tmp/`); the opaque token is never exposed by the coordinator and atomic CAS prevents a late provider result from overwriting/deleting newer authority; hostile `readThrough` input is rejected before any provider access.
- `wip/devhub` at `641af8e` — remote-backed WIP with user-owned dirt and evidence; never merge wholesale.
- detached `m5-c0-schema` at `377a724` and `m5-cursor` at `82a8b74` — stale; do not build on them.

## Recent checkpoints (last 3 tested commits on shared branch)
- `cdbff7d`  Task 3 coordinator foundation/initialization promotion; 577/577 provider-index tests plus exact-tip SPEC/QUALITY/SECURITY GO.
- `5e8303c`  Task 3 opaque observation and atomic-missing promotion; 556/556 provider-index tests plus exact-tip SPEC/QUALITY/SECURITY GO.
- `ca9f180`  Task 3 verified-legacy mapping lookup promotion; 532/532 provider-index tests plus exact-tip SPEC/QUALITY/SECURITY GO.
