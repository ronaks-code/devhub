# M3 production-wrapper resume + continued-conversation live proof

Date: 2026-07-15 (America/Los_Angeles)
Task: M3-M4-LIVE-PROOF (Ronak authorized the billable Codex/Claude proof turns).

This closes the single remaining M3 blocker recorded in `live-runtime.md`: the
production-wrapper Codex resume + continued conversation after a real DevHub
restart. It was driven through the SHIPPING production seam (DevHub HTTP + the
installed Codex app-server), not a hand-rolled JSONL probe.

## Environment

- Codex CLI: `codex-cli 0.144.3` (`/opt/homebrew/bin/codex`), real auth (`~/.codex/auth.json`, API-key auth mode).
- Provider home (backend-only): `/Users/ronak/.codex`.
- DevHub server: `packages/server` via `tsx src/index.ts`, `127.0.0.1:8915`.
- Isolation: `DEVHUB_DATA=/tmp/devhub-m3m4-proof/data` (index/cache only — the REAL codex home is used so real auth resolves), `DEVHUB_TOKEN` set (mutation auth), task cwd `/private/tmp/devhub-m3m4-proof/workspace`.
- `nativeCodex` enabled at RUNTIME via `PATCH /api/settings` (stored setting), not by changing the feature-flag default. Resolved `devHubFeatures.nativeCodex=true` (runtime discovered + applied). `persistentClaude` left false.

## Sequence (all HTTP through the production wrapper)

Task `nativeTaskId=019f6727-2048-7c63-b37f-47db314e2adf`, `permissionMode=read-only`.

1. **Turn 1 (billable) — create + first turn.** `POST /api/providers/openai/tasks` with a synthetic nonce prompt (`M3-NONCE-A84AEE31`, read-only, "do not run commands"). Task returned `status:active`; polled to terminal `status:idle`, `revision.lastTurnStatus:completed`, `turns:1`. The exact nonce is present in the persisted transcript.
2. **Real DevHub restart.** Killed the backend PID listening on `:8915`, confirmed the port free, relaunched a FRESH `tsx src/index.ts` process against the SAME `DEVHUB_DATA`. The new backend spawns a fresh Codex app-server. `nativeCodex` persisted `true`. Read-back of the task after restart: HTTP 200, `status:notLoaded` (rollout not yet loaded), `turns:1`, nonce still present — native history survived the restart.
3. **Production-wrapper resume.** `POST /api/providers/openai/tasks/019f6727.../resume` `{home, permissionMode:"read-only"}` → **HTTP 200**, `status:idle`, `revision.lastTurnStatus:completed`. The adapter's `verifyConfiguredResult` passed (no policy diagnostic emitted).
4. **Turn 2 (billable) — continued conversation.** `POST /.../send` with `"Without me repeating it, what was the exact token I asked you to reply with in my previous message? Reply with only that token."` (the follow-up did NOT contain the nonce) → HTTP 202; polled to `status:idle`, `turns:2`, `lastTurnStatus:completed`. The turn-2 assistant reply is exactly `M3-NONCE-A84AEE31` — recalled from the resumed thread's context across the restart. This is the continued-conversation proof.

Real billable Codex turns spent: 3 (turn 1 + turn 2 on this task, plus one earlier turn-1 on a diagnostic task; see below). All authorized.

## Why the prior run got HTTP 409 (now understood and cleared)

`live-runtime.md` recorded a `409 provider_policy_mismatch` on the production-wrapper
resume and could not identify the failing field within its turn budget. This run
reproduced it, then root-caused it with a temporary, since-reverted diagnostic
inside `verifyConfiguredResult`:

- The verifier's `exactControlCwd` requires BOTH the resume result's top-level `cwd` AND the nested `thread.cwd` to equal the expected control cwd.
- With a task cwd under `/tmp` (a macOS symlink to `/private/tmp`), Codex echoed the top-level `cwd` as the realpath (`/private/tmp/...`) while the persisted `thread.cwd` retained the original `/tmp/...`. The two never match, so the fail-closed verifier correctly rejects the resume.
- Diagnostic captured verbatim (temporary `DEVHUB_POLICY_DIAG` log, reverted): `exactControlCwd:false`, `rawCwd:"/private/tmp/devhub-m3m4-proof/workspace"`, `rawThreadCwd:"/tmp/devhub-m3m4-proof/workspace"`; every other checked field (`approvalPolicy:on-request`, `approvalsReviewer:user`, `sandboxType:readOnly`, `networkAccess:false`, `threadId`) matched.

**Conclusion:** DevHub's resume path is CORRECT and safely fail-closed. The prior
409 was a cwd-symlink artifact of the test's scratch directory, not a runtime or
adapter defect. Creating the task under a canonical (non-symlinked) cwd makes
create and resume echo consistent cwds and the verifier passes — proven above.

The diagnostic edit to `packages/engine/src/providers/codex/native-adapter.ts`
was reverted; the file is byte-identical to HEAD.

## Cleanup

Both scratch rollouts created in the real `~/.codex` for this proof were removed
after capture:
`~/.codex/sessions/2026/07/15/rollout-...-019f6724-5403-...jsonl` (the /tmp
diagnostic task) and `...-019f6727-2048-...jsonl` (the canonical proof task).
Verified absent. No credential, transcript, or provider process is retained. The
isolated `DEVHUB_DATA` and scratch workspace live under `/tmp/devhub-m3m4-proof/`
(outside the repo) and are not committed.

## Status

M3 production-wrapper resume + continued-conversation: **PASS** with real captured
evidence. The Codex vertical slice's sole remaining live blocker is cleared. The
`nativeCodex` requested-DEFAULT stays `false` — flipping the shipping default on is
the separate production cutover gate (M8 / RONAK), not part of this proof.
