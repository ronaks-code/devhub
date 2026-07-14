# Claude UI — Todo & Review

Full plan: `~/.claude/plans/federated-swimming-penguin.md`

## Status: M0–M5 complete

- [x] **M0** Monorepo scaffold (pnpm + Turborepo: engine / server / web)
- [x] **M1** Read path — browse + render past chats across all projects (newest-first, grouped by true cwd, huge-file-safe, rename/pin, live SSE)
- [x] **M2** Live chat — drive Claude Code in-app over WebSocket (streaming, model/permission toggles, resume, stop, cost); wraps local `claude` CLI
- [x] **M3** Search — cross-project FTS5 + ⌘K palette with highlights
- [x] **M4** Oversee — Dashboard: running-now sessions + usage analytics (totals, top projects, 30-day activity)
- [x] **M5** Faces — Ink TUI (imports engine directly) + Tauri desktop shell (loads web in a native window)

## Verified
- 23 engine unit tests pass; all 4 TS packages typecheck; web builds; TUI smoke renders.
- Live chat verified in-browser (real response + cost footer); driver verified live (wrote + recalled a file).
- Search returns ranked highlighted hits across projects; Dashboard shows 3 live processes + analytics.
- Tauri shell scaffolded + compiles (needs rustc ≥ 1.88).

## Run
```bash
pnpm install && pnpm dev      # web http://localhost:5173 + API :8787
pnpm tui                      # terminal face
pnpm desktop                  # native window (after pnpm dev)
```

## Key decisions / gotchas (don't relitigate)
- Driver wraps local `claude` CLI (your login, no API key); process-per-turn + `--resume`; permission-mode toggle (no inline approve/deny: CLI lacks `--permission-prompt-tool`, default mode auto-denies headless).
- `node:sqlite` via `createRequire` (Vite/vitest can't bundle the new builtin). FTS5 IS in Node 24's sqlite.
- Group sessions by in-file `cwd` (folder encoding is lossy); claude-mem observer logs filtered out.
- @fastify/websocket route registered in a child plugin so its onRoute hook applies.
- Never edit transcripts; custom names/pins/tags live in our SQLite sidecar.

## Remaining follow-ups (not blocking)
- Inline per-tool approve/deny (needs SDK control-protocol).
- Desktop standalone packaging: bundle the Node server as a Tauri sidecar + sign/notarize.
- Desktop global hotkey + tray (plugins scaffolded path); search snippet uses `[ ]` FTS markers.
- Optional: filter more internal session noise; model breakdown in analytics.

---

# DevHub Provider-Native Codex Parity Program

Authoritative program plan: `.planning/devhub-codex-parity/implementation-plan.md`

The earlier Claude UI decisions above describe the preserved legacy adapter only; the DevHub program decisions below supersede them for new provider-native work.

## Status: M0-M2 and M3 implementation complete; M3 live-wrapper resume artifact blocked by the provider-turn cap; M4 implementation and deterministic gates complete with exact visual evidence and the capped raw-live proof still open; M5 architecture approved and implementation starting

### M0 - Baseline and preservation

- [x] Record branch, HEAD, dirty/staged/untracked state, versions, hashes, and uncached quality gates.
- [x] Create a protected out-of-tree backup with full copies, binary patches, and verified SHA-256 manifests.
- [x] Inventory routes, features, persistence, shortcuts, desktop/TUI integrations, APIs, and tests.
- [x] Write baseline, preservation matrix, risk register, and execution-ready implementation plan.
- [x] Preserve the original dirty work exactly; revert the one command-generated Cargo manifest normalization.

### M1 - Provider contracts

- [x] Research current official Codex app-server and installed `0.144.1` schema/capability surface.
- [x] Research current official Claude CLI/Agent SDK contracts and installed Claude CLI `2.1.207`.
- [x] Run the bounded Codex native handshake/lifecycle/synchronization spike (2/2 billable turns).
- [x] Run the bounded Claude native lifecycle/synchronization spike under API-key auth (2 normal turns + 1 explicitly allowed unresolved-lifecycle turn).
- [x] Write capability matrix, spike results, synchronization contract, and both ADRs.
- [x] Prove both providers' native start/stream/interrupt/persistence/restart/resume gate; keep selected raw Claude adapter controls false until M4 reproduces the reference-client contract.

M1 gate result: both native provider lifecycles pass. Persistent installed Claude CLI is selected because the stricter Agent SDK selection gate still lacks live skill/subagent/background proof. Raw multi-query/resume/control parity, reliable Claude model selection, and SYNC-2 leases remain explicit implementation gates. Production frontend remains paused until the single design approval package is approved.

### Reference, concepts, and approval

- [x] Capture and measure the installed ChatGPT/Codex build `26.707.51957 (5175)` sufficiently for the bounded concept phase (Computer Use host-blocked; four wide-shell states captured; unavailable transient/narrow/motion states explicitly classified as unobserved).
- [x] Complete the disposable shadcn brownfield initialization preview; CLI 4.13.0 requires a named/custom preset, and the permitted Custom path made no changes. Deviation is batched into the single design gate.
- [x] Generate and inspect eight sequential reference-derived concepts and exactly two targeted semantic corrections; retain exact briefs, inputs, hashes, and discrepancies.
- [x] Present the single numbered design/architecture/plan package and stop for explicit approval.

### Post-approval delivery

- [x] Write and verify `design-lock.md`, `design-system.md`, `component-state-matrix.md`, and `surface-inventory.md` before production edits.
- [x] Restore the shared heavy-job queue to an upgrade-safe state before further Browser/Computer Use or full-gate work.
  - [x] Replace the mutable canonical script with a stable launcher plus atomically selected immutable implementation files.
  - [x] Prove that a waiter pinned to implementation A survives a pointer swap to B, runs, releases, and emits exact append-only `waiting`/`running`/`done` events while the next invocation uses B.
  - [x] Re-run FIFO, exit propagation, cancellation, owner-crash recovery, admission, duplicate-pair, path-safety, cleanup, and exact-schema drills; obtain independent read-only review.

Shared-wrapper result: immutable D is canonical and independently GO; exact hashes, continuous-lock migration, append-only prefix proof, smoke lifecycle, and the disclosed historical H rewrite incident are recorded in `.planning/devhub-codex-parity/evidence/shared-heavy-wrapper-cutover.md`.
- [x] M2 provider adapter seam.
- [ ] M3 native Codex vertical slice.
  - [x] Bounded JSONL/RPC protocol, exact fallback shapes, request correlation, backpressure, physical stderr bounds, secret redaction, and no-drop EOF drain.
  - [x] App-server process lifecycle and generation-bound reconciliation barrier.
  - [x] Canonical-home supervisor, restart circuit breaker, and stable request dispatcher.
  - [x] Native adapter, authenticated server broker/routes, and existing-UI integration.
  - [ ] Synthetic and bounded-live lifecycle/recovery/capability gate; synthetic and one-turn live paths pass, but production-wrapper live resume/continued conversation is not re-proven after scratch cleanup. Keep `nativeCodex` disabled by default.
- [ ] M4 persistent Claude vertical slice.
  - [x] Bounded persistent CLI transport: absolute executable/home, exact stream/control argv, serialized stdin, fail-closed JSONL, bounded redacted stderr, native UUID capture, and graceful drain/shutdown.
  - [x] Correlated control/permission peer, bounded backend-only drift diagnostics, and requested/init/assistant/billed model reconciliation. Selected-wrapper raw lifecycle evidence remains a separate blocked live gate.
    - [x] Strict bounded Claude control wire parser/builders pinned to official Agent SDK `0.3.207`, including replay, cancellation, unknown-subtype, mutation, prototype, Proxy, and resource-bound tests.
    - [x] Outbound generation-bound control correlation, deadlines, aborts, interrupt receipts, reentrant delivery, sanitized diagnostics, and lifetime ID reservations.
    - [x] Inbound duplicate/replay correlation, cancellation, deadlines, nonblocking pending replay, and bounded lifetime reservations.
    - [x] Fail-closed internal Write/Edit permission response bridge; capability remains unadvertised pending live proof.
    - [x] Requested/init/message/assistant/billed model evidence ledger with immutable provenance and mismatch detection.
    - [x] Raw event normalization into browser-safe events and model evidence observations.
  - [x] Supervisor, official session helpers, one-writer lease, provider adapter, server runtime, and existing-UI integration behind disabled-by-default `persistentClaude`.
    - [x] Supervisor restart/circuit/auth/disable composition and quiescent handler/configuration rebinding independently reviewed.
    - [x] Official Agent SDK `0.3.207` session helpers use an isolated real child and process-wide four-child capacity gate.
    - [x] SQLite writer lease retains monotonic epochs/tombstones, reread fencing, reentrancy guards, and real multi-process/crash tests.
    - [x] Native Claude adapter/server composition fail closed for uncertain start/send/fork/control outcomes, external drift, and bounded revision capacity.
    - [x] Settings request/effective-state toggle and provider-aware existing native pane/Chat route integration implemented; final exact-copy Browser and Computer Use recapture passes.
    - [x] Active-turn child crash publishes one uncertainty terminal, latches reconciliation, and blocks another mutation until authoritative review.
    - [x] Clean idle release/reacquisition permits handler/policy rebinding only for a fully stopped, quiescent entry.
    - [x] Resume preserves attested Claude permission policy; missing evidence requires explicit non-elevating policy repair.
    - [x] Persistent child env strips DevHub and cross-provider credentials while retaining the selected Claude auth and operational allowlist.
    - [x] Terminal-ordering tests cover provider-terminal-before-exit, intentional shutdown, fulfilled/rejected termination, hostile clocks/sinks, and receipt-correlated user cancellation.
  - [x] Deterministic lifecycle, fallback, Browser/Computer Use, and full-repo gates.
  - [ ] Selected-wrapper raw multi-query/resume/permission/interrupt/post-interrupt/fork-continuation live gate; the three-turn cap is exhausted, so keep the flag disabled and report this as blocked rather than passed.
- [ ] M5 unified provider-locked task/index model.
  - [x] Complete a read-only audit of v13 SQLite, portable archive, provider identities, leases/revisions, routes, URL/localStorage, env/data paths, and webhook identifiers.
  - [x] Write the execution-ready TDD/review plan in `.planning/devhub-codex-parity/m5-implementation-plan.md`.
  - [x] Obtain independent architecture/specification GO on the exact M5 plan.
  - [x] Add versioned path-free provider locators plus collision-safe event replay identities.
  - [ ] Add the additive v14 home/sync/cache/replay/meta/fork/legacy-map/reconciliation schema and store.
  - [ ] Add staged provider census, read-through/rebuild, verified legacy mapping, cache invalidation, and native-deletion/no-gzip-resurrection behavior.
  - [ ] Give Codex the proven task writer lease and give both providers durable revision latches/external-mutation refusal without regressing Claude's reviewed semantics.
  - [ ] Add authenticated locator-only index routes and the instant flag-off legacy rollback path.
  - [ ] Make portable v2 metadata-only by default; retain explicit v1 export/read compatibility with v1 imports quarantined as unresolved legacy cache.
  - [ ] Migrate URL/localStorage/env/data-path/webhook identifiers with legacy reads/aliases and no raw-home disclosure.
  - [ ] Pass induced-failure, delete/rebuild/rollback, Browser, independent-review, full-repo, packaging, preservation, and flag-cutover gates before enabling `unifiedTaskIndex`.
- [ ] M6 approved Codex-style shell.
- [ ] M7 cross-provider fork, Work mode, and synchronization.
- [ ] M8 desktop packaging, cutover, performance, preservation, and cleanup.

## M0 review/results

- Protected backup: `/Users/ronak/.codex/backups/devhub-codex-parity/20260713T001908Z` and matching `.tar.gz`; 13/13 source files verified byte-for-byte.
- Uncached typecheck: 5/5 pass.
- Uncached build: engine/server/web 3/3 pass.
- Uncached tests: 622/624 pass; two `project-overview` assertions use June 10-11 fixtures that aged outside the production 30-day window.
- TUI smoke: pass, with legacy `Claude UI` copy recorded.
- Desktop: release binary and `.app` build; DMG Finder/AppleScript layout step exits 1.
- Lint command: exits 0 but executes zero tasks, so it is not counted as a quality gate.
- No pre-existing user change was overwritten, staged, committed, or discarded.

## M1 review/results (current)

- Codex schema: 267 stable JSON Schema files + 598 stable TypeScript files generated from CLI 0.144.1; versioned manifest verified.
- Codex native lifecycle: handshake, complete turn, persistence, app-server restart, same-ID resume, streamed nonce continuity, interrupt, fork, archive/unarchive all proven.
- Codex compatibility findings: DevHub task classified as `vscode`, resume reported `dangerFullAccess` without explicit override, and archive round-trip lost fork provenance.
- Codex SYNC-3: verified by direct native-ID navigation in app build 5175; both turns rendered. Sidebar discovery remains unproven because Computer Use is host-blocked.
- Codex probe cleanup: source and fork deleted through app-server after capture; both verified unreadable, with no direct native-file mutation.
- Claude auth: an ignored local API key was found after the initial environment audit and verified as `authMethod:"api_key"` under isolated `CLAUDE_CONFIG_DIR`; its value never entered output or retained evidence.
- Claude direct selected-transport proof: CLI 2.1.207 created native UUID `df6288da-e4f7-48b1-a7ab-323c1e4c92fe`, streamed/completed a nonce turn, persisted, and emitted all three settings-source hooks plus plugin/skill/agent inventory.
- Claude reference-client proof: Agent SDK 0.2.116 restarted the installed CLI, resumed the same UUID, recalled the nonce through SDK MCP, handled one exact scratch Write approval, and acknowledged native interruption. Official helpers passed list/read/rename/fork creation/delete.
- Claude turn budget: 3 total. The third was the prompt-authorized exception for one unresolved lifecycle state after `sleep 30` was natively auto-approved and the original interrupt trigger did not arm.
- Claude selection: persistent CLI remains primary. SDK execution is not selected because live skill invocation, subagent execution, and background supervision were not all proven. Raw DevHub resume/permission/interrupt, post-interrupt resume, and fork continuation stay false until M4.
- Claude model finding: direct init reported Haiku but the assistant/usage metadata reported and billed Sonnet 5; reliable model selection is capability-gated.
- Claude cleanup: source and fork were deleted through official helpers; retained evidence is secret-clean and checksum-verified; scratch roots and temporary harnesses were removed.
- Overall M1 provider gate: pass. SYNC-2 lease/revision behavior remains unimplemented for both providers and is not claimed.

## Reference/concept review/results

- Four current-build captures cover completed, sparse/interrupted, active-goal, and empty-native-task wide-shell states at `1800x1130`; the empty scratch task was deleted through app-server and verified unreadable.
- The current unmodified DevHub Search dialog was additionally exercised with the in-app Browser, populated with real results, captured at `1280x720`, reopened with `view_image`, and recorded as preservation-only authority for Search behavior; the browser tab and temporary servers/listeners were cleaned up.
- Measured shell anchors include the 273-unit rail, 46-unit header, 736-unit transcript/composer, 736x98 composer, 300-unit content-height inspector, stable bottom anchoring, and observed compact task/activity/goal controls.
- Computer Use could not control `com.openai.codex`; the authorized screenshot/direct-navigation fallback was used. Menus, transient approval/input/recovery UI, narrow layouts, and motion timing remain explicitly unobserved rather than inferred.
- ImageGen completed 8/8 initial concepts and 2/2 targeted corrections sequentially with no retry. Corrected concept 3 adds fail-closed capability gating; corrected concept 7 selects Work and uses Claude-native identity/permission language.
- All ten PNGs are 1536x1024, were opened at original detail with `view_image`, and have SHA-256 provenance in `concepts/00-concept-ledger.md`.
- The single approval package is `.planning/devhub-codex-parity/design-approval-package.md`. It recommends the reference-first DevHub direction and records copied versus added behavior, provider architecture, responsiveness/motion, milestones, limitations, and all generated-image caveats.
- Final staff review blockers were resolved without exceeding the ImageGen cap: Search results are distinct from Commands; the corrected cancellation detail uses the readable initial tile; Claude fork permissions use `Default` with a required attributed handoff; and the package explicitly requests the auditable custom-Radix-preset deviation required by shadcn CLI 4.13.0.
- No production frontend code was changed before the gate. Next authorized step is design lock and M2 only after the user explicitly approves the recommended direction.
- Approval received: user explicitly approved the recommended DevHub direction, including the governing source hierarchy, corrected concept clarifications, provider architecture/gates, responsive scope, M2-M8 sequence, and auditable custom-Radix-preset deviation.

## Post-approval design-lock review/results

- The four governing artifacts are `.planning/devhub-codex-parity/design-lock.md`, `design-system.md`, `component-state-matrix.md`, and `surface-inventory.md`.
- Final independent staff review: GO. Behavioral capability truth precedes visual controls; measured inspector geometry is 12 top/16 right; provider-specific permissions/model gates and bidirectional fork semantics are explicit; Search and Commands remain separate; the custom-Radix deviation stays bounded and auditable.
- Every major component family includes all 12 required states. Environment is a persistent non-tab inspector summary above exactly five destinations. Canonical component ownership and preserved-copy cutover rules are unambiguous.
- All local Markdown links resolve, no trailing whitespace remains, and `git diff --check` passes.

## M2 review/results

- Provider-neutral adapters, immutable canonical native keys, capability flags, normalized events, the full registry, and backend-resolved feature flags are implemented with all six flags defaulting false.
- The legacy Claude path and read-only Codex history fallback remain behavior-compatible under flags off. The Codex fallback is confined to `<effectiveHome>/sessions` and rejects parent/sibling symlink escapes.
- Raw OpenAI Chat is explicitly development-only/not Codex, has no local tools, is disabled by default, and requires explicit opt-in plus authenticated REST and first-frame WebSocket access before any billable call.
- Independent staff audit found and closed five test gaps: resolution-before-request replay, cross-task event ownership, shared-session WebSocket concurrency, non-default Codex-home misattribution, and invalid fractional/unsafe JSON-RPC numeric IDs.
- Exact fresh suites pass: engine 637/637, server 135/135, and web 42/42. The forced monorepo gate passes 11/11 tasks and builds both the release `.app` and x64 DMG.
- `git diff --check` passes. The Tauri command-generated `Cargo.toml` normalization was restored to the preserved baseline after packaging. No Python or live provider call was used for M2.
- The known pre-existing index-worker `parse-session.js` warning still falls back synchronously without failing tests; it is not claimed fixed.

## M3 review/results (in progress)

- Protocol core received independent production GO after four review/fix rounds. It rejects malformed, partial, oversized, duplicate, replayed, timed-out, cancelled, and schema-drifted RPC traffic fail-closed while preserving already-decoded lifecycle/request frames across EOF.
- Physical and logical queue bounds are both proven: a 4 KiB stderr ring presented with one 2 MiB complete line retained 4,096 logical bytes and 8,192 bytes of owned backing storage, not a view into the oversized allocation. Structured/split Authorization, Proxy-Authorization, Cookie, Set-Cookie, token, key, secret, and password forms are redacted.
- Fresh protocol gate: 123/123. Fresh full engine gate: 760/760. Engine typecheck/build and `git diff --check`: pass. Only the pre-existing index-worker synchronous-fallback warning remains.
- App-server process received independent GO after adversarial exit/close/EOF, early/late spawn, startup/reconcile, real-peer drain, backpressure, signal, teardown, and restart-safety review. Root-owned fresh gates pass: 53/53 process, 176/176 process+protocol, and 813/813 full engine tests; engine typecheck/build and diff/whitespace checks pass.
- Canonical-home supervisor received independent GO with no P1-P3 findings after unsafe-terminal, shutdown/cancellation, generation-overlap, timer-host, circuit/backoff, handler-ownership, resource-bound, and factory-quarantine review. Fresh gates pass: 53/53 focused supervisor tests and 866/866 full engine tests; typecheck/build pass. Home/process caps are absolute, expired safe history is bounded-LRU evictable, generations remain globally monotonic, and an unconfirmed child can never be replaced.
- No Python, live provider turn, network call, branch/worktree operation, staging, commit, or push was used for the protocol/process tasks.
- Native adapter, authenticated provider routes, serialized browser client, server-resolved feature persistence, lazy existing-UI route, drafts, virtualization, request controls, task keyboard navigation, archive dialog/focus discipline, and fail-closed reconciliation are implemented. Rollout parsing remains read-only degraded fallback.
- Independent M3 UI review returned GO with no P1-P3 findings. The final fresh web gate is 140/140 tests; web typecheck/build and `git diff --check` pass. The native lazy chunk is 75.15 kB raw / 21.39 kB gzip.
- Browser/IAB proves wide active/completed/create/archive, blank empty canvas, 768px no-overflow, loading, uncertain offline mutation, reconciliation review, policy-gated recovery, unsupported capabilities, guarded input, cancellation, theme, motion, and 600-message virtualization. Exact logs and screenshots are under `.planning/devhub-codex-parity/evidence/m3/`; `fidelity-ledger.md` and the visible-copy diff record M6 deferrals honestly.
- The bounded live production seam created task `019f5b78-18c0-7b60-8f0c-6afc120ecd7d`, streamed and persisted one completed turn, survived app-server and DevHub restarts, and reread the same native ID/nonce. Official `thread/delete` cleanup succeeded and absence was verified.
- Live production-wrapper Resume remains **not complete**. The contemporaneous call returned 409; a later zero-turn policy probe proved start policy but `thread/resume` returned `NO_ROLLOUT` because no model turn existed. The contract's two turns plus one unresolved-lifecycle extra are exhausted, and using an unrelated user task is out of scope. M1 direct resume/continuity and synthetic production-seam recovery are supporting evidence only. The default feature flag remains off.
- `@oai/sky` listed the first-party app but host policy rejected `get_app_state` for `com.openai.codex`; Computer Use state/screenshots remain an explicit blocker, not a pass. Browser evidence applies only to DevHub.

## M4 review/results (in progress)

- The persistent CLI transport slice has independent specification and code-quality GO after adversarial fixes for bounded ingress/outbound/stderr ownership, shutdown-before-spawn and start-only spawn timeouts, timer exceptions/synchronous callbacks, stalled envelope handlers, post-fault delivery, and exit-before-stdio-drain ordering.
- Root-owned transport gate: 40/40 focused tests, 1,058/1,058 full engine tests, engine typecheck/build, and `git diff --check` pass. The pre-existing index-worker missing-built-module warning still falls back synchronously.
- The strict control-shape slice has independent specification and code-quality GO after fixes for opaque future subtypes, pre-scan key bounds, hostile thrown-Proxy sanitization, modeled-field-only validation, and optional builder arguments. Root-owned gates pass 39/39 focused and 1,097/1,097 full engine tests plus typecheck/build/diff hygiene.
- The outbound control-peer slice has independent specification and code-quality GO after fixes for valid optional interrupt receipts, unsafe request-ID reuse, and reentrant terminal reservation. Root-owned gates pass 28/28 focused and 1,125/1,125 full engine tests plus typecheck/build/diff hygiene.
- The inbound control-peer slice has independent specification and code-quality GO after a test-first fix moved pending-request traversal out of the synchronous receive path. Root-owned gates pass 43/43 focused and 1,140/1,140 full engine tests plus typecheck/build/diff hygiene; duplicate and replay handling, exact cached retransmission, cancellation, deadlines, aggregate/lifetime caps, shutdown, and secret-safe no-retry failures are covered.
- The internal permission bridge has independent specification and code-quality GO after test-first fixes for exact browser identity, throw-after-reentrant-Allow, orphan resolution, resolution-normalizer failure, and reentrant-close ledger cleanup. Root-owned gates pass 20/20 bridge, 63/63 bridge-plus-peer, and 1,160/1,160 full engine tests plus typecheck/build/diff hygiene. Only exact Write/Edit reaches an identity-only internal request; all unsupported, interaction, cancel, timeout, close, capacity, and delivery-failure paths deny, and no capability flag or barrel export changed.
- The model-evidence ledger has independent specification and code-quality GO after test-first fixes for hostile recursive append, poisoned internal errors, and throwing constructor accessors. Root-owned gates pass 15/15 focused and 1,175/1,175 full engine tests plus typecheck/build/diff hygiene. Requested, init, stream-start, assistant, per-model billed, and unattributed total usage stay as separate immutable observations; divergence is reported without inventing an effective model.
- The raw event normalizer has independent specification and code-quality GO after test-first fixes for malformed known frames, hostile boundaries, atomic start correlation, replay-order independence, parent/subagent stream isolation, and missing/older delta replay. Root-owned gates pass 14/14 focused and 1,189/1,189 full engine tests plus typecheck/build/diff hygiene. Synthetic fixtures mirror the retained secret-clean CLI shapes without copying a private transcript; thinking, signatures, tool input/results, hook I/O, result text, permission denials, credentials, hidden reasoning, and MCP payloads never enter browser events.
- The official helper boundary now uses the pinned Agent SDK in an isolated Node child with an exact one-request/one-response protocol, no inherited parent secrets, bounded stdin/stdout/stderr/time, real kill-path integration tests, and a process-wide four-child gate charged exactly once. Focused helper tests pass 16/16; final independent review is running.
- The writer lease now retains per-key tombstones so clean release/reacquisition cannot reset the exported epoch (ABA), and reentrant clock/timer callbacks fail closed. Focused lease tests pass 16/16, including barriered cross-process ownership and child-crash expiry takeover; final independent rereview remains.
- Claude supervisor hardening passes 9/9 focused tests: hung failed-generation cleanup cannot block recovery scheduling, hostile clocks fail closed, subscription OAuth is scrubbed, feature disable drains runtimes, and canonical provider-home validation is shared. Independent review remains.
- Final deterministic integration hardening passes focused engine `179/179`, server `65/65`, and web `102/102`; engine/server/web typechecks and `git diff --check` pass. Independent static review found no remaining P1-P3 code issue. The fresh full-repo `typecheck test build` gate passed all `11/11` Turbo tasks after a measured `766,562 ms` FIFO wait and `2m23.664s` execution.
- Final Browser/IAB recapture proves exact copy/options and disabled-to-enabled required-field gating at `1280x720` and `768x720`, with exact document widths and no console warnings/errors. Computer Use independently drove create/completion/idle/interrupt and captured receipt-correlated `Cancelled by you`; first-party Codex control remains host-blocked.
- No Python or live provider/model turn was used. The live Claude raw-lifecycle budget remains exhausted, so `persistentClaude` stays disabled. The noisy 15-minute resource heartbeat is deleted; the independent hourly `:04` status-file automation remains active.

## M5 planning review/results (current)

- The live v13/schema/archive/identity/lease/route/storage/env/webhook audit found the collision, alternate-authority, raw-home, replay, staging, and restart-reconciliation risks before implementation.
- The execution plan now defines generation-keyed staged cache promotion, tagged non-null replay identity, additive metadata and verified-only legacy mapping, durable provider reconciliation CAS, Codex lease parity, a full path-free locator API/SSE boundary, metadata-only portable v2 with quarantined v1 compatibility, identifier aliases, induced-failure drills, and an exact enabled-tip full gate.
- Independent architecture/specification review converged to GO with no P1-P3 findings after three repair rounds. No product code, provider call, Python process, heavy job, or user-owned dirty path was used during planning.
- Task 1 identity slice: exact locator/home fingerprinting, tagged non-null turn/item keys, readable path-free event projection, and private injective replay hashing pass root-owned `87/87` focused tests plus engine typecheck. Independent final specification and quality/security reviews are both GO with no P1-P3 findings after closing UTF-8, hostile-object, timestamp, diagnostic, raw-home, sparse-array, injectivity, and exhaustiveness defects.

## M5 provider-task CWD redaction invariant (complete)

- [x] Add a focused failing regression for rejecting non-null `cwd` when `cwd_redacted = 1`.
- [x] Prove the three allowed states: `(NULL, 1)`, `(NULL, 0)`, and `(non-null, 0)`.
- [x] Add the minimal table-level `provider_task_cache` CHECK without changing schema version 14.
- [x] Run the exact focused migration suite, engine typecheck, and diff hygiene checks.
- [x] Add the final claimed-v14 missing-index tamper regression from adversarial review.
- [x] Record the review evidence and commit the follow-up without amending `8b007f1`.

### Review

- TDD red: the exact migration suite failed only the new forbidden `(non-null cwd, cwd_redacted = 1)` case; 30 prior tests passed.
- Minimal fix: `CHECK (cwd_redacted = 0 OR cwd IS NULL)` on `provider_task_cache`; no schema-version bump or unrelated DDL change.
- Final review regression proves a claimed-v14 database missing `idx_provider_event_cache_task_ordinal` returns only the constant schema-validation error while preserving its version, sentinel row, and missing-index state.
- Fresh final gates: migration tests `32/32`, engine typecheck, and `git diff --check` pass.

### Store-boundary follow-up

- [x] Reject caller-supplied numeric strings such as `"0"` and `"1"` before SQL binding; SQLite affinity coercion is not an API validation boundary.

## M5 store slice 1: pure types, config, and snapshot codecs (complete)

- [x] Add a strict reciprocal `parseCachedTurnKey` with canonical UTF-8/base64url tests and a fixed Unicode vector.
- [x] Define the exact store error union/class, public store shapes, default/hard constants, and frozen hostile-safe normalized config.
- [x] Prove clock/token wrappers, explicit-undefined defaults, numeric-string rejection, individual bounds, and cross-bound validation.
- [x] Prepare summaries/snapshots only when method key, payload key, and registered provider/home agree; preserve the three CWD/redaction states.
- [x] Enforce dense turn/event arrays, global ordinals, native/synthetic identities, canonical persisted event JSON, event fingerprints, snapshot fingerprints, and source-driven receipt bases.
- [x] Strictly decode every `IndexedProviderEvent` variant and reject independent row/JSON/fingerprint/ordinal/turn/item/replay mutations with value-free `CORRUPT_ROW`.
- [x] Prove hostile accessor/proxy handling, Unicode and canonical UTF-8 behavior, deep immutability, and absence of raw provider-home leakage.
- [x] Re-export the public slice, run focused identity+codec tests with two workers, engine typecheck, and diff hygiene, then commit one coherent slice.

### Review

- TDD red checkpoints were diagnostic and isolated: reciprocal parser `1 failed / 87 passed`; identity-owned helpers `4 / 90`; config `32 / 2`; summary/snapshot preparation `10 / 35`; strict decoder `5 / 45`; exported snapshot binding helper `1 / 51`.
- Frozen contract details are explicit: snapshot preimage is `[1, serializeTaskLocator(locator), summary, turns]`; native receipt basis is `native:<revision fingerprint>` while both fallback sources always use `fallback:<snapshot fingerprint>`.
- Raw top-level event ownership and nested request/request-resolved identity ownership are checked before projection; no normalization path can convert a cross-task write into persisted diagnostic data.
- CWD redaction resolves the deepest existing ancestor before component-boundary containment, including root, symlink, and missing-leaf cases. Fixed raw-home/literal-marker snapshot goldens remain distinct and path-free.
- Strict read decoding covers all ten event variants and five request kinds, exact canonical JSON/UTF-8, immutable reconstruction, readable ownership, ordinal tags, and independent row/JSON/key/fingerprint mutations.
- Fresh focused gate: identity plus codec tests `146/146`; engine typecheck and `git diff --check` pass. No SQL, migration, `store.ts`, `index-db`, full suite, provider call, Python process, or user-owned path was touched.

### Independent-review repairs

- [x] Replace the providers-barrel wildcard exports with an explicit path-free store API; keep the raw-home registration carrier, normalized callbacks, prepared persistence shapes, row decoder, and all preparation codecs backend-only.
- [x] Add a dedicated TypeScript public-surface contract so accidental re-export of any backend-only symbol fails compilation, in addition to the runtime export regression.
- [x] Preserve negative safe-integer JSON-RPC request and approval IDs through project, canonical persistence, and strict decode round trips.
- [x] Reject a final canonical persisted-event envelope above `8_388_608` characters before any SQL boundary, while accepting the exact limit. This is `INVALID_INPUT` because the fixed per-value schema/input constraint is violated; `CAPACITY` remains reserved in this slice for configurable aggregate turn/event-count limits.
- [x] Bound every emitted native turn/item cache key to `1_024` characters after UTF-8/base64url expansion, expose only the fixed caller-specific errors, and cover accepted/rejected multibyte boundaries both directly and through snapshot preparation.

### Security-review repairs

- [x] Fail closed when the registered canonical home appears in any persisted summary, revision, or turn scalar; retain only the component-aware cwd redaction exception and prove accepted prepared output is path-free.
- [x] Deep-snapshot each raw provider event exactly once through bounded data descriptors, reject proxies/accessors/symbols/exotics/sparse arrays/cycles/unbounded graphs before projection, and reuse that immutable snapshot for ownership, projection, item identity, and replay identity.
- [x] Validate every write projection through the same exact `IndexedProviderEvent` union decoder used on reads, including write rejection for NUL text and oversized plan/activity/status/diagnostic fields.
- [x] Match SQLite `length()` with an early-exit Unicode-code-point counter at persisted text boundaries, while retaining canonical UTF-8 and NUL rejection; cover ASCII, combining-mark, and astral boundaries.
- [x] Stream the exact frozen fixed-array snapshot preimage into SHA-256 without materializing the aggregate canonical JSON, preserving the established canonical-reference and raw-home/literal-marker goldens.
- [x] Add all prepared summary/turn/event carriers to the negative TypeScript surface fixture and run that fixture from the normal engine `typecheck` script; an induced backend-type export fails with TS2578.

### Security-repair review

- TDD RED was exact and isolated: focused codec tests reported `5 failed / 56 passed`, covering raw-home scalars, SQLite astral length, write/read asymmetry, hostile nested descriptors, and pre-allocation bounds.
- Fresh final gate: identity plus codec tests `157/157` in `14.06s` (`12.82s` test execution); normal engine typecheck ran both the source compiler and the dedicated negative surface fixture; `git diff --check` passed.
- A temporary induced export of `PreparedProviderTaskSummary` made normal engine typecheck fail with TS2578 (`Unused '@ts-expect-error' directive`), proving the fixture is live; the export was removed before the final green gate.
- The repair remains pure codec/types/test/documentation work: no SQL, migration, store implementation, provider process, browser, full suite, Python runtime, main checkout, or user-owned file was touched.

### Recertification repairs

- [x] Preflight exact readable and private-injective content projection sizes with SQLite code-point semantics before clone or materialization; reject the exact root-home `/` plus `8,388,608`-slash amplification case and injective sentinel amplification without allocating expanded output.
- [x] Replace split/join redaction with bounded single-pass replacement and add one internal direct-module cache projection bundle so persistence normalizes once, derives one digest, and never reclones the deep-frozen store snapshot.
- [x] Share one allocation-free surrogate-validating SQLite text counter across identity and store; round-trip exact astral diagnostic code/message/method/shape-key limits and reject first-over, combining-over, NUL, and lone-surrogate inputs.
- [x] Reject proxies before traps at exact-object, dense-array, canonical-JSON, and event-graph boundaries; capture one array length descriptor and enforce turn/remaining-event capacity before key enumeration or element descriptors.
- [x] Replace exported-error passthrough with a lexical capacity sentinel so all sixteen caller-forged public error codes normalize to `INVALID_INPUT` and only internal cardinality overflow becomes `CAPACITY`.
- [x] Make snapshot fingerprint and receipt derivation private over trusted prepared carriers; preserve their canonical-reference and raw-home/literal-marker goldens through end-to-end snapshot preparation.
- [x] Preserve the exact provider identity barrel explicitly while runtime and compiler fixtures prove the internal cache bundle and trusted hashing helpers remain unavailable.

### Recertification review

- TDD RED was isolated and diagnostic: identity plus codec reported `9 failed / 156 passed`; normal engine typecheck independently failed both direct trusted-helper privacy assertions with TS2578 before the exports were removed.
- The exact full-size projection tests prove both readable and injective amplification fail before `structuredClone`; a valid persisted event now records zero clone calls instead of three.
- Fresh final gate: identity plus codec tests `166/166` in `16.56s` (`16.64s` test execution); normal engine typecheck ran source plus the negative public fixture, and `git diff --check` passed. No SQL, migration, store implementation, provider process, browser, full suite, Python runtime, main checkout, or user-owned path was touched.

### Final adversarial recertification repairs

- [x] Cap aggregate canonical event JSON for one prepared task at fixed `64 MiB` UTF-8 bytes and `64 MiB` SQLite code points, with a backend-only byte-limit seam and alias-aware rejection before rematerializing the crossing copy.
- [x] Replace recursive aggregate canonicalization with exact two-pass metrics/emission bounded to depth 32, 1,000,000 visits, 64 MiB output bytes/code points, fixed dense arrays, ancestor cycles, and proxy-free data descriptors.
- [x] Make task-key, locator, event-item, and event-turn extractors proxy-first and descriptor-safe; require top provider/locator and nested request locator identity to agree.
- [x] Require registered-home context while decoding cache rows and manually enforce the writer's home/redaction/native-ID/nonempty-status/diagnostic invariants without reconstructing a native provider event.
- [x] Complete independent adversarial review, rerun the final focused identity/codec gate plus engine typecheck/diff hygiene, and commit the coherent repair checkpoint.

### Final adversarial recertification review

- TDD RED was isolated: identity plus codec reported `6 failed / 165 passed`, covering proxy-first locator/extractor handling, canonical expansion bounds, aggregate budget enforcement, and registered-home decode equivalence.
- The aggregate gate measures the final canonical representation in both SQLite code points and UTF-8 bytes. Exact-boundary ASCII and astral cases pass, first-over fails with `CAPACITY`, and the third repeated alias is rejected after exactly two source-text descriptor reads.
- The canonical encoder preflights exact escaped output before emission, preserves the established lexical JSON output, rejects a 31-level alias DAG at the visit cap, and rejects control-character expansion above 64 MiB without constructing that result.
- Independent adversarial review and the test-only boundary rereview both returned GO with no P0-P2 findings. The follow-up proves exact depth-32 acceptance/depth-33 rejection and multibyte repeated-alias first-byte-over rejection.
- Fresh final gate: identity plus codec tests `174/174` in `16.78s` (`17.46s` test execution); normal engine typecheck ran source plus the negative public fixture; `git diff --check` passed. No SQL, migration, store implementation, provider process, browser, full suite, Python runtime, main checkout, or user-owned path was touched.

### Canonical array visit-cap follow-up

- [x] Prove a dense 1,000,000-null array is accepted with exact canonical length and SHA-256 while a 1,000,001-slot array rejects before key enumeration.
- [x] Derive the canonical visit cap from the array-item cap plus the root visit, preserving the deliberate complexity ceiling without an off-by-one.
- [x] Rerun focused identity/codec tests, engine typecheck/public-surface fixture, and diff hygiene; record the repair as a new commit without rewriting the prior checkpoint.

### Canonical array visit-cap review

- TDD RED reproduced the defect exactly: the declared maximum dense array failed because root plus 1,000,000 primitive elements requires 1,000,001 visits.
- The minimal fix defines `MAX_CANONICAL_JSON_VISITS` as `MAX_CANONICAL_JSON_ARRAY_ITEMS + 1`; the fixed maximum produces 5,000,001 canonical characters with SHA-256 `cb6de8b9c9a77e11b64b829ec767c4aa407ac87dd10a14812044a5ff25346ec0`.
- Independent follow-up review returned GO: the cap grows by exactly one root visit, the fixed hash was independently verified, and first-over rejection remains pre-enumeration.
- Fresh focused gate: identity plus codec tests `174/174` in `18.04s` (`19.72s` test execution).

## M5 store slice 1: fourth adversarial repair

- [x] Add RED regressions proving all three public event projection APIs reject nested/ignored accessors, request-identity accessors, revoked proxies, deep alias expansion, and oversized ignored graphs without invoking getters or traps.
- [x] Replace the public `structuredClone` boundary with one bounded recursive data-descriptor snapshot; retain the trusted store snapshot path without a second snapshot.
- [x] Enforce diagnostic `shapeKeys` cardinality 32 before key enumeration or numeric descriptors on both writer and decoder paths.
- [x] Run focused identity/codec tests, engine typecheck/public-surface fixture, diff hygiene, and independent adversarial review.
- [x] Commit the repair as a new checkpoint without rewriting prior commits or pushing/integrating.

### Fourth adversarial repair review

- TDD RED isolated the public shallow-clone gap and decoder post-enumeration overflow. A test-fixture scope typo in the first writer RED was corrected before production work; the corrected writer counter then proved the original graph was enumerated too early.
- The public snapshot rejects proxies before every trap and recursively bounds depth, nodes, local/aggregate keys, dense arrays, individual/aggregate strings, cycles, symbols, exotics, and accessors. Benign aliases remain legal and are cloned within the same fixed budget.
- The direct trusted-seam regression proves the already-deep-frozen store snapshot is not recursively resnapshotted; its ignored nested object receives zero descriptor reads.
- Writer and decoder both reject 33 diagnostic shape keys before `Reflect.ownKeys` or numeric element descriptors, producing `INVALID_INPUT` and `CORRUPT_ROW` respectively.
- Initial independent review returned P3-only for missing cycle/symbol/exotic cases and an obsolete `structuredClone` spy. After exact test repairs, independent rereview returned GO with no P0-P3 findings.
- Fresh final gate: identity plus codec tests `177/177` in `16.00s` (`17.68s` test execution); engine typecheck and the negative public-surface fixture pass; `git diff --check` passes.

## M5 store slice 1: final persistence-boundary repair

- [x] Add RED regressions for credential-shaped title redaction and fixed-point rejection in every semantic summary/revision/turn scalar.
- [x] Replace the three obsolete `structuredClone` spies with direct internal readable/injective transform-boundary instrumentation and prove overflow rejects before either transform runs.
- [x] Implement the narrow writer policy while preserving raw-home rejection, Unicode/bounds, value-free errors, deep freezing, and benign exact values.
- [x] Run focused identity/codec tests, engine typecheck/public-surface fixture, and diff hygiene.
- [x] Record exact RED/GREEN evidence and commit a new checkpoint without amending or pushing.

### Final persistence-boundary repair review

- TDD RED was exact: the focused scalar regressions reported `2 failed / 1 passed`; title retained the credential verbatim and the first semantic field returned normally instead of `INVALID_INPUT`.
- Title is the sole display/free-text scalar in this boundary: it rejects raw home first, redacts credential shapes, then revalidates the final Unicode/NUL/SQLite bound. Model, task/revision/last-turn/turn statuses, and revision fingerprint reject unless already secret-redaction fixed points.
- The obsolete clone spies are gone. The real readable and injective transforms now live in one pure internal non-barrel module; Vitest wraps those imports, a benign control proves the counters are live, and both overflow classes record zero transform/materialization calls.
- The focused identity/codec gate passes `180/180`; engine source typecheck and the negative provider-surface fixture pass; `git diff --check` passes. No SQL, migration, provider process, browser, full suite, Python runtime, main checkout, or user-owned path was touched.

## M5 store slice 2: home registry and durable reconciliation

### Checkpoint A: serial store foundation

- [x] Add RED `store.test.ts` coverage for exact canonical home registration, idempotency with original timestamp preservation, provider isolation, conflict directions, hostile descriptor/proxy inputs, raw-home-free frozen results, backend-only resolution, and unknown homes.
- [x] Add RED reconciliation coverage for missing state, monotonic relatch, overflow rollback, restart/provider/home/task isolation, exact CAS acknowledgement, stale/newer relatch refusal, corrupt rows, caller-owned transactions, reentrant clocks, and unavailable databases.
- [x] Implement `ProviderTaskIndexStore` over the existing v14 tables with one owned `BEGIN IMMEDIATE` helper, one-sample callback discipline, value-free errors, and a private in-transaction latch primitive reusable by replay-conflict handling.
- [x] Extend only the path-free reconciliation types required by this checkpoint; keep canonical homes and the concrete store out of the provider/browser barrel.
- [x] Run focused store+migration tests with at most two workers, engine typecheck/public-surface fixture, and diff hygiene; commit the green checkpoint.
- [ ] Obtain independent specification GO, then independent code-quality/security GO on the exact checkpoint before wiring it into `TranscriptIndex`.

#### Checkpoint A review

- Initial TDD RED was exact: focused Vitest failed one suite with zero collected tests because the new backend store module did not exist. The public-surface compiler gate independently failed on the five absent frozen public types. No production store code existed for either RED.
- The serial store registers only exact own-data canonical homes, preserves the first timestamp idempotently, resolves raw homes only through its backend method, and returns frozen path-free registration/reconciliation carriers. Both conflict directions, provider isolation, hostile objects, unknown homes, tampered rows, and raw-home-containing task IDs fail closed with value-free errors.
- Reconciliation uses one guarded top-level `BEGIN IMMEDIATE` helper. Inputs are snapshotted and the clock is sampled exactly once before BEGIN; a real delegated canonicalizer records `[false, false, false]` for insert/idempotent/conflict registration, proving no filesystem canonicalization occurs in an owned transaction. The private in-transaction UPSERT increments every latch, including identical relatches, and overflow rolls back without change.
- Exact acknowledgement is a durable CAS over required state, latch revision, and the latched native fingerprint versus freshly observed native state. The caller's new reviewed fingerprint must equal that fresh native value; the historical reviewed baseline is exact-SQL-fenced but superseded on success. Missing, stale, mismatched, null-native, already-cleared, and newer same-fingerprint latches retain their prior row and return only `RECONCILIATION_CAS_MISMATCH`.
- A self-review RED exposed one unavailable reconciliation-read path leaking the private internal error (`1 failed / 19 passed`); the read now maps it to the stable public database error and the regression stays covered. A separate self-review removed filesystem canonicalization from transaction-time home-row decoding before the final gates.
- Exact-commit specification review found one P1: a pre-BEGIN clock callback could delete the non-FK home authority after initial resolution, allowing an orphan require or acknowledgement. Real file-database/second-connection RED tests reproduced both paths exactly at `2 failed / 22 passed`; both mutations returned normally instead of `UNKNOWN_HOME`.
- The follow-up rechecks the bounded raw provider/fingerprint/canonical-home tuple after `BEGIN IMMEDIATE` and before either reconciliation write. Missing authority returns value-free `UNKNOWN_HOME`; malformed or mismatched authority fails corrupt, with no callback, public method, canonicalizer, or filesystem work under the transaction. The prior `[false, false, false]` canonicalizer proof remains green.
- Quality/security review of that follow-up found one P1 and no other issue: a historical reviewed `A` incorrectly blocked a drift acknowledgement against latched/fresh native `B`. The exact drift RED was `1 failed / 24 passed`; expanded nullable coverage was `2 failed / 25 passed`, while null-native refusal already remained green.
- Acknowledgement now permits historical reviewed `A` or `NULL` to be superseded only when caller-reviewed and fresh-observed both equal the latched non-null native fingerprint. The UPDATE still fences the exact previously read nullable historical reviewed fingerprint with `IS ?`, the historical native fingerprint, required state, and latch revision before storing reviewed/native `B/B`.
- A nested transaction audit then found one P2: registration trusted a completed INSERT attempt without proving durable authority. Trigger REDs for `BEFORE INSERT RAISE(IGNORE)`, `AFTER INSERT DELETE`, and `AFTER INSERT` timestamp replacement all returned false success at `3 failed / 27 passed`.
- First registration now performs a filesystem-free exact reread inside the owned transaction and requires provider, fingerprint, canonical home, and original timestamp to match before returning. Missing or changed authority is `CORRUPT_ROW`; the transaction rolls back every trigger effect. The idempotent existing-row path still preserves its original timestamp.
- Fresh focused gate: store `30/30` plus migration `32/32` = `62/62`; engine typecheck and its negative public-surface compiler fixture pass. `git diff --check` passes. No migration/schema, cache/stage/meta/fork/legacy/coordinator/route/adapter/`TranscriptIndex`, provider process, browser, full suite, heavy queue, Python runtime, or push was used.

### Checkpoint B: TranscriptIndex wiring

- [x] Add RED integration coverage proving `TranscriptIndex.providerIndex` is constructed after migrations on the same connection, persists across reopen, and does not independently own/close that connection.
- [x] Wire and root-export the concrete store for backend composition while compiler/runtime fixtures keep it, `resolveHome`, and raw-home carriers absent from `@devhub/engine/providers`.
- [x] Run focused store+migration/index integration tests, engine typecheck/public-surface fixture, and diff hygiene; commit the green checkpoint.
- [ ] Obtain independent specification GO, then independent code-quality/security GO before promoting Slice 2.

#### Checkpoint B review

- TDD RED was exact: the dedicated wiring suite reported `5 failed / 5` because `TranscriptIndex.providerIndex`, its constructor observation, persistence calls, shared-transaction proof, and root export were absent.
- `TranscriptIndex` now constructs one `ProviderTaskIndexStore` immediately after `runMigrations(this.db)` and passes that exact owned `DatabaseSync` handle before initializing dependent stores or statements. The store has no close API; `TranscriptIndex.close()` remains the sole connection close path.
- Focused integration proves the constructor observes user version 14 plus `provider_homes`, fresh register/resolve, durable authority and reconciliation across reopen, caller-transaction refusal on the shared handle, post-owner-close `DATABASE_UNAVAILABLE`, unchanged legacy settings/read behavior, and root-versus-provider package boundaries.
- Fresh focused gate: wiring `5/5` plus store `30/30` plus migration `32/32` = `67/67`; engine typecheck and its negative public-surface compiler fixture pass. `git diff --check` passes. No store semantics, schema/migration, cache/stage/coordinator/route/adapter/UI, provider process, browser, full suite, heavy queue, Python runtime, or push was used.

### Checkpoint C0: current-contract reconciliation and public store types

- [x] Preserve the historical v14 schema and append v15 `generation_epoch` with exact layout validation and active/staging backfill.
- [x] Prove fresh/v13/v14-to-v15 convergence, idempotency, rollback, data preservation, claimed-v15 corruption refusal, and future migration appends.
- [x] Replace the stale known-home reconciliation assumption with path-free orphan metadata identity semantics while retaining registered-home raw-path validation when that optional authority exists.
- [x] Make every `requireReconciliation` return its exact committed frozen state/CAS token and make acknowledgement accept/return an exact nullable authoritative pair.
- [x] Permit exact-revision `C/C` or `NULL/NULL` acknowledgement to supersede an older latch pair, while preserving exact prior-row SQL fencing and newer-relatch refusal.
- [x] Reread and verify reconciliation authority after both require and acknowledgement writes inside the owned transaction.
- [x] Add the frozen page/scope/cache-clear/metadata/fork/legacy public types and keep raw-home, concrete-store, prepared, and internal carriers outside the provider barrel.
- [x] Freeze staged/active summary demotion and replay-conflict latch payload semantics without implementing the later lifecycle methods.
- [x] Classify suppressed reconciliation writes as `CORRUPT_ROW` after capacity/CAS preconditions were already proven.
- [x] Run the fresh focused store/codec/wiring regression, typecheck/public-surface, and diff-hygiene gate.
- [x] Obtain independent specification then quality/security GO on the exact checkpoint.

#### Checkpoint C0 implementation evidence

- TDD RED was exact: focused store tests reported `6 failed / 24 passed`, covering orphan get/require/ack, returned require state, exact-revision authoritative fingerprint supersession, and nullable deletion acknowledgement.
- The negative/positive public-surface compiler RED named exactly ten absent frozen exports before implementation.
- A separate persisted-authority RED removed the new reread and made both real AFTER-trigger require/ack regressions fail (`2 failed / 30 skipped`); restoring the reread makes both mutations fail closed and roll back trigger changes.
- The additive v15 migration gate passes `39/39`, including active/live backfill, injected rollback, byte-preservation, claimed-v15 tamper refusal, reset/idempotency, and future-append coverage; wiring now observes latest version 15.
- BEFORE `RAISE(IGNORE)` regressions were exact RED (`2 failed / 32 passed`): require misreported `CAPACITY` and acknowledgement misreported `RECONCILIATION_CAS_MISMATCH`; both now return `CORRUPT_ROW` with no mutation.
- Fresh combined exact-tip gate: store `34/34` plus migration `39/39` plus codec `76/76` plus wiring `5/5` = `154/154`; engine source typecheck and the dedicated negative public-surface compiler fixture pass; `git diff --check` passes.
- Exact implementation tip `5d0ba77b262b6e62140f708352673cbd74ebab58` received independent SPEC GO and QUALITY GO with zero P0-P3. The initial v15-plan P1 and trigger-classification P3 are closed; the orphan-path candidate was reclassified as a nonfinding because `require` is internal, public acknowledgement needs an existing latch plus authoritative reread, and forbidden path heuristics would violate the frozen slash/Unicode orphan-locator contract.

### Checkpoint C: stage lease, heartbeat, and abort lifecycle

- [x] Add focused RED coverage for initial begin, live-stage refusal, expiry-boundary takeover, monotonic epoch allocation, repeated-token ABA resistance, and restart recovery.
- [x] Add RED coverage for heartbeat renewal/replay, lost and expired handles, regressing/overflowing clocks, and exact post-write trigger verification.
- [x] Add RED coverage for exact abort ownership, expired abort, staged-cache deletion, active/durable/epoch preservation, stale handles, and suppressed/deleted/rewritten SQL.
- [x] Prove caller-owned transaction rejection precedes hostile input and callbacks; callbacks stay outside SQL and reentrant clock/token paths fail closed.
- [x] Implement only `beginStage`, `heartbeatStage`, and `abortStage` over the shared connection and existing top-level transaction owner.
- [x] Run focused stage/store/migration/wiring tests with at most two workers, engine typecheck/public-surface fixture, and diff hygiene.
- [x] Record exact RED/GREEN evidence, self-review scope, and commit the tested checkpoint without pushing.
- [x] Obtain independent exact-tip SPEC and QUALITY/SECURITY GO before promotion.

#### Checkpoint C implementation evidence

- Initial RED was exact: the new lifecycle suite reported `25 failed / 25` because all three public methods were absent. The first minimal implementation reached `25/25` without adding any D/E/F method.
- Self-review REDs then exposed three independent authority gaps: missing/behind/tombstone sync state allowed occupied cache generations to survive allocation (`2 failed / 25 passed`, then `1 failed / 28 passed`), and a restarted shorter lease reduced an existing expiry (`1 failed / 27 passed`). Exact cache/epoch fencing and monotonic `max(candidate,current)` expiry close them.
- Begin allocates epoch `1` initially and then only `generation_epoch + 1`; live ownership is immutable `STAGE_BUSY`, boundary expiry atomically removes only abandoned staged cache, repeated tokens cannot create ABA, and overflow is `CAPACITY` without mutation.
- Heartbeat renews only exact unexpired ownership, samples one clock and no token, returns false for lost/expired handles, rejects clock regression/overflow, and never shortens an existing expiry. Abort samples no callback, accepts an expired exact handle, deletes only its staged generation, and preserves active cache, durable rows, provider completion fields, and epoch.
- Real SQLite BEFORE-ignore, AFTER-delete, and AFTER-rewrite triggers prove exact post-write rereads/rollback for begin, heartbeat, and abort. Caller transactions, hostile objects, reentrant callbacks, home-authority removal, closed/busy databases, restart recovery, and value-free errors are covered.
- Fresh focused lifecycle gate passes `29/29`; combined lifecycle/store/migration/wiring passes `107/107`. Engine typecheck and its negative public-surface fixture pass, and `git diff --check` is clean. No D/E/F API, provider process, browser, full suite, heavy queue, Python runtime, main checkout, or user-owned path was touched.

#### Checkpoint C specification-proof follow-up

- [x] Prove expired takeover and abort in one scope preserve a second scope with identical generation/task identity, including exact sync/cache/durable rows.
- [x] Prove idle-allocation UPDATE suppression, deletion, and rewriting roll back exact prior sync/cache state.
- [x] Prove expired-takeover UPDATE suppression, deletion, and rewriting restore the abandoned staged cache and exact prior sync row.
- [x] Run focused lifecycle, combined store/migration/wiring, engine typecheck/public-surface, and diff-hygiene gates; commit without amending or pushing.

#### Checkpoint C specification-proof evidence

- The cross-scope fixture assigns both homes generation `1`, token `same-owner-token`, and native task `same-native-task`; scope B's full sync/cache/meta/reconciliation snapshot is exactly unchanged after scope A's boundary-expired takeover and subsequent abort.
- Six UPDATE-path induced failures cover idle allocation and expired takeover independently. BEFORE `RAISE(IGNORE)`, AFTER delete, and AFTER rewrite all return `CORRUPT_ROW`; exact prior sync and cache rows survive rollback, including the abandoned generation deleted before takeover's UPDATE.
- All seven proof cases passed on their first run, so no production source change was needed. Focused lifecycle is `36/36`; combined lifecycle/store/migration/wiring is `114/114`; engine typecheck and the negative public-surface fixture pass; diff hygiene is clean.

#### Checkpoint C shared-connection mutation-guard repair

- [x] Add RED clock/token callback regressions using two stores over the exact same SQLite handle; prove stable callback failures and exact state preservation.
- [x] Replace the instance-local mutation flag with connection-scoped guard state shared through a module-private `WeakMap`.
- [x] Preserve same-instance reentrancy, exact callback counts, closed-database mapping, guard release after failure, and independence between distinct database handles.
- [x] Run focused lifecycle, combined store/migration/wiring, engine typecheck/public-surface, and diff-hygiene gates; commit without amending or pushing.

#### Checkpoint C shared-connection mutation-guard evidence

- RED was exact: the lifecycle suite reported `2 failed / 37 passed`; both cross-instance callbacks mutated successfully because each store owned an independent flag, so the outer begin returned instead of failing closed.
- The module-private `WeakMap` now binds one guard state to each exact SQLite object. All store instances on that connection share the state; `finally` releases it after every return or throw, while distinct database handles receive independent states.
- Clock and token regressions preserve exact sync/cache/meta/reconciliation rows and return `CLOCK_FAILURE` and `TOKEN_FAILURE` with callback counts `1/0` and `1/1`. A post-failure abort proves release, and a different-database callback mutation succeeds. Existing same-instance and closed-database cases remain green.
- Focused lifecycle passes `39/39`; combined lifecycle/store/migration/wiring passes `117/117`; engine typecheck and its negative public-surface fixture pass; diff hygiene is clean.
- Exact implementation tip `6c7e76d65e62568c4f80a4e08a2e0a8226b838fd` received independent SPEC GO and QUALITY GO with zero P0-P3. The initial two P3 proof gaps were closed by seven cross-scope/UPDATE-trigger cases; the later P1 cross-instance callback mutation was closed by the per-connection guard and two-store RED regressions.

### Checkpoint D: staged cache writes and atomic promotion

- [x] Add RED coverage for hostile-safe `stageSummary` preparation, last-call-wins replacement, unchanged-snapshot preservation, exact ownership/expiry, lease renewal, post-dedupe capacity, cross-scope isolation, and trigger rollback.
- [x] Add RED coverage for authoritative `stageSnapshot` replacement, full-rowset idempotency, stale-child deletion, replay-conflict abort/latch semantics, latch overflow, commit/delete/trigger rollback, restart, and caller-forged error provenance.
- [x] Add RED coverage for zero-task and populated `promoteStage`, exact completion counts, provider version, generation retirement, old-active preservation, every census mismatch, compensated corruption, ordinal gaps/duplicates, summary-child corruption, and trigger/commit/busy/closed failures.
- [x] Implement only `stageSummary`, `stageSnapshot`, and `promoteStage`; reuse the per-connection mutation guard and keep E active reads/replacements/clear plus F out of scope.
- [x] Keep all caller/path preparation and the single clock sample before `BEGIN IMMEDIATE`; renew every successful stage write monotonically and verify exact stored authority before commit.
- [x] Run the new focused D suite plus lifecycle/store/migration/wiring, engine typecheck/negative fixture, and diff hygiene with at most two workers; document RED/GREEN evidence and commit without pushing.
- [x] Obtain independent exact-tip SPEC and QUALITY/SECURITY GO before promotion.

#### Checkpoint D implementation evidence

- Strict TDD began with `3 failed / 3` because all three frozen methods were absent. Cache replacement then produced `3 failed / 3 passed`, replay conflict `1 failed / 6 passed`, promotion structure/retirement `3 failed / 8 passed`, post-dedupe capacity `1 failed / 13 passed`, and exact generation-delta trigger defense `1 failed / 14 passed` before their respective minimal GREEN changes.
- Summary writes are last-call-wins, preserve unchanged complete snapshots, demote changed snapshots, renew only exact unexpired ownership, enforce final generation capacity, and verify both the target rowset and exact whole-generation census delta so trigger-injected siblings cannot commit.
- Snapshot writes persist canonical task/turn/event/receipt rowsets, make exact replay byte-idempotent, remove stale children on changed receipt identity, and commit replay-conflict stage abort plus durable reconciliation latch before throwing. Latch overflow, abort corruption, denied commits, and trigger failures roll back the entire transaction; restart proves successful conflict durability.
- Promotion verifies all five claimed counts, global and per-task configured bounds, distinct snapshot tasks, exact per-receipt event counts, contiguous unique ordinals, turn ownership, and absence of summary-only children. It atomically switches active generation, preserves the epoch watermark, and retires every non-promoted cache generation in the exact provider/home scope with post-delete and post-transition verification.
- Green-only self-review extracted callback-free census, capacity, structural-verification, and retirement SQL into private non-barrel `store-cache.ts`. The extraction regression (`3 failed / 25 passed`) exposed and closed transaction-layer normalization for the new internal error type without changing public errors.
- A final self-review RED (`1 failed / 37 passed`) proved promotion had enforced global event capacity but not the configured per-task event bound against persisted rows. The private census helper now checks both before promotion.
- Final focused D gate passes `38/38`; combined D/lifecycle/store/migration/wiring passes `155/155`. Engine source typecheck and the dedicated negative public-surface compiler fixture pass; `git diff --check` is clean. No E/F API, schema/migration change, provider process, browser, full suite, heavy queue, Python runtime, main checkout, push, or user-owned path was used.

#### Checkpoint D SPEC NO-GO follow-up

- [x] Preserve internal codec `CAPACITY`/`INVALID_INPUT` provenance without trusting public errors.
- [x] Make unchanged summary then identical snapshot replay preserve the complete subtree.
- [x] Reject compensated duplicate turn/event ordinals during promotion.
- [x] Retire every non-promoted same-scope generation atomically.
- [x] Replace heap-amplifying census/existence enumeration with aggregate SQL.
- [x] Reject promotion clock regression without changing stage or active cache.
- [x] Close the remaining multi-turn, tamper, conflict, reentrancy, database-state, sync-trigger, and latch-trigger proof gaps.
- [x] Run final D/combined/typecheck/diff gates and commit a follow-up without amend or push.

#### Checkpoint D SPEC NO-GO repair evidence

- Finding 1 RED was exact (`1 failed / 38 passed`): the store flattened codec capacity to `INVALID_INPUT`. A private non-barrel discriminated preparation result now carries only internally produced `CAPACITY`/`INVALID_INPUT`; the public codec API remains unchanged and caller-forged public errors remain untrusted.
- Finding 2 RED was exact (`1 failed / 39 passed`): unchanged summary rewrote only task `observed_at`, so identical snapshot replay saw a split task/receipt observation and returned corruption. Unchanged hash-bearing summary now renews only the stage lease and preserves the complete subtree byte-for-byte.
- Finding 3 RED was exact (`2 failed / 40 passed`): compensated `[0,0,2]` turn and event ordinals satisfied min/max/count. Promotion now also requires `COUNT(DISTINCT ordinal) = COUNT(*)` for both child tables.
- Finding 4 RED was exact (`2 failed / 42 passed`): future same-scope cache generations survived promotion and bypassed retirement-trigger proof. Promotion now deletes and post-verifies every same-scope generation unequal to the promoted generation, while transaction rollback and other-home isolation remain exact.
- Finding 5 RED was exact (`2 failed / 44 passed`): summary demotion and snapshot replacement enumerated all existing child rows for census/existence. They now use aggregate task COUNT queries and exact census deltas; only incoming-bounded snapshot comparisons enumerate child rows, with a one-row corruption sentinel limit.
- Finding 6 RED was exact (`1 failed / 46 passed`): promotion accepted a clock behind the stored heartbeat. It now returns `CLOCK_FAILURE` before mutation and preserves stage plus old active cache.
- The remaining twelve proof cases passed on first execution: real multi-turn global event ordinals, same-fingerprint replay tamper detection, replay-conflict COMMIT rollback, cross-instance same-DB callback rejection/release, stage-write caller transaction/closed/busy failures, and complete promotion-sync/conflict-latch IGNORE/delete/rewrite matrices.
- Final gates: codec `76/76`, focused D `59/59`, and combined D/lifecycle/store/migration/wiring `176/176`. Engine source typecheck, the negative public-surface compiler fixture, and `git diff --check` all pass; the preparation adapter remains private/non-barrel. No E/F API, schema/migration, provider process, browser, full suite, heavy queue, Python runtime, main checkout, amend, push, or user-owned path was used.
- Exact implementation tip `b7e3b44165ad61ecd864b9dcaea7d43e57f2b5c5` received independent SPEC GO and QUALITY GO with zero P0-P3 after all five P1s, the P2 clock regression, and every induced-failure proof gap were closed.
