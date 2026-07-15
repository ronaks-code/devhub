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
