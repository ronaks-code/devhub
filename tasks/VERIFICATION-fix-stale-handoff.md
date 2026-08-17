# Verification — fix/stale-handoff

Run 2026-08-17 in an isolated worktree with its own `node_modules`
(`pnpm install --prefer-offline`; the main clone's install was left untouched).

| gate | result |
|---|---|
| `pnpm typecheck` | **5/5 successful** |
| `pnpm lint` | web **1 warning**, 0 errors (down from 13); engine/server/tui 0/0 |
| `pnpm test` | engine **2251**/83 files · server **301**/22 · web **759**/74 — **3,311 passing** |

The single remaining lint warning is `isHarnessInternalUserText` in
`apps/web/src/lib/m6-compose.ts`, left deliberately: it is dead code, but a
comment 58 lines below references it by name to explain the surrounding logic.
Deleting it orphans that explanation, so whether to wire it up or remove both is
a judgement call for a human, not a lint cleanup.

This supersedes the "NOT VERIFIED: tsc" note in commit 28257e6, which was
accurate when written — that worktree had no `node_modules` at the time.
