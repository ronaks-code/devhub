# M5 Task 9 — STAGED unifiedTaskIndex cutover

- Task: `m5-t9-stage-cutover`
- Date: 2026-07-15
- Reviewed base (staging branch point): `f4d27fd` (`wip/devhub-background-runner` tip)
- Isolated staging branch: `staging/m5-t9-cutover`
- Staged cutover commit: `01f39e4` — `feat: enable verified unified task index (M5-T9 STAGED cutover)`
- NOT on `campaign/auto-improve`, NOT on `origin/main`, NOT on `wip/devhub-background-runner`.

## What the staged commit does (6 files)

1. `packages/engine/src/providers/feature-flags.ts` — the one-line flip:
   `DEFAULT_DEVHUB_FEATURE_FLAGS.unifiedTaskIndex` `false -> true`.
2. `packages/server/src/app.ts` — `appliedDevHubFeatures.unifiedTaskIndex` now reports
   applied only when `providerTaskIndexCoordinator !== null` (honest applied truth: a
   store that exists but could not initialize the coordinator reports the feature
   disabled instead of falsely applied; `syncProviderTaskIndex` fails open).
3-6. Focused tests updated to the post-cutover contract:
   `feature-flags.test.ts`, `settings-features.test.ts`, `provider-index.test.ts`
   (harness seeds explicit stored-false before ready for the flag-off case),
   `provider-index-composition.test.ts` (default-ON + rollback rehearsal + no-rebuild).

## Flag semantics after the flip

- Requested default is ON. The server clamps the RESOLVED value to
  `requested && available && applied`, where `available.unifiedTaskIndex = store exists`
  and `applied.unifiedTaskIndex = coordinator initialized`.
- A fresh install (no stored override) initializes the coordinator at `onReady` and
  reports the feature applied.
- ROLLBACK: an explicit stored `unifiedTaskIndex: false` wins over the ON default
  (`SettingsStore.getAll` replaces the default object wholesale), so `onReady` never
  builds a coordinator and every indexed route/settings surface reports the feature
  disabled. No schema down-migration; legacy provider routes stay byte-compatible.

## Focused flag/settings/routes/rollback tests — green on `01f39e4`

| Suite (files)                                   | Tests | Passed | Failed |
|-------------------------------------------------|------:|-------:|-------:|
| engine: feature-flags + devhub-feature-settings |     4 |      4 |      0 |
| server: settings-features                       |     8 |      8 |      0 |
| server: provider-index (routes)                 |    25 |     25 |      0 |
| server: provider-index-composition (rollback)   |     3 |      3 |      0 |
| **focused total**                               |  **40** | **40** |  **0** |
| server: app.test.ts (unaffected by default-ON)  |    80 |     80 |      0 |

Machine-readable: `cutover-engine-flags.json`, `cutover-server-routes.json`.
Human logs: `cutover-engine-flags.log`, `cutover-server-routes.log`.

Typechecks on `01f39e4`: engine `tsc --noEmit` PASS, server `tsc --noEmit` PASS,
provider-index public-surface `tsc` PASS. `git diff --check` clean; 6 files changed;
four user-owned paths untouched.

## Rollback rehearsal (explicit stored-false)

`provider-index-composition.test.ts` proves, on the flipped commit:
- default-ON fresh engine: `registerHome` called exactly once at ready; path-free
  registration result; `GET /api/settings` reports `unifiedTaskIndex: true`.
- explicit stored `unifiedTaskIndex: false` set before ready: `registerHome` NOT
  called; `GET /api/settings` reports `unifiedTaskIndex: false`; re-enabling builds the
  coordinator exactly once.
- repeat/flip-back transitions never rebuild or tear down the coordinator (still 1
  registration).

## Remaining as the single [RONAK-GATE] human action

1. Promote the `01f39e4` cutover commit (isolated staging branch) onto the shared
   integration branch.
2. On that exact enabled tip, run the FULL engine/server/web (+ typecheck/build/TUI
   smoke/desktop packaging) gate through the shared heavy queue WITH forced cache
   bypass. Any failure -> repair commit, repeat the exact-tip gate.
3. Capture Browser + Computer-Use QA evidence under `evidence/m5/` (legacy deep
   links/storage migration, path-free provider setup/selection, reload, explicit
   stored-false rollback, wide/768px layouts); stop all QA servers immediately after.
4. Final post-cutover independent exact-tip review + full secret scan + recursive
   raw-home-byte scan + generated-file check + `git diff --check` + preservation
   hash/status check before push.

`nativeCodex=false` and `persistentClaude=false` remain: their raw live-proof turns
(M3 native Codex production-wrapper resume; M4 persistent Claude raw
multi-query/resume/permission/interrupt/fork) are separately blocked billable gates.
