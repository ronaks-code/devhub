# M8 checklist item 2 — sidecar/health/provider-discovery hardening audit

Audits, and closes real gaps in, the four sub-items of M8's checklist item 2
("Fix deterministic server sidecar/IPC/API base, strict health identity,
PATH-independent provider discovery, tray/hotkey/notification behavior" —
`.planning/devhub-codex-parity/implementation-plan.md` line 424). Tray/hotkey/
notification behavior is out of this task's scope (already covered by
`src/tray.rs`/`src/shortcut.rs`/`src/notify.rs`, unrelated code paths — not
touched here).

## (a) API base + server sidecar spawn determinism

**Evidence-present, already correct** — the `@devhub/server` filter fix from
M8-DESKTOP-BUILD (`apps/desktop/src-tauri/src/lib.rs`'s `CLAUDE_UI_SERVER_CMD`
default) is still `pnpm --filter @devhub/server start` (confirmed by reading
`ensure_server()`, line ~197 of `lib.rs`) — not the stale `@claude-ui/server`
name that was a silent no-op. `apps/web`'s API calls are same-origin relative
`/api/...` (vite proxies `/api` in dev; the Fastify server serves both API and
the built web bundle in the packaged app), so there is no separate "API base
URL" to drift — one deterministic origin. No code change needed for this
sub-item; it inherits the fix already landed and verified in M8-DESKTOP-BUILD
(`evidence/m8/desktop/launch.log` vs `launch2.log`).

REAL GAP found and fixed in the *spawn-vs-reuse decision*, not the spawn
command itself: `ensure_server()`'s guard (`health_ok(...) || port_open(...)`)
and the readiness-wait loop `wait_for_health()` both delegated to a
`health_ok()` that only checked for a 2xx HTTP status — see (b) below, which
is the actual mechanism that makes this decision deterministic (able to tell
"the real DevHub server is already up, don't spawn another" apart from "some
unrelated process merely has the port").

## (b) `/api/health` strict identity

**REAL GAP, fixed.** Before this task, `packages/server/src/app.ts`'s
`GET /api/health` returned only `{ ok, ready, sessionCount }` — a bare 2xx
with generic-looking fields any process could plausibly answer with. This is
not hypothetical: `tasks/STATUS.md`'s M8-hardening incident log documents an
earlier task session in THIS SAME repo accidentally treating a different
agent's real DevHub server on port 8787 as its own scratch target, precisely
because nothing in the response proved *which* server answered.

Fix: `GET /api/health` now also returns `service: "devhub-server"` (the
`DEVHUB_SERVER_SERVICE_ID` constant, `packages/server/src/routes/health.ts`)
and `version` (the package version, reusing the existing `serverVersion()`
helper the diagnostics route already had). `apps/desktop/src-tauri/src/lib.rs`'s
`health_ok()` was the only consumer that needed to *act* on this — it now
reads the full response body (capped at 8KB, was previously truncated to the
first 256 bytes and only inspected the status line) and requires both a 2xx
status AND the `"service"`/`"devhub-server"` markers in the body
(`response_proves_devhub_identity`) before treating the port as "already the
real server."

Tests:
- `packages/server/test/app.test.ts` — new case
  `"GET /api/health carries a strict identity — a 2xx alone doesn't prove which server answered"`
  asserts `body.service === "devhub-server"` and a non-empty `body.version`.
- `apps/desktop/src-tauri/src/lib.rs` — new `#[cfg(test)] mod health_probe_tests`
  (5 tests, this crate's FIRST Rust unit tests — there was no test harness at
  all before this task): accepts a correctly-identified 2xx; **rejects a 2xx
  from an unrelated process on the same port** (the exact incident-shaped case
  — this is the one that would have caught the STATUS.md incident); rejects a
  2xx JSON body missing `service` entirely; rejects a non-2xx status even with
  the right body; accepts regardless of JSON key order/spacing (so this
  doesn't silently break if the server's JSON serializer output shape shifts).
  `cargo test --lib`: 5/5 passed. `cargo build --release`: clean, no warnings.

## (c) PATH-independent provider discovery

**Codex — evidence-present, already correct.**
`packages/server/src/native-codex-runtime.ts`'s `discoverNativeCodexInstallation`
only trusts an ABSOLUTE candidate that passes `executableFile()` (realpath +
`statSync().isFile()` + `X_OK` access check) — PATH entries are walked but
each candidate is independently validated, never handed bare to `spawn()`.
Confirmed by reading the function directly; no test changes needed.

**Claude (native/gated adapter) — evidence-present, already correct.**
`packages/server/src/native-claude-runtime.ts`'s `discoverNativeClaudeInstallation`
uses the identical validated-absolute-path pattern (`executableFile`), plus an
explicit `DEVHUB_CLAUDE_EXECUTABLE` override that is ALSO validated (not
trusted as-is). Confirmed by reading the function directly; existing coverage
in `packages/server/test/native-claude-runtime.test.ts`.

**Claude (default chat driver) — REAL GAP, fixed.** The provider discovery
above only feeds the flag-gated "native Claude" persistent-supervisor path
(`persistentClaude`, default OFF). The driver actually used for every chat
turn today — `CliDriver`/`PersistentSession` in
`packages/engine/src/driver/cli.ts`, wired live into
`packages/server/src/ws.ts`, `routes/git.ts`, `routes/pr.ts`, `routes/summary.ts`
via `createDriver()` — resolved its binary as
`process.env.CLAUDE_UI_CLAUDE_BIN?.trim() || "claude"` and handed that bare
string straight to `spawn()`. A bare command name is resolved by the OS
against whatever `process.env.PATH` happens to be at spawn time — exactly the
ambient, non-deterministic lookup this checklist item exists to close, and it
was live in the code path every real chat message goes through, not just the
disabled-by-default native path.

Fix: added `resolveClaudeBin()` to `packages/engine/src/driver/cli.ts`,
mirroring the same validated-absolute-path pattern as the server's native
Claude/Codex discovery (kept as a small local copy — engine must not depend on
server, wrong direction of the dependency graph). Resolution order: (1) an
explicit `CLAUDE_UI_CLAUDE_BIN` override, trusted as-is — unchanged behavior,
an intentional escape hatch, not ambient discovery; (2) each absolute PATH
entry plus the same well-known install dirs
(`~/.local/bin`, `~/.claude/bin`, `~/.claude/local`, platform Homebrew/`/usr/local`/`/usr`
bin dirs) the native runtime discovery already trusts, each validated via
realpath + `isFile` + `X_OK`; (3) bare `"claude"` only as a last resort when
nothing validates, preserving prior behavior for setups a scan can't
anticipate (shell shims/functions) instead of refusing to spawn. `CLAUDE_BIN`
is now `resolveClaudeBin()`'s result, computed once at module load exactly as
before (same performance characteristics, now deterministic).

Tests: new `packages/engine/test/driver/resolve-claude-bin.test.ts` (7 tests,
real temp dirs/files, no fs mocking) — explicit override passthrough
(unvalidated, by design); resolves a real executable on an absolute PATH
entry to its absolute path; follows a symlink to the real target (realpath,
not the link); skips a non-executable file and falls through to a later valid
candidate; falls back to `~/.local/bin` when PATH has nothing; falls back to
the bare name when nothing validates anywhere; and — the case that actually
proves this isn't just "PATH scanning with extra steps" — **ignores a
relative PATH entry**, so a cwd-relative shadow can never be trusted.

## Full gate (this task's diff only)

```
pnpm exec turbo run test typecheck build --filter @devhub/engine \
  --filter @devhub/server --filter @devhub/web --force
```
- engine: 82 files / 2243 tests green (+7 new; was 2236/81 files before this task)
- server: 16 files / 270 tests green (+1 new; was 269/16 files before this task)
- web: 44 files / 586 tests green (unchanged — no web changes)
- `tsc --noEmit` clean on engine/server/web; `vite build` clean.
- `pnpm lint`: 0 warnings/0 errors across engine (129 files) / server (50
  files) / web (208 files) / tui (7 files), same as before this task.
- Rust: `cargo test --lib` (apps/desktop/src-tauri) 5/5 passed — this crate's
  first unit tests. `cargo build --release`: clean, no warnings.
- `git diff --check`: clean.

Landed on `wip/devhub-background-runner` only, per task instructions — NOT
`origin/main`.
