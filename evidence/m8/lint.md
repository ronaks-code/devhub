# M8-LINT-TASK evidence

## Before
`pnpm lint` (== `turbo run lint`) executed **0 tasks** — `turbo.json` declared a
`"lint": {}` task but not a single workspace package defined a `lint` script, so
turbo had nothing to run. `WARNING No tasks were executed as part of this run.`
is not evidence of a clean codebase; it's evidence the check never ran.

## Fix
- Added `oxlint@1.74.0` as a root devDependency (single Rust binary, zero eslint
  plugin sprawl — fits the "keep it lightweight" bar).
- Added `.oxlintrc.json` at the repo root (auto-discovered by oxlint from any
  workspace subdirectory — verified). It runs oxlint's real default rule set
  (eslint-compat correctness rules + the `unicorn` and `oxc` plugins, on by
  default) and baselines exactly 3 rules with an inline rationale:
  - `no-control-regex`: off — DevHub's Claude/Codex provider adapters parse real
    terminal/ANSI byte streams; matching control characters in a regex is the
    actual job there (~20 hits, all in that code), not a mistake.
  - `unicorn/no-useless-spread`, `unicorn/no-new-array`: off — style-only
    micro-perf nits with zero behavior difference (confirmed correct as written).
    `oxlint --fix` already auto-rewrote the handful of instances it judged
    unambiguous in this same commit, proving the rule works; the rest are
    baselined rather than touching ~20 more call sites for a lint-infra task.
- Added a real `"lint": "oxlint src"` script to `@devhub/engine`,
  `@devhub/server`, `@devhub/web`, and `@devhub/tui` (the 4 packages this task's
  DoD names). `@devhub/desktop` is a Tauri/Rust shell with no `src/**/*.ts` of
  its own to lint — turbo now simply has no `lint` task to run for it, same as
  it already has no `test` task for it.
- Fixed every REAL issue oxlint surfaced (no silent baselining of correctness
  findings):
  - 4 unnecessary `[...iterable]` spreads before `Promise.all`/`Promise.allSettled`
    (auto-fixed by `oxlint --fix`, reviewed).
  - ~25 genuinely dead imports/variables/functions removed (unused imports,
    an unused catch binding, a dead `parseYmd` helper, two dead validation
    constants in `provider-index.ts`, a dead `count()` test helper, an unused
    sort-comparator parameter renamed to `_b`).
  - The single largest one: `apps/web/src/App.tsx` had a ~185-line `useMemo`
    building the OLD `CommandPalette`'s action list — fully superseded by
    `DEFAULT_COMMANDS`/`CommandDialog` (the file already had a comment noting
    `CommandPalette` "stays unmounted... even before M6"). Deleted the whole
    dead block plus the 4 callbacks (`runReindex`, `checkIndexHealth`,
    `downloadArchive`, `effectiveModel`) and ~13 icon/type imports that existed
    only to feed it — verified each one has NO other call site (the equivalent
    real features — reindex, index health, archive export — have their own
    live UI in Settings' `RebuildIndex`/`IntegrityPanel`/`ArchiveTransfer`
    panels, so nothing user-facing was lost).
  - One intentionally-constant test expression (`false && "b"` proving `cn()`
    drops falsy classes) got a single-line `// oxlint-disable-next-line
    no-constant-binary-expression` with an inline reason — a real false
    positive, not a real bug.
  - `packages/engine/src/config/index.ts`'s `listMdRecursive` had a `base`
    parameter only ever threaded through recursive calls and never read —
    removed it (real dead-parameter cleanup, `oxc/only-used-in-recursion`).

## After
```
$ pnpm lint
...
@devhub/engine:lint: Found 0 warnings and 0 errors.
@devhub/engine:lint: Finished in 75ms on 129 files with 92 rules using 15 threads.
@devhub/server:lint: Found 0 warnings and 0 errors.
@devhub/server:lint: Finished in 74ms on 50 files with 92 rules using 15 threads.
@devhub/tui:lint: Found 0 warnings and 0 errors.
@devhub/tui:lint: Finished in 68ms on 7 files with 92 rules using 15 threads.
@devhub/web:lint: Found 0 warnings and 0 errors.
@devhub/web:lint: Finished in 44ms on 208 files with 92 rules using 15 threads.

 Tasks:    4 successful, 4 total
```
`turbo run lint` now actually runs 92 real rules across 394 files (129 + 50 + 7
+ 208) and exits 0 for a real reason, not because nothing ran.

## Full gate (same commit)
- `pnpm typecheck` (turbo, all 5 packages incl. desktop's Rust-adjacent
  `@devhub/desktop` which has no typecheck script either — turbo just has
  nothing to run for it): 5/5 successful, 0 errors.
- `packages/engine` — `vitest run`: 81 files / 2236 tests passed. (One flaky
  timing test — `writer-lease.test.ts`'s deterministic-expiry case — timed out
  once under full-suite parallel load; reproduced green in isolation and in a
  clean full-suite rerun; untouched by this task's diff — not a regression.)
- `packages/server` — `vitest run`: 16 files / 269 tests passed.
- `apps/web` — `vitest run`: 44 files / 586 tests passed.
- `apps/tui` — no test script (pre-existing; unrelated to this task).
