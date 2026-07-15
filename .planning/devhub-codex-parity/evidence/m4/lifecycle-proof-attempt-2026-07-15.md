# M4 six raw-lifecycle proofs — drive attempt, status 2026-07-15

Task: M4-LIFECYCLE-PROOFS (Ronak authorized the billable proof turns and the
staged 2.1.207 binary path).

Honest outcome: **the six raw-lifecycle proofs were NOT demonstrated.** Not
because of the version pin (that gate is cleared) but because there is **no
programmatic Anthropic credential on this machine**, and the persistent-Claude
runtime requires one before it will launch a single billable turn. No evidence
was fabricated. `persistentClaude` stays `false` and no `lifecycleEvidence`
object was wired into `app.ts`.

## What was proven live (real construction against the real runtime)

Drove the actual production drive path (`createNativeClaudeRuntime` +
`ClaudePersistentSupervisor`) against the staged EXACT 2.1.207 arm64 binary via
`DEVHUB_CLAUDE_EXECUTABLE`, constructed with `isEnabled: () => true`. Machine
output (spends nothing — it stops at the first real gate):

```json
{
  "executableSet": true,
  "discovered": {
    "executable": "/private/tmp/devhub-m3m4-proof/arm64bin/package/claude",
    "home": "/Users/ronak/.claude"
  },
  "programmaticAuth": { "threw": "ClaudeAuthPolicyError", "code": "INVALID_ENVIRONMENT" },
  "runtimeCreated": false,
  "supervisorAcquire": {
    "threw": "ClaudeSupervisorError",
    "code": "UNAUTHORIZED_AUTH",
    "message": "Claude persistent runtime requires programmatic authentication"
  }
}
```

### Gate 1 — exact CLI version pin: CLEARED

`discoverNativeClaudeInstallation` accepts the staged binary
(`/private/tmp/devhub-m3m4-proof/arm64bin/package/claude`, realpath of the
`/tmp/...` stage) and pairs it with the real config home `/Users/ronak/.claude`.
The binary runs natively and prints exactly `2.1.207 (Claude Code)` with empty
stderr, so the exact-string `--version` probe passes. The x64/Rosetta cpu-gate
bypass (`npm pack @anthropic-ai/claude-code-darwin-arm64@2.1.207`) did its job.

### Gate 2 — programmatic auth: HARD BLOCK (the sole remaining blocker)

- `createNativeClaudeRuntime(...)` returned `null`. Its `authorizedEnvironment`
  step calls `requireClaudeProgrammaticAuth` and, finding no accepted method,
  refuses to construct the runtime at all.
- Constructing `ClaudePersistentSupervisor` directly and calling `acquire()`
  (the exact drive surface the task names) throws `ClaudeSupervisorError`
  `UNAUTHORIZED_AUTH` — "Claude persistent runtime requires programmatic
  authentication" — from its internal `authorized()` gate, BEFORE any CLI
  process is launched. So `startTask` / `send` / `resumeTask` / `forkTask` /
  `interrupt` / `respond` are all unreachable; not one billable turn can start.

This is by design. `auth-policy.ts` accepts only programmatic product
credentials — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (workload identity),
Bedrock, Vertex, or Foundry — and its comment is explicit: "A stored
Claude-app/Pro/Max OAuth login is intentionally not an accepted fallback."

## Why the credential is genuinely absent (exhaustive check, names only)

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`: unset in the current process env,
  in a login+interactive `zsh -lic` shell, and in `launchctl getenv`.
- No `~/.claude/.credentials.json`; no `apiKeyHelper` in `~/.claude/settings.json`.
- No `.env*` in the repo; no `ANTHROPIC_*` in `~/.zshrc/.zprofile/.bashrc/.profile`.
- The only Claude secret on the box is the macOS Keychain "Claude Safe Storage"
  (the OAuth login for the interactive CLI) — which the DevHub policy rejects
  for programmatic use, so it does not satisfy Gate 2.

The M3 Codex proof succeeded because Codex authenticates from real `~/.codex`
interactive auth. Claude's runtime does NOT accept the analogous interactive
Claude OAuth — it demands a programmatic key — so the same "real local auth"
that unblocked M3 does not unblock M4.

## What it would take to finish (no code change; do not weaken the gate)

Provide ONE real programmatic credential to the DevHub process environment
(e.g. a real `ANTHROPIC_API_KEY=sk-ant-...`, or workload-identity token, or a
configured Bedrock/Vertex/Foundry env). With that present:

1. `createNativeClaudeRuntime` constructs; `supervisor.acquire` gets past auth
   and launches the staged 2.1.207 CLI.
2. Drive the six proofs through the adapter/lease surface and capture raw
   receipts: `persistentMultiQuery` (2+ sends over one lease/generation),
   `rawResume` (release + re-acquire `launch:"resume"` after supervisor restart),
   `rawPermissionResponse` (`respond()` to a real tool-use request),
   `rawInterruptReceipt` (`interrupt()` mid-turn ack), `postInterruptResume`
   (same-id resume + continued conversation), `forkContinuation` (fork that
   continues through the execution owner).
3. ONLY after all six are captured true, encode the earned
   `NativeClaudeLifecycleEvidence` and wire it into the
   `createNativeClaudeRuntime({ ..., lifecycleEvidence })` call in `app.ts`.

Do NOT change `auth-policy.ts` to accept OAuth — that is an intentional security
gate, not the blocker to route around.

## Cost / cleanliness

Zero billable turns were spent — the auth gate fires before any CLI launch. No
scratch Claude task was created (the runtime never enabled). The throwaway probe
(`packages/server/m4-lifecycle-probe.mts`) was removed after capturing this
output; the tree is left clean.
