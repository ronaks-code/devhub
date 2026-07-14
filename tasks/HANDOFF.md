# DevHub M0-M8 handoff

Updated: 2026-07-14 13:20 PDT
Stage: build
Goal: deliver the literal mandatory DONE checklist in the authoritative `/goal` prompt for a provider-native DevHub supporting real Codex and Claude runtimes.

## Current snapshot

- Fixed progress: **33%** on one M0-M8 hard-gate denominator. M0-M2 are complete; partial M3-M5 work receives no percentage credit.
- Tested branch: `campaign/auto-improve` at `6b2293b5254d85c7b36f272388157fe99ca4ea45`; remote matches exactly.
- WIP branch: `wip/devhub` at `641af8e8868a2cd42ea032a2558ae16ec2556b07`; remote matches exactly.
- Immediate next action: independently SPEC-review and QUALITY/SECURITY-review E commit `e28cfa11abc00e5b040334cc8229c081e49dec45`; repair until both GO, then promote that exact diff and rerun 348/348 on tested main.
- This is **not software-complete** and is **not blocked on Ronak** for current M5 work.

## DONE

| Finished piece | Evidence |
|---|---|
| M0 baseline and preservation | `cd1e6473115d8f4ca30b0f574ac340750588b3d9`; protected backup `/Users/ronak/.codex/backups/devhub-codex-parity/20260713T001908Z`, 13/13 files hash-verified; baseline typecheck 5/5, build 3/3, tests 622/624 with two explicitly recorded time-aged fixtures. |
| M1 provider contracts and architecture gate | `cd1e6473115d8f4ca30b0f574ac340750588b3d9`; real Codex and Claude start/stream/interrupt/persist/restart/resume probes completed within the bounded turn budget; persistent Claude CLI selected; capability/synchronization ADRs recorded. |
| Reference, concepts, single approval, and design lock | `cd1e6473115d8f4ca30b0f574ac340750588b3d9`; 8/8 concepts plus 2/2 corrections, hashes recorded, explicit recommended DevHub direction approved, design-lock staff review GO. |
| M2 provider adapter seam | `d0d8d08058a95fb10ae78b7043410098bcf7b89a`; engine 637/637, server 135/135, web 42/42, forced monorepo 11/11 including release `.app` and x64 DMG. |
| M3 deterministic Codex implementation subpiece | `d0d8d08058a95fb10ae78b7043410098bcf7b89a`; protocol 123/123, process+protocol 176/176, full engine through 866/866, web 140/140, Browser evidence captured, one real native start/stream/persist/restart/reread completed. M3 itself remains open on the production-wrapper resume proof. |
| M4 deterministic Claude implementation subpiece | `d0d8d08058a95fb10ae78b7043410098bcf7b89a`, evidence commit `768a34bd7b73dd59bc4de6516384b181acb31f9a`; deterministic engine/server/web 179/65/102, full repo 11/11 after FIFO wait, Browser and DevHub Computer Use evidence captured. M4 itself remains open on the capped selected-wrapper raw-live gate. |
| Shared heavy-job queue safety | `.planning/devhub-codex-parity/evidence/shared-heavy-wrapper-cutover.md`; immutable launcher/implementation, FIFO/upgrade/signal/schema drills, independent GO. Current queue was empty and admission-ready at handoff. |
| M5 identity and pure codec | `35d8185e844554467f542798354ef203ec5e66ae`; 180/180 plus typecheck and negative public-surface fixture; dual review GO. |
| M5 registered-home/reconciliation foundation and `TranscriptIndex` wiring | `9dedd7be1db001f32a12979558b3e278c246f932` (62/62) and `aa816d836567604518d7f89e4cc81a54eba02389` (67/67); dual review GO. |
| M5 C0 current contract plus v15 epoch | tested tip `b6d327c687492b48f31fb692789589b3316b13de`; 154/154, typecheck, exact SPEC/QUALITY GO. Historical v14 is preserved; v15 adds monotonic `generation_epoch`. |
| M5 C stage lifecycle | tested tip `d680f3f4844b674dd398e9e6f6669db3fbafc807`; 117/117, typecheck, exact SPEC/QUALITY GO. Begin/heartbeat/abort use a per-`DatabaseSync` reentrancy guard and ABA-safe epochs. |
| M5 F internal local-state foundation | `215c1faf1e58496ace7a4000701f7baa599cc356`; 26/26, typecheck, dual review GO. Internal metadata/fork/legacy/savepoint primitives exist; public store facade wiring is intentionally still open. |
| M5 D staged writes and promotion | tested tip `6b2293b5254d85c7b36f272388157fe99ca4ea45`; root rerun 252/252 across D, codec, lifecycle, store, migration, and wiring; typecheck; exact SPEC/QUALITY GO. |
| M5 E implementation checkpoint, WIP only | local `e28cfa11abc00e5b040334cc8229c081e49dec45`, remote WIP `641af8e8868a2cd42ea032a2558ae16ec2556b07`; E 35/35, codec+cursor 137/137, D 59/59, prior gates 117/117, total distinct focused tests 348/348, typecheck and diff hygiene. **Not promoted: exact-tip SPEC and QUALITY reviews never completed.** |

## REMAINING — exact order

1. **Certify and promote M5 E.**
   - Review exact commit `e28cfa11abc00e5b040334cc8229c081e49dec45`: SPEC first, then a different QUALITY/SECURITY reviewer.
   - Repair with TDD until both return GO. Update the E checklist/review evidence in `tasks/todo.md`.
   - Never merge `wip/devhub`: it intentionally also contains the four user-owned dirty files and `.gstack` evidence. Cherry-pick only reviewed E commits.
   - On tested main run the eight provider-index files totaling 348 tests, engine typecheck, negative surface fixture, and `git diff --check`; commit/push only after green.

2. **Integrate M5 F facade.**
   - Wire reviewed `store-local-state.ts` primitives into `ProviderTaskIndexStore`: `getMeta`, `patchMeta`, `linkFork`, `listForkLinks`, `classifyLegacySession`, and `mapVerifiedLegacySession`.
   - Sample timestamps outside savepoints; map only internal tagged failures; recheck registered authority for verified mapping; preserve orphan metadata semantics.
   - TDD, exact SPEC review, exact QUALITY review, targeted integration gate, then tested-branch promotion.

3. **Finish M5 Tasks 3-9 from `m5-implementation-plan.md`.**
   1. Task 3 coordinator/rebuild/dedupe/read-through: bounded provider paging, heartbeat, exact final census, degraded-cache labeling, verified legacy lookup, native deletion with no gzip resurrection, full DB delete/rebuild equivalence.
   2. Task 4 provider mutation parity: Codex writer lease; durable reconciliation injection for both providers; external-revision reread/fencing; uncertain outcomes fail closed; Claude lease regressions remain green.
   3. Task 5 authenticated locator-only routes/SSE and flag-controlled integration; no raw home/browser authority; exact subscribe-buffer-snapshot-drain semantics; legacy behavior byte-compatible with `unifiedTaskIndex=false`.
   4. Task 6 portable archive v2 metadata-only default; explicit v1 compatibility/quarantine; no provider cache, raw paths, credentials, or hidden reasoning.
   5. Task 7 DevHub URL/localStorage migration with legacy reads and locator-only new writes.
   6. Task 8 `DEVHUB_*`/legacy env aliases, legacy data-path preservation, webhook v1/v2 compatibility, no duplicate delivery.
   7. Task 9 induced-failure matrix, fresh reviews, secret/raw-home scans, preservation checks, feature-flag cutover, full engine/server/web/typecheck/build/TUI/desktop gate through the shared heavy queue, Browser and DevHub Computer Use evidence, explicit stored-false rollback proof.

4. **Close the parked M3/M4 live gates.**
   - M3: production-wrapper Codex resume and continued conversation after restart/scratch cleanup.
   - M4: selected-wrapper Claude raw multi-query, resume, real permission/control, interrupt, post-interrupt continuation, and fork continuation.
   - Keep `nativeCodex=false` and `persistentClaude=false` until these pass.

5. **Implement M6 Codex-style shell.**
   - Execute the approved strangler order: shell/chrome, rail, header/setup, thread/activity, composer, inspector, search/commands, settings/utilities.
   - Use the captured Codex reference first, approved concepts only for DevHub-specific states, custom Radix/shadcn substrate, and preserve every existing route/feature.
   - Pass critical-state Browser/Computer Use, visible-copy, wide/narrow/mobile, motion/reduced-motion, keyboard, accessibility, and fidelity-ledger gates.

6. **Implement M7 cross-provider fork, Work mode, and synchronization.**
   - New native target session with preview, redacted attributed handoff, additive linkage, unchanged source, and honest provider identity.
   - Real provider-backed Work mode with folder scope, permissions, progress/artifacts/deliverables; never claim Cowork interoperability.

7. **Complete M8 packaging, cutover, performance, preservation, naming, and cleanup.**
   - Browser/PWA and supported packaged Tauri flows; tray/hotkey/notifications/archive/TUI/analytics/search/Ops/settings preservation.
   - Performance measurements, accessibility audit, final fidelity comparisons, legacy compatibility/data-path migration, DevHub branding/repo/app naming, raw OpenAI quarantine/removal decision, removal of probes/QA servers/temporary artifacts.

8. **Literal mandatory DONE audit and final handoff.**
   - Prove apps-closed native operation; both real runtimes and advertised approvals/input/capabilities; provider lock; linked cross-provider fork; real Work mode; native-authoritative rebuildable cache; preservation matrix; approved design/motion/responsive/keyboard/accessibility/fidelity; Browser/PWA/desktop; full tests/builds/protocol/package smoke; raw OpenAI quarantine; cleanup; completed `tasks/todo.md` review/results.
   - Produce the final architecture/UX summary, milestone evidence, exact commands/results, capability/sync tables, visual findings, performance/accessibility results, preservation matrix, deviations, conditional statuses, risks, and staff-quality judgment.

## BLOCKERS

| Blocker | Owner | Exact unblock |
|---|---|---|
| M3/M4 additional raw-live proof turns exceed the prompt's bounded provider-turn budget. | Ronak | Explicitly authorize the additional billable Codex/Claude turns for the two named live gates. Auth is already present; this is a budget/authority gate, not a missing credential. |
| Computer Use cannot control first-party `com.openai.codex`; the host returns a policy rejection. | Host/platform; Ronak can choose the environment | Use/update to a Codex/Computer-Use host build whose allowlist authorizes `com.openai.codex`, or keep it recorded as blocked/conditional and use permitted screenshot/direct-navigation evidence. Project code and macOS Accessibility toggles alone do not change this host allowlist. DevHub's own browser/Computer Use QA is allowed. |
| Current M5 E promotion | No external owner | Not externally blocked. Run the required independent reviews and promote when green. |
| Alex | None | No DevHub task depends on Alex. |
| Hardware | None currently | Mac/Tauri gates are available. If M8 distribution signing/notarization becomes a required artifact and credentials are absent, report that artifact as blocked rather than passed. |
| Provider credentials | None currently | Codex/Claude auth and the selected Claude API-key path were verified. Never print or persist the key. |

## CONTEXT A FRESH CHAT NEEDS

### Branches and worktrees

| Purpose | Path / branch / tip | Rule |
|---|---|---|
| Tested shared work | `/Users/ronak/Documents/01-code/active/claude-ui`, `campaign/auto-improve`, `6b2293b` | Remote matches. Only tested/reviewed work belongs here. |
| Remote-backed WIP | `/Users/ronak/.config/superpowers/worktrees/claude-ui/wip-devhub`, `wip/devhub`, `641af8e` | Contains E plus preserved user dirt/artifacts. Do not merge wholesale. |
| Active M5 implementation | `/Users/ronak/.config/superpowers/worktrees/claude-ui/m5`, detached `e28cfa1` | Clean exact E commit; use for reviews/repairs. |
| F source worktree | `/Users/ronak/.config/superpowers/worktrees/claude-ui/m5-f`, detached `4244c39` | Clean reviewed internal foundation; equivalent foundation is already on tested main as `215c1fa`. |

The main checkout must retain these user-owned paths exactly; never stage, discard, or rewrite them:

- `.gitignore`
- `apps/web/src/components/ChatPane.tsx`
- `apps/web/src/components/SlashPalette.tsx`
- `AGENTS.md` (untracked)

### Read first

- Authoritative goal: `/Users/ronak/.codex/attachments/a9c8f53b-0a94-4326-8a88-bec6f26d8629/pasted-text-1.txt`
- Global/repo policy: `AGENTS.md`
- Program state: `tasks/todo.md`, `tasks/lessons.md`, this file
- Program plan: `.planning/devhub-codex-parity/implementation-plan.md`
- Frozen M5 contract: `.planning/devhub-codex-parity/m5-implementation-plan.md`
- Design authority: `.planning/devhub-codex-parity/design-lock.md`, `design-system.md`, `component-state-matrix.md`, `surface-inventory.md`
- Evidence: `.planning/devhub-codex-parity/evidence/`, especially `m3/`, M4 exact-copy evidence, and shared-heavy-wrapper cutover evidence
- Active code: `packages/engine/src/provider-index/` and `packages/engine/test/provider-index/`

### Settled decisions and tradeoffs

- Product is **DevHub**. The legacy folder/repo name `claude-ui` remains only for compatibility and is deferred to M8 migration/cleanup.
- Provider-native state is master; DevHub cache is rebuildable. Never write native transcript/rollout/private desktop storage.
- Public identity is `(provider, homeFingerprint, nativeTaskId)`; raw homes remain backend-only and never enter URLs/browser/archive/SSE.
- Historical v14 schema remains pinned; v15 adds a monotonic generation epoch so abort/conflict cannot reuse stage identities.
- Store mutations own `BEGIN IMMEDIATE`; metadata/fork/legacy helpers compose with unique savepoints. Callback reentrancy is guarded per exact SQLite handle.
- Feature flags remain off: `nativeCodex=false`, `persistentClaude=false`, `unifiedTaskIndex=false`. No flag defaults change before their exact live/cutover gates.
- F internal foundation is reviewed, but its public facade is deferred until E is certified.
- Approved UI direction is reference-first Codex shell plus restrained provider identity. shadcn/Radix is a behavior substrate, not a visual redesign; the approved custom-Radix initialization deviation is recorded.
- The 8+2 ImageGen cap is fully used. Do not generate more concepts.
- M3/M4 live proofs are parked, not silently waived.

### Operational gotchas

- Use `vitest --minWorkers=1 --maxWorkers=2`; `--maxWorkers=2` alone conflicts with Vitest's default minimum on this Mac.
- Heavy commands must use:
  `RONAK_CODEX_CHAT=devhub /Users/ronak/.codex/bin/ronak-codex-heavy-queue run "<repo>: <gate>" -- <absolute command ...>`
- Do not use Python. Do not kill another chat's processes. The queue was empty at handoff.
- For E's exact 348 gate, run:
  `pnpm --filter @devhub/engine exec vitest run test/provider-index/store-active-cache.test.ts test/provider-index/store-stage-write.test.ts test/provider-index/store-stage.test.ts test/provider-index/store.test.ts test/provider-index/migration.test.ts test/provider-index/store-wiring.test.ts test/provider-index/store-codec.test.ts test/provider-index/cursor.test.ts --minWorkers=1 --maxWorkers=2`
- Then run `pnpm --filter @devhub/engine typecheck` and `git diff --check`.
- Normal authenticated `git push origin` may prompt. Existing successful pushes used a temporary `http.extraHeader` derived from `gh auth token --user ronaks-code`; never echo/log the token.
- Hourly status automation is `devhub-hourly-status` at `:04`, writing `/tmp/ronak-codex-status/devhub.md`. Keep the fixed percentage and exact worktree/commit state accurate.
- Review order is strict: implementer TDD commit -> SPEC review -> repairs -> QUALITY/SECURITY review -> exact targeted gate on tested main -> push. A green implementer test is not promotion authority.

## Progress and ETA

- Fixed denominator: **33%** (3 of 9 milestones hard-complete).
- Observed recent throughput: C0, C, D, E, and the F foundation were implemented/tested over roughly 3.5 active hours, but D required a substantial independent-review repair cycle and E then sat awaiting review; later coordinator/routes/UI/packaging work is materially larger than these store slices.
- Honest expected remaining active wall-clock: **50-75 hours**. Best case with clean reviews and useful parallelism: about **35 hours**. Worst case with review rework, live-provider retries, packaging failures, and merge conflicts: **100+ hours**, plus any waiting for Ronak's live-turn authorization or a host-policy change.
