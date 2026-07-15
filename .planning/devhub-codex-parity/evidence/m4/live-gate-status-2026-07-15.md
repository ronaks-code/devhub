# M4 persistent-Claude live gate — status 2026-07-15

Task: M3-M4-LIVE-PROOF (Ronak authorized the billable proof turns).

Honest outcome: **M4 NOT passed in this run.** The gate is now fully characterized
and made runnable, but the six-step raw-lifecycle proof was not completed, so the
`lifecycleEvidence` object was NOT fabricated and `persistentClaude` stays false.

## What gates `persistentClaude` (two real gates, in order)

1. **Exact CLI version pin.** `native-claude-runtime.ts` pins the supported CLI to
   EXACTLY `2.1.207 (Claude Code)` (`SUPPORTED_CLAUDE_VERSION_OUTPUT`), checked by
   an exact-string `--version` probe (stdout must equal the pin, stderr must be
   empty). The machine's global CLI is `2.1.210`, which fails the exact match, so
   `createNativeClaudeRuntime` returns null → feature unavailable.

   **Cleared/runnable:** the runtime honors a `DEVHUB_CLAUDE_EXECUTABLE` override.
   The exact `2.1.207` arm64 native binary was staged WITHOUT touching the user's
   global CLI: `npm pack @anthropic-ai/claude-code-darwin-arm64@2.1.207` (npm on
   this box runs x64 under Rosetta and refuses/omits the arm64 optional dep, and
   the x64 binary needs AVX which Rosetta doesn't emulate; `npm pack` bypasses the
   cpu gate and downloads the tarball directly). Extracted binary is a Mach-O arm64
   executable that runs natively and prints exactly `2.1.207 (Claude Code)\n` with
   empty stderr — it PASSES the version probe. Staged at
   `/tmp/devhub-m3m4-proof/arm64bin/package/claude`.

2. **Lifecycle-evidence gate (the real M4 gate).** Even with the correct binary,
   `persistentClaude` still resolved `false`. `createNativeClaudeRuntime` computes
   `canEnable = () => compatibility.lifecycleVerified`, and
   `lifecycleVerified = isNativeClaudeLifecycleEvidence(options.lifecycleEvidence)`.
   That predicate requires an evidence object with ALL of:
   `cliVersion==="2.1.207"`, `persistentMultiQuery`, `rawResume`,
   `rawPermissionResponse`, `rawInterruptReceipt`, `postInterruptResume`,
   `forkContinuation` — every boolean true. `app.ts` does NOT pass
   `lifecycleEvidence`, so `lifecycleVerified` is false BY DESIGN: the persistent
   Claude runtime is intentionally locked closed until the six raw-lifecycle proofs
   are demonstrated and the earned evidence is wired in.

   Confirmed live: with `DEVHUB_CLAUDE_EXECUTABLE` = the 2.1.207 binary and
   `devHubFeatures.persistentClaude` requested `true` via `PATCH /api/settings`,
   `GET /api/settings` still resolves `persistentClaude:false` (available/applied
   gated closed for lack of lifecycle evidence).

## Why the six proofs can't go through the HTTP routes

The DevHub `provider-tasks` mutation routes (and the adapter's `isEnabled`) are
gated by the SAME `persistentClaude`/`lifecycleVerified` chain. So the six raw
proofs must be driven DIRECTLY against `ClaudeNativeAdapter` +
`ClaudePersistentSupervisor` (constructed with `isEnabled: () => true`, the staged
2.1.207 arm64 executable, real `~/.claude` home + real auth), using the adapter's
`startTask`/`send`/`resumeTask`/`forkTask`/`interrupt`/`respond`/`subscribe`
surface, capturing raw frames for each of:

1. `persistentMultiQuery` — 2+ queries over the same persistent raw peer.
2. `rawResume` — raw `--resume` after a supervisor restart.
3. `rawPermissionResponse` — a real tool-use permission request answered via `respond()`.
4. `rawInterruptReceipt` — a real mid-turn `interrupt()` acknowledgement.
5. `postInterruptResume` — same-id resume + continued conversation after the interrupt.
6. `forkContinuation` — a fork that continues through the selected execution owner.

Then encode the earned `lifecycleEvidence` and wire it into the
`createNativeClaudeRuntime({ ..., lifecycleEvidence })` call in `app.ts`.

## Why this run stopped short (honest)

Steps 3 (permission) and 4/5 (interrupt + post-interrupt resume) require inducing
and correctly observing timing-sensitive raw control frames against a live billable
CLI. Completing all six correctly — and ONLY then setting the evidence flags — is a
substantial, separate harness effort. Setting the evidence object without those
real captures would be faking the gate, which is explicitly disallowed. So this run
de-risked and characterized M4 (version pin solved, runnable binary staged, adapter
drive path identified) but did NOT complete the proof.

`persistentClaude` requested-default stays `false`. No fabricated evidence was
introduced. No scratch Claude task was created (the runtime never enabled).
