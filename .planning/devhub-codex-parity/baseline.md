# DevHub Codex Parity Baseline

Captured 2026-07-12 17:19-17:31 PDT (2026-07-13 00:19-00:31 UTC) before DevHub product edits.

## Repository identity

- Workspace: `/Users/ronak/Documents/01-code/active/claude-ui`
- Branch: `campaign/auto-improve`
- HEAD: `8c852ec181fae4b2bd96406d957cb6a8afe51142`
- The current branch is retained. No branch, worktree, stash, reset, checkout, stage, commit, or discard operation was performed.
- `.planning/` did not exist before this program.
- `tasks/todo.md` and `tasks/campaign.md` are legacy Claude UI campaign records. Their historical content is preserved.

## Preserved dirty state

`git status --short` before any product edit:

```text
 M .gitignore
 M apps/web/src/App.tsx
 M apps/web/src/components/ChatPane.tsx
 M apps/web/src/components/SlashPalette.tsx
 M apps/web/src/lib/api.ts
 M apps/web/src/lib/router.ts
 M packages/engine/src/index.ts
 M packages/server/src/app.ts
?? AGENTS.md
?? apps/web/src/components/OpenAIPane.tsx
?? packages/engine/src/openai-session.ts
?? packages/server/src/openai-ws.ts
?? packages/server/src/routes/openai.ts
```

Tracked delta: 8 files, 446 insertions, 24 deletions. There were no staged changes. Five files were untracked.

### Protected backup

- Directory: `/Users/ronak/.codex/backups/devhub-codex-parity/20260713T001908Z`
- Archive: `/Users/ronak/.codex/backups/devhub-codex-parity/20260713T001908Z.tar.gz`
- Contents: working-tree binary patch, staged-index patch, branch and HEAD, porcelain status, full relative-path copies of every existing modified/untracked file, source hashes, backup hashes, and archive hash.
- Protection: backup directory and archive are read-only.
- Verification: all 13 source paths passed SHA-256 verification; the source and backup manifests were identical after path normalization; the archive checksum passed.

The cold Tauri package command temporarily normalized one clean `Cargo.toml` line. That exact command-generated delta was reverted with a one-line patch. The final source status exactly matches the initial dirty set above.

During later M1 probes, the external memory-context injector changed only the timestamp line in the untracked root `AGENTS.md` from `5:18pm` to `5:30pm` PDT. Codex did not revert or overwrite that concurrent change. Both versions are preserved: the initial file is in the main snapshot, and the concurrent version is in `/Users/ronak/.codex/backups/devhub-codex-parity/20260713T004800Z-concurrent-agents` with SHA-256 `2b7bea327a674a28ecb257ca82e515f06d25cb4e1574c29d6244ae790ebb3a74`.

## Stack and installed versions

| Surface | Version/evidence |
|---|---|
| Node.js | `v25.8.1` |
| pnpm | `10.32.1` (`packageManager: pnpm@10.32.1`) |
| Turbo | `2.9.18` |
| Codex CLI | `codex-cli 0.144.1`, arm64 native binary |
| Claude Code CLI | `2.1.207`, `/Users/ronak/.local/bin/claude` -> `/Users/ronak/.local/share/claude/versions/2.1.207` |
| Tauri CLI | `2.11.2` |
| Rust | `rustc 1.94.0`, `cargo 1.94.0` |
| macOS | `26.5.1 (25F80)` |
| Installed ChatGPT/Codex app | bundle `com.openai.codex`, version `26.707.51957`, build `5175` |
| Installed Claude app | bundle `com.anthropic.claudefordesktop`, version/build `1.17377.2` |

The desktop/server shell environment does not currently find `claude` on `PATH`; the binary exists at the absolute path above. Tauri documentation also warns that GUI apps do not inherit shell-dotfile `PATH`, so executable discovery must be explicit.

## Relevant SHA-256 hashes

| Artifact | SHA-256 |
|---|---|
| `package.json` | `a82b4428ec8fe0bdb26003ec72090421f698cb6c1a32904547c5d390b29c882f` |
| `pnpm-lock.yaml` | `bb73be9b9001a8337acab10054f7dd205a9d7d5f23d69bf1aa2dd195bada705f` |
| `pnpm-workspace.yaml` | `316f2a0038d464f103abd64d7338dacefc35d0d09e57c8296defa0d5ddb898fe` |
| `turbo.json` | `3c6fa3f18ac5a2d176cdef3b7c938773164661129833091dd88823d6d4f1d05e` |
| `apps/web/src/App.tsx` | `22dc192b32cc2e510d26f8894a66feec8997915b490cdd8fe3ea4c84f6828709` |
| `apps/web/src/components/ui.tsx` | `66c2ce9d4be4f67bd61a72da95021f7111e540a90a5fc3ab55c2b48fc9497e24` |
| `apps/web/src/index.css` | `fdebf4c3c0142a8fd6617f849e0b82407ab2dd92794744d4fe106e8479eb26fd` |
| `packages/engine/src/index.ts` | `e411175c3a40e5fa4470add7f414b7d523ba44944d2a716700f9e7c995b8c624` |
| `packages/server/src/app.ts` | `1cc4ad340f8fb3a22064bf3c7364f2360cf5357ea04dc6f8772880a6dd0d9d04` |
| `apps/desktop/src-tauri/tauri.conf.json` | `cb5d243b930de4cffc2b58cee15d17805e5a741e200f60a05b84af5120e5a196` |
| Codex binary | `29915529b97697def1a957b0505e770aa6a45744435d62fc263e98d7619e167a` |
| Claude CLI symlink target bytes | `1397a062c6889675055e3314dd956376ac51262a7734ad9e819c26975d71547a` |
| ChatGPT app `Info.plist` | `6dcaad54c80b114561de3cd217c9bea640e2768e9e04fb2a014fde1b643fbc75` |
| Claude app `Info.plist` | `f8d758e8cec7cf7080459392f94f17501cef79a1caaab09584682401e875be0b` |

All dirty source-file hashes are also recorded in the protected backup manifest.

## Reverified repository leads

- `apps/web` is React 19 + Vite 6 + Tailwind 4 + TypeScript + Lucide + `clsx` + `tailwind-merge`.
- `cn()` exists at `apps/web/src/lib/utils.ts`.
- `apps/web/src/App.tsx` is exactly 1,729 lines at baseline.
- `apps/web/src/components/ui.tsx` is a 91-line bespoke compatibility facade.
- `components.json` is absent, the `@/*` alias is absent, and `pnpm dlx shadcn@latest info --json` reports Vite, `rsc:false`, TypeScript, Tailwind v4, `src/index.css`, no config, and zero installed components.
- Claude production execution remains one `claude -p` process per turn. Its persistent stream class is scaffold-only and approval response is a no-op.
- Codex support is a read-only rollout history parser with two GET endpoints; there is no app-server lifecycle.
- The dirty raw OpenAI path is an in-memory Chat Completions agent loop and exposes unsandboxed bash/read/write tools. Its REST and WebSocket shapes disagree with the dirty frontend.

## Quality-gate baseline

| Gate | Exact command | Result |
|---|---|---|
| Typecheck | `pnpm exec turbo run typecheck --force` | PASS: 5/5 packages, uncached |
| Tests | `pnpm exec turbo run typecheck test --force` | FAIL: engine 492/494 pass; server 98/98 pass; web 32/32 pass; total 622/624 pass |
| Build | `pnpm exec turbo run build --filter=@devhub/engine --filter=@devhub/server --filter=@devhub/web --force` | PASS: 3/3 uncached; Vite transformed 2,228 modules |
| TUI smoke | `pnpm --filter @devhub/tui smoke` | PASS; legacy `Claude UI` title visible |
| Lint | `pnpm lint` | Exit 0 but 0 tasks executed; this is not a lint gate |
| Desktop package | `pnpm --filter @devhub/desktop build` | PARTIAL: release binary and `Claude UI.app` built; DMG AppleScript layout helper failed, command exit 1 |

The two test failures are deterministic clock drift, not random failures: `project-overview.test.ts` hard-codes `2026-06-10` and `2026-06-11`, while production intentionally filters `dailyCost` to the most recent 30 UTC days using `Date.now()`. The dates fell outside the window on 2026-07-12. This is recorded for post-gate repair with an injected clock or relative fixtures; it is not silently rewritten during baseline capture.

The packaged `.app` is at `apps/desktop/src-tauri/target/release/bundle/macos/Claude UI.app`. DMG creation stopped in Tauri's standard `bundle_dmg.sh` while `osascript` laid out the Finder window; no disk image remained mounted and no packaging process remained alive.

## Current product topology

- Frontend query-state tabs: `home`, `browse`, `chat`, `ops`, `inbox`, `dashboard`, `settings`, `openai-chat`, `codex-history`.
- Server registration surface: 89 HTTP routes, 2 SSE routes, and 2 WebSocket routes.
- Desktop: Tauri shell, tray, global `CmdOrCtrl+Shift+K`, completion notifications, and server auto-spawn.
- TUI: direct engine client with browse, transcript, chat, search, and dashboard modes.
- DevHub storage: `CLAUDE_UI_DATA` or `~/.claude-ui`, SQLite/WAL, compressed transcript archive, attachments, and browser localStorage keys prefixed `claude-ui`.
- Provider-native state is not yet authoritative in the current implementation; the preservation and migration rules are defined in `preservation-matrix.md`.

## Current official sources used

- OpenAI Codex app-server: <https://developers.openai.com/codex/app-server>
- Anthropic legal/authentication constraints: <https://code.claude.com/docs/en/legal-and-compliance>
- Anthropic Agent SDK: <https://code.claude.com/docs/en/agent-sdk>
- shadcn Vite installation: <https://ui.shadcn.com/docs/installation/vite>
- shadcn CLI v4 changes: <https://ui.shadcn.com/docs/changelog/2026-03-cli-v4>
- Tauri DMG packaging: <https://v2.tauri.app/distribute/dmg/>

## M0 review/result

M0 preservation and reproducibility capture is complete. The dirty state is recoverable and independently hashed. Typecheck/build pass uncached; the real test and package failures are recorded rather than hidden. No existing user change was overwritten or claimed.
