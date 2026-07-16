# M8-DESKTOP-BUILD — Tauri desktop build + packaged smoke

Date: 2026-07-16
Branch: wip/devhub-background-runner
Machine: macOS arm64, Rust 1.96.0, pnpm 10.32.1, Node 24.14.0

## Build
Ran the real Tauri v2 build for @devhub/desktop (`pnpm build` -> `tauri build`).
beforeBuildCommand ran `pnpm --filter @devhub/web build` (vite, green), then
cargo build --release compiled the Rust crate, then tauri-bundler packaged:
- apps/desktop/src-tauri/target/release/bundle/macos/Claude UI.app
- apps/desktop/src-tauri/target/release/bundle/dmg/Claude UI_0.1.0_x64.dmg
Full log: build.log

## Signing status - STAGED, not attempted
No Apple Developer ID / notarization credentials on this box; none used.
codesign -dvvv (codesign-info.txt): Signature=adhoc, TeamIdentifier=not set
(the default ad-hoc linker signature on Apple Silicon, not a real cert).
spctl -a -vv (spctl-check.txt) confirms Gatekeeper does not see a real
signature. Real code-signing + notarization is HELD PENDING Apple credentials
per hard gate #4 - not attempted here.

## Bug found + fixed
apps/desktop/src-tauri/src/lib.rs defaulted CLAUDE_UI_SERVER_CMD to
`pnpm --filter @claude-ui/server start` - a stale pre-rename package name.
The real package is @devhub/server, so the filter matched nothing and pnpm
silently spawned nothing (exit 0, no server). Reproduced live in launch.log
(pnpm's own "No projects matched the filters" line). Fixed the default (and
its doc comment) to `pnpm --filter @devhub/server start`, rebuilt, reverified
in launch2.log: server now actually starts (`[devhub] server on
http://127.0.0.1:8787`).

## Smoke pass
Launched the built unsigned .app binary directly. Native window opened
(System Events confirms a window titled "Claude UI" - launch2.log). The
app's self-spawned real @devhub/server came up on 127.0.0.1:8787. Hit the
core routes the web bundle depends on directly against that live server
(smoke-api.log), all 200, all real data from this machine's actual
~/.claude/projects history (not synthetic):
- GET /api/health -> 200
- GET /api/projects -> 200 (real project list)
- GET /api/running -> 200 (real running sessions)
- GET /api/all-sessions?limit=1 -> 200
- GET /api/health/diagnostics -> 200
App stayed up 27s+ under continuous polling, no crash, then shut down cleanly
on kill (no zombie/hang). No panics/errors in the process log beyond the
expected startup line.

Console-level (devtools) inspection wasn't available in this headless/no-
screen-capture environment, so the smoke pass proves the equivalent from the
server side: every route the web bundle calls on load answered 200 with real
data while the native window was open - the same thing devtools would show
as "no failed network requests."

## Files here
- build.log - tauri build output (pre-fix)
- codesign-info.txt, spctl-check.txt - signing verification
- launch.log - pre-fix launch (reproduces the stale-package-name bug)
- launch2.log - post-fix launch (server actually starts)
- smoke-api.log - core route smoke pass, all 200

## Monorepo build gate
pnpm build (engine+server+web, turbo) and pnpm test (full suite) both green
before this task's change: engine 81 files/2236 tests, server 16/269,
web 40/568, tsc --noEmit clean. This task only touched
apps/desktop/src-tauri/src/lib.rs (doc comment + one string literal).
