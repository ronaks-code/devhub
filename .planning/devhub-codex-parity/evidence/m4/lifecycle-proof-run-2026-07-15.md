# M4 six raw-lifecycle proofs — live drive run, 2026-07-15 (DEVHUB-M4-KEY)

Task: retrieve the Anthropic key from the macOS keychain and RUN the six
persistentClaude raw-lifecycle proofs against the staged EXACT 2.1.207 arm64
binary. Ronak authorized the billable turns and the keychain retrieval.

## Honest outcome

- **Gate 2 (programmatic credential): CLEARED.** The key IS retrievable
  non-interactively from the keychain, and the native Claude runtime now
  constructs (`auth.method === "api-key"`). The blocker the previous attempt hit
  is gone.
- **The six proofs did NOT run.** A *second, credential-independent* blocker
  surfaced the moment the runtime tried to launch the real CLI: the persistent
  process readiness handshake times out (`INIT_TIMEOUT`). No lifecycle turn ever
  starts. **No evidence was fabricated; `persistentClaude` stays `false`; no
  `lifecycleEvidence` was wired into `app.ts`.**

## What was proven (real, live)

1. **Credential retrieval (in-process only, never logged/written/committed).**
   The key lives in the login keychain under `acct = env:local:shared:ANTHROPIC_API_KEY`
   (note: it is the *account*, not the *service* — the task's `-s` form misses
   it; the `-a` form finds it):

   ```sh
   security find-generic-password -a "env:local:shared:ANTHROPIC_API_KEY" -w
   ```

   Retrieved a real `sk-ant-…` value (len 108). `envchain`/`op` are not
   installed; not needed.

2. **The key authenticates the staged binary.** A trivial print query against
   the EXACT staged 2.1.207 arm64 binary returned `ok`:

   ```sh
   ANTHROPIC_API_KEY=<from keychain> \
     /private/tmp/devhub-m3m4-proof/arm64bin/package/claude \
     -p "Reply with exactly one word: ok" --model claude-haiku-4-5
   # -> ok
   ```

3. **Raw persistent stream-json mode works when driven directly.** Spawning the
   binary with DevHub's exact argv (`--input-format stream-json --output-format
   stream-json --verbose … --permission-prompt-tool stdio --permission-mode
   manual --session-id <uuid>`) and writing a `user` envelope produced a full,
   correct turn: `system/init`, `stream_event` deltas, `assistant` message, and
   a `result{subtype:"success"}`. The CLI itself is healthy.

## The blocker: `INIT_TIMEOUT` in the readiness handshake

Driving `ClaudeCliProcess.start()` directly against the staged binary:

```
start() REJECTED after 5004ms  code=INIT_TIMEOUT  msg=Claude CLI init identity validation timed out
terminalError: INIT_TIMEOUT
stderr: ""   (empty — the CLI did not error; it simply never emitted `system/init`)
```

### Root cause (code + empirical CLI behavior)

- `ClaudeCliProcess` marks the process `ready` (and resolves `start()`) ONLY via
  `confirmExpectedSessionIdentity()`, which requires `_sessionId === expectedSessionId`.
- `_sessionId` is set ONLY by `captureSessionId()`, which fires ONLY on a
  `{type:"system", subtype:"init"}` envelope carrying the matching session id.
- `armInitIdentityDeadline()` gives that `system/init` a `spawnOutcomeTimeoutMs`
  (default **5s**, hardcoded — the supervisor's default runtime factory does not
  plumb a larger value) window, else `beginFailure(INIT_TIMEOUT)`.
- **But CLI 2.1.207, in stream-json input mode, does not emit `system/init`
  until the first user turn begins.** Verified empirically three ways — with the
  real `~/.claude` config, with a clean empty `CLAUDE_CONFIG_DIR`, and with no
  `--session-id`: no `system/init` appears pre-turn within 8s. A `control_request
  {subtype:"initialize"}` gets a `control_response` (commands/agents/models/
  account/pid) in ~0.8–1.0s but still **no `system/init`**. `system/init` only
  appears as the first output of the first user turn.

So the flow deadlocks by design: `supervisor.acquire()` awaits `start()`, which
awaits a pre-turn `system/init` that the real CLI only emits *during* a turn —
and the adapter cannot send the first turn until `start()` resolves. Every
lifecycle proof (multi-query / resume / permission / interrupt / post-interrupt
/ fork) is therefore unreachable.

This is why the previous attempt never saw it: it was blocked earlier, at the
auth gate. With the credential supplied, the *next* real blocker surfaced.

### Reproduction (minimal, no secret in argv/logs)

```ts
import { ClaudeCliProcess } from "@devhub/engine/providers"; // (deep import in-repo)
const key = execFileSync("security",
  ["find-generic-password","-a","env:local:shared:ANTHROPIC_API_KEY","-w"],
  {encoding:"utf8"}).trim();
const proc = new ClaudeCliProcess({
  executable: "/private/tmp/devhub-m3m4-proof/arm64bin/package/claude",
  configHome: <tmp>, cwd: <tmp>,
  baseEnv: { ...scrubbed, ANTHROPIC_API_KEY: key },
  launch: { kind: "new", sessionId: <uuid> },
  model: "claude-haiku-4-5", permissionMode: "manual",
  permissionPromptStdio: true, onEnvelope: () => {},
});
await proc.start(); // rejects ~5004ms with INIT_TIMEOUT
```

## Recommendation (needs Ronak's explicit go — security-adjacent, not a hotfix)

Do NOT weaken any security gate blindly. The correct fix is a readiness-handshake
change in `cli-process.ts` (+ `task-runtime.ts` + tests): treat the SDK
`control_request {subtype:"initialize"}` → `control_response` as the readiness
signal (that IS the Agent SDK's real handshake), and keep session-identity
validation as a check applied when `system/init` arrives on the first turn
(fail/latch the turn on mismatch) rather than as a pre-turn ready-gate. This
preserves the identity guarantee while matching the CLI's actual protocol.

That is a meaningful change to the persistent-runtime start state machine and
its security-sensitive session-identity validation, touching the extensive
cli-process test suite. Per the "significant change → explain + get review, no
sweeping unsupervised rewrites" rule, it should be an approved, reviewed change,
not slipped into a background proof run. Once it lands, re-run the six proofs
with the same key path (this doc's recipe) and only then encode
`NativeClaudeLifecycleEvidence` and wire it into `createNativeClaudeRuntime` in
`app.ts`.

## Cost / cleanliness

- Billable spend: a handful of tiny `claude-haiku-4-5` turns for the auth/raw-mode
  verifications (proofs #2 and #3 above). The persistent-runtime path spent
  nothing — it fails at the readiness handshake before any turn.
- All throwaway harnesses/probes were removed; the tree is left clean. No
  `lifecycleEvidence` wiring, no flag flips, no faked receipts.
