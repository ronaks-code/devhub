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
