# M4 six raw-lifecycle proofs — live rerun with scoped key file, 2026-07-15

Task: with the devhub-scoped `ANTHROPIC_API_KEY` now sourced from
`~/.config/6thsense/devhub-agent.env`, enable persistentClaude and RUN the six
raw-lifecycle proofs (multi-query / resume / permission / interrupt /
post-interrupt / fork-continuation) against the staged EXACT 2.1.207 arm64
binary. Ronak authorized the billable turns.

## Honest outcome

- **Proofs passed: 0 / 6.** Not one lifecycle proof could start.
- **Credential gate (Gate 2): CLEARED** — independently re-confirmed with the
  key from the scoped env file.
- **Version gate (Gate 1): CLEARED** — staged binary reports exactly
  `2.1.207 (Claude Code)`.
- **Blocker: the same credential-independent `INIT_TIMEOUT` readiness-handshake
  deadlock** first found in `lifecycle-proof-run-2026-07-15.md`, now reproduced
  freshly against BOTH the production supervisor path and the raw process path.
- **No evidence fabricated.** `persistentClaude` stays `false`; no
  `lifecycleEvidence` was encoded or wired into `app.ts`; no flag flips.

## What was proven live (real, this run)

1. **Key sources and authenticates (in-process only; never logged/written/committed).**
   `set -a; . ~/.config/6thsense/devhub-agent.env; set +a` sets a well-formed
   `sk-ant-…` key (len 108). A trivial billable turn against the staged binary
   returned exactly `ok`:
   ```sh
   claude -p "Reply with exactly one word: ok" --model claude-haiku-4-5   # -> ok
   ```

2. **Programmatic-auth gate passes.** Driving the real engine surface:
   `requireClaudeProgrammaticAuth(baseEnv)` -> `{"authorized":true,"method":"api-key"}`.

3. **Production supervisor path deadlocks at startup.** Constructing the real
   `ClaudePersistentSupervisor` (staged executable + key in `baseEnv`,
   `isEnabled: () => true`) and calling `acquire({launch:"new", ...})` — the exact
   surface every proof needs — rejected after **5030 ms** with
   `code=UNAVAILABLE msg="Claude runtime startup failed"`. Zero provider events
   emitted. No billable turn spent (fails before any turn).

4. **Root cause confirmed at the process layer.** Driving
   `ClaudeCliProcess.start()` directly rejected after **5008 ms** with
   `code=INIT_TIMEOUT msg="Claude CLI init identity validation timed out"`, and
   **zero envelopes arrived pre-turn** (`ENVELOPES_SEEN []`). The CLI emits no
   `system/init` before the first user turn, so the readiness gate — which
   resolves `start()` ONLY on a matching pre-turn `system/init` — can never fire.
   `acquire()` awaits `start()`; the adapter cannot send the first turn until
   `start()` resolves. Every proof is therefore unreachable, exactly as the prior
   run documented.

5. **The recommended fix is viable (cheaply validated, no billable turn).**
   Raw-spawning the staged CLI with DevHub's exact stream-json argv and sending a
   single SDK `control_request {subtype:"initialize"}` produced a
   `control_response` in **1418 ms**, while **no `system/init` arrived pre-turn
   within an 8 s window** (`{"sawControlResponse":true,"controlResponseMs":1418,
   "sawInitPreTurn":false}`). This confirms the Agent SDK's real readiness signal
   (the initialize control handshake) IS available in ~1.4 s — so the proposed
   fix can gate readiness on it while deferring session-identity validation to the
   first-turn `system/init`.

## Verification method

Doc/evidence-only change; NO source was modified, so there is no unit-test delta
to report. Verification is the empirical reproduction above, captured via three
throwaway probes (production supervisor `acquire`, direct `ClaudeCliProcess.start`,
and a raw-spawn control-handshake timing probe). All probes were removed; the tree
was left clean. The key value was never printed, logged, written, or committed
(shell output was scrubbed of any `sk-ant-…` token).

## Recommendation (unchanged; needs Ronak's explicit go — security-adjacent)

Land the reviewed readiness-handshake change in `cli-process.ts`
(+ `task-runtime.ts` + tests): treat the `control_request {initialize}` ->
`control_response` exchange as the readiness signal, and keep session-identity
validation as a check applied when `system/init` arrives on the first turn
(fail/latch the turn on mismatch) instead of as a pre-turn ready-gate. This
preserves the identity guarantee while matching the CLI's actual protocol. It
touches the security-sensitive start state machine and the extensive cli-process
test suite, so it should be an approved, reviewed change — not slipped into a
background proof run. Once it lands, re-run the six proofs with this doc's key
path and only then encode `NativeClaudeLifecycleEvidence` and wire it into
`createNativeClaudeRuntime` in `app.ts`.

## Cost / cleanliness

- Billable spend: one tiny `claude-haiku-4-5` "ok" turn for the auth check. The
  supervisor/process/handshake probes spent nothing (they fail/return before any
  model turn).
- All throwaway probes and tmp dirs removed; tree left clean. No `lifecycleEvidence`
  wiring, no flag flips, no faked receipts.

---

# UPDATE 2026-07-15 (DEVHUB-M4-PROOFS): handshake fix reviewed, six proofs PASS 6/6, flag flipped

The recommended readiness-handshake fix had already LANDED on `wip/devhub-background-runner`
(commit `M4-HANDSHAKE-FIX`) but the security review, the six proofs, and the flag flip were
explicitly deferred. This update closes all three. NO duplicate/competing fix was created —
the existing fix was reviewed, found correct, and NOT re-applied.

## Fix verification (the deadlock is genuinely broken)

Driving the real `ClaudeCliProcess.start()` against the EXACT staged 2.1.207 arm64 binary
with the scoped key sourced in-process (`set -a; . ~/.config/6thsense/devhub-agent.env; set +a`):
`start()` RESOLVED in **~1150 ms** (phase `ready`), versus the previously-documented 5008 ms
`INIT_TIMEOUT` rejection. Readiness now fires on the `control_request{subtype:"initialize"}`
-> `control_response` handshake, matching the CLI's real protocol.

## Adversarial security review (mandatory — this touches the auth/start machine): CLEAN

I actively tried to break the change. Findings:

1. **Auth (api-key requirement) is UNCHANGED and still fail-closed.** `ClaudePersistentSupervisor.acquire()`
   calls `this.authorized()` -> `requireClaudeProgrammaticAuth(this.baseEnv)` at line 403,
   BEFORE any spawn/`start()`. On failure it throws `UNAUTHORIZED_AUTH`. The handshake fix
   never touched this gate. `createNativeClaudeRuntime` independently re-runs
   `requireClaudeProgrammaticAuth` in `authorizedEnvironment()` and returns `null` (runtime
   unavailable) if it fails. An unauthenticated session therefore cannot even be spawned, let
   alone send a turn. The `initialize` handshake resolving readiness does NOT weaken this —
   readiness has never been the api-key checkpoint (the key is enforced pre-spawn and again by
   the CLI's own model turn).

2. **Session-identity validation is DEFERRED, not SKIPPED.** `captureSessionId()` still runs on
   every stdout envelope. When the first-turn `system/init` arrives with `expectedSessionId`
   set, a non-match throws `MALFORMED_FRAME` (still fail-closed). Crucially, in `ingestStdout()`
   the order is: `captureSessionId(envelope)` runs BEFORE `deliverEnvelope(envelope)`, and
   `system/init` is the FIRST envelope of turn 1 (before any assistant/result content). So a
   mismatched-session `system/init` throws -> `faultStdout` -> ingress stops -> process
   terminates, and NO turn-1 assistant content is ever delivered downstream. The identity
   guarantee holds; only its *timing* moved from a (permanently-deadlocking, in 2.1.207)
   pre-turn gate to the turn-1 envelope.

3. **No mis-identified session can produce usable output.** On resume/fork the first turn is
   transmitted before identity is confirmed, but this is a session-CONTINUITY property, not an
   AUTH property (the CLI authenticated with the same api key regardless of which session it
   resumed). Its output is quarantined by finding (2): the first envelope validated is
   `system/init`, and a mismatch kills the process before content flows.

4. **The internal initialize handshake cannot be spoofed into an auth bypass.** The
   `initialize` control_response is consumed internally (`tryConsumeInitializeResponse`,
   correlated on the fixed `claude-cli-initialize` request id) and never delivered downstream.
   It only flips readiness for a process we already spawned with a valid, pre-authorized key.

**Verdict: no auth bypass, no weakening of the api-key requirement, identity still validated.
Safe to flip.**

## Six raw-lifecycle proofs — 6 / 6 PASS (live, billable, key in-process only)

Driven against the EXACT staged 2.1.207 arm64 binary, model `claude-haiku-4-5`, scoped key
sourced in-process (never printed/logged/written/committed):

1. **multi-query** — PASS. Two `result{subtype:success}` turns on ONE persistent process,
   phase stayed `ready`, session id stable.
2. **resume** — PASS. Resumed the seeded session; continuity confirmed (recalled the secret
   word planted in the prior process), `result subtype success`.
3. **permission** — PASS. With `permissionMode:manual` + stdio prompt, the CLI emitted a
   `can_use_tool` control_request; the harness answered over the control channel and the turn
   settled with a `result`.
4. **interrupt** — PASS. A correlated interrupt `control_response` was received for the
   in-flight turn.
5. **post-interrupt** — PASS. The SAME process accepted a fresh turn after the interrupt and
   returned `result{subtype:success}` (phase `ready`).
6. **fork** — PASS. `ClaudeSessionHelpers.forkSession()` returned a distinct valid session id
   (no billable turn — local SDK storage op); resuming the fork carried the original history
   (recalled the planted word), `result subtype success`.

## Decision gate: PASSED -> flag flipped

All 6 proofs genuinely passed AND the security review is clean, so:
- `packages/engine/src/providers/feature-flags.ts`: `persistentClaude` requested-default -> `true`.
- `packages/server/src/app.ts`: `NativeClaudeLifecycleEvidence` (all six fields, cliVersion
  `2.1.207`) wired into the `createNativeClaudeRuntime` call, gating `canEnable()`.
- Server still clamps resolved/applied to real runtime availability (compatible install +
  programmatic auth + mutation token). `persistentClaude:false` remains the non-destructive rollback.

## Tests / cleanliness

- Engine suite 2206/2206 green; `claude-cli-process` 48/48 green; `tsc --noEmit` + provider-index
  public-surface clean (pre-flip). Server suite re-run after the wiring/flip (see commit).
- All proof harnesses were written under `/private/tmp` (outside the repo) and removed; the
  tree carries only the source changes. Billable spend: ~7 tiny `claude-haiku-4-5` turns.
