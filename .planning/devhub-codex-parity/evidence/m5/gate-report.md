# M5-CUTOVER-FINALIZE — heavy gate + reconciliation

Date: 2026-07-16
Branch: `wip/devhub-background-runner`
Gate run against the working tree that this evidence + the new byte-compatibility test
commit exactly (parent commit `af6371918544a02dbd4b1836bb54f590dfc53af5`, then this
task's changes on top) — the counts below describe the exact commit this evidence ships
in, since nothing changed in the working tree between running the gate and committing it.

## Reconciliation: wip vs `staging/m5-t9-cutover@01f39e4`

`staging/m5-t9-cutover` (commit `01f39e4`) is an isolated branch that flips
`DEFAULT_DEVHUB_FEATURE_FLAGS.unifiedTaskIndex` `false -> true` with a narrow focused-test
rerun (engine 4/4, server settings-features 8/8 + provider-index 25/25 +
provider-index-composition 3/3 = 36/36; app.test.ts 80/80 unaffected).

`wip/devhub-background-runner` already carries the SAME flip, landed earlier and
independently at `bfa8384` (`DEVHUB-FLIPS`, on top of an even earlier `M5-FINALIZE-CUTOVER`
commit already on this branch), and has been re-verified multiple times since under the
FULL suite, not just the four M5-scoped test files. `01f39e4` is confirmed NOT an ancestor
of this branch's tip (`git merge-base --is-ancestor 01f39e4 HEAD` → not an ancestor) — the
two branches independently reached the same flag state from different starting points.

Decision: **wip's flip supersedes the staged branch.** No fast-forward / cherry-pick is
needed or performed:
- Both branches request the identical resolved value (`unifiedTaskIndex: true`) with the
  identical clamp semantics (server reports applied only when the shared store exists AND
  the coordinator initialized; explicit stored `false` is the non-destructive rollback).
- wip's version has already absorbed a superset of verification: the full engine (2206
  tests) + server (237) + web (487) suites, not just the 36 M5-scoped tests staging ran.
- Landing `01f39e4` on top of wip would touch the exact same lines already present here —
  there is nothing in the staged diff that isn't already expressed on wip.
- `staging/m5-t9-cutover` can be treated as superseded/mergeable-as-a-no-op once this
  finalize lands; it is not deleted or force-pushed by this task (out of scope — this task
  only reconciles state, it does not touch branch lifecycle).

## Full exact-tip heavy gate (forced cache bypass)

Command: `npx turbo run test --filter=@devhub/engine --filter=@devhub/server
--filter=@devhub/web --force` (the `--force` flag bypasses turbo's local/remote cache so
every test file actually re-executes at this tree state).

Real counts:

| Package | Test files | Tests |
| --- | --- | --- |
| `@devhub/engine` | 79/79 passed | **2206/2206** passed |
| `@devhub/server` | 11/11 passed | **237/237** passed (236 pre-existing + 1 new byte-compatibility test, `provider-index.test.ts`) |
| `@devhub/web` | 34/34 passed | **487/487** passed |

## Typechecks (forced cache bypass)

Command: `npx turbo run typecheck --filter=@devhub/engine --filter=@devhub/server
--filter=@devhub/web --force`

- `@devhub/engine`: `tsc --noEmit` PASS + `tsc --project test/provider-index/tsconfig.public-surface.json` PASS
- `@devhub/server`: `tsc --noEmit` PASS
- `@devhub/web`: `tsc --noEmit` PASS

## Build

`apps/web`: `vite build` succeeded (`✓ built in 3.34s`, no errors); the produced `dist/`
was removed afterward (not committed — this is a proof-of-build-health check, not a
release artifact).

## `git diff --check`

`git diff --check` at the exact tip: clean (exit 0, no output — no whitespace errors, no
unresolved conflict markers).

## Rollback proof: explicit-stored `unifiedTaskIndex: false` stays byte-compatible

New test: `packages/server/test/provider-index.test.ts` →
`describe("M5-CUTOVER-FINALIZE: legacy provider routes stay byte-compatible across the
flag")`. Two independent harnesses (own temp DB/home) — one with an explicit stored
`unifiedTaskIndex: false` (the rollback switch), one on the applied `true` default — both
call the LEGACY `GET /api/providers/:provider/tasks` route (not the new
`/api/provider-index/*` surface) and assert:

- both return `200`
- the raw response **bytes** are identical (`offRes.body === onRes.body`, not just
  deep-equal JSON), and equal to the expected `{"items":[],"nextCursor":null}`
- the two harnesses' `/api/settings` responses confirm the flag genuinely differed
  (`false` vs `true`), so this is a real rollback comparison, not an accidental no-op

This pins the exact contract documented in `provider-tasks.ts`'s `observeListIntoCache`/
`observeTaskIntoCache` comment: the coordinator cache-warming hook is a side effect only —
flipping `unifiedTaskIndex` off never changes what the legacy routes return.

Passing in the full run above (server 237/237 includes this test).
