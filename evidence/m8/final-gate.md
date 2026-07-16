# M8-FINAL-GATE — final gate transcript

Branch: `wip/devhub-background-runner`
Tip at gate time: `cc215f0` (M8-CLEANUP-SWEEP: remove disposable M3/M5 QA fixture servers)
Run: 2026-07-16, one clean pass of the exact plan-specified command sequence.

## Commands run, in order, with exit codes

1. `pnpm install --frozen-lockfile` — **exit 0**
   Lockfile up to date, resolution skipped. Only warning: ignored optional
   build scripts for `esbuild` (pre-existing, not a gate condition).

2. `pnpm exec turbo run typecheck test build --force` — **exit 0** (on the
   3rd attempt; see "Flake note" below)
   - `Tasks: 11 successful, 11 total`
   - `@devhub/engine:test` — Test Files 80 passed (80), **Tests 2230 passed
     (2230)**
   - `@devhub/server:test` — Test Files 16 passed (16), **Tests 270 passed
     (270)**
   - `@devhub/web:test` — Test Files 44 passed (44), **Tests 586 passed
     (586)**
   - `typecheck` passed for `@devhub/engine`, `@devhub/server`, `@devhub/web`
   - `build` passed for `@devhub/engine`, `@devhub/server`, `@devhub/web`,
     and `@devhub/desktop` (turbo's `build` graph pulls in the desktop Tauri
     bundle as a dependent task; it produced `DevHub.app` +
     `DevHub_0.1.0_x64.dmg` under `apps/desktop/src-tauri/target/release/
     bundle/`, unsigned, same as the standalone command in step 4)
   - Full raw log: `/tmp/final-gate-full3.log` (not committed — build logs are
     gitignored `.log`; counts above are the load-bearing record)

   **Flake note (no code change made):** the first two attempts at this
   combined command failed with a single timeout in
   `packages/server/test/cross-provider-fork.test.ts` ("rejects both routes
   with a disabled response when crossProviderFork is off" — Test timed out
   in 5000ms). Isolated re-run of just that file
   (`pnpm --filter @devhub/server test -- cross-provider-fork`) passed in
   1321ms, and the third full combined attempt also passed clean with the
   same 270/270 count — confirming this is CPU-contention flake (the
   `@devhub/desktop` Rust/Cargo compile running in parallel under `turbo`
   starves a 5s-budget HTTP test), not a real regression. No source file was
   touched to get the green run.

3. `pnpm --filter @devhub/tui smoke` — **exit 0**
   Renders the TUI's first frame via `ink-testing-library` against an
   in-process `Engine()` (no HTTP server, no port — see M8-TUI-SMOKE entry in
   `tasks/STATUS.md` for why). Raw capture: `/tmp/tui-smoke.log` (also on
   file from the earlier M8-TUI-SMOKE task at
   `evidence/m8/tui/smoke.txt`, re-confirmed here at the current tip).

4. `pnpm --filter @devhub/desktop build` — **exit 0** (unsigned; Apple
   signing/notarization NOT attempted, per hard gate)
   - `vite build` — web assets built in 4.38s
   - `cargo`/Tauri release build finished in 13.19s (mostly warm from the
     turbo `build` pass in step 2)
   - Bundled outputs confirmed on disk:
     `apps/desktop/src-tauri/target/release/bundle/macos/DevHub.app`
     `apps/desktop/src-tauri/target/release/bundle/dmg/DevHub_0.1.0_x64.dmg`
     (4,936,013 bytes)

5. `git diff --check` — **exit 0**, no output (no whitespace errors)

6. `git status --short` — **exit 0**, no output (working tree clean)

## Summary

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `turbo run typecheck test build --force` | exit 0 — engine 2230/2230, server 270/270, web 586/586, typecheck x3 clean, build x4 clean (incl. desktop) |
| `@devhub/tui smoke` | exit 0 |
| `@devhub/desktop build` | exit 0 — unsigned `DevHub.app` + `DevHub_0.1.0_x64.dmg` produced |
| `git diff --check` | exit 0, clean |
| `git status --short` | exit 0, clean |

**Held (unchanged):** `origin/main` merge remains [RONAK-GATE]/hard-gate — not
exercised by this task. Apple code-signing/notarization remains a hard gate —
not attempted; the desktop build above is the unsigned artifact only.
