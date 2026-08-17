# Decision aid — what to do with `rescue/e28cfa11-provider-cache`

Measured 2026-08-17. Written so the land / harvest / abandon call can be made on
evidence instead of vibes.

## What the branch actually is

| | |
|---|---|
| commits ahead of `main` | **33** |
| commits `main` is ahead | **241** |
| total change vs `main` | **29 files, 17,896 insertions, 162 deletions** |
| headline artifacts | `store-active-read.ts` (623 lines), `store-active-cache.test.ts` (1,023 lines of tests) |
| patch-equivalent to anything on `main`? | **No** — `git cherry` marks every commit `+` |

Every commit message carries its own test count (348, 176, 117, 154, 107, 114…),
so this was a disciplined campaign, not scratch work.

## Would it merge?

**No. 13 files conflict.**

```
packages/engine/src/index.ts
packages/engine/src/provider-index/identity.ts
packages/engine/src/provider-index/store-active-read.ts
packages/engine/src/provider-index/store-cache.ts
packages/engine/src/provider-index/store-codec.ts
packages/engine/src/provider-index/store-types.ts
packages/engine/src/provider-index/store.ts
packages/engine/src/providers/index.ts
packages/engine/test/provider-index/providers-public-surface.types.ts
packages/engine/test/provider-index/store-active-cache.test.ts
...13 total
```

Measured by a real trial merge into a detached worktree at `origin/main`, then
aborted. **Do not trust `git merge-tree <base> <a> <b>` for this** — the old
three-argument form reported zero conflicts here, which is wrong. Run the trial
merge.

## What that pattern means

The conflicts are **concentrated in `provider-index/`** — precisely the module the
feature rewrites. That is the expensive kind of conflict: it means `main` has
independently evolved the same files over those 241 commits, so resolution is
semantic reconciliation of two designs, not mechanical hunk-picking.

If the conflicts had been scattered across unrelated files, "land it" would be
easy. They are not.

## Recommendation: **harvest, don't land**

1. **Harvest (recommended).** Take `store-active-read.ts` and
   `store-active-cache.test.ts` — the two substantive artifacts, 1,646 lines
   between them — and port them onto current `main` deliberately, adapting to
   whatever the module looks like now. Leave the campaign scaffolding
   (`tasks/todo.md` +306 lines, `tasks/lessons.md` +139) behind.
2. **Land.** Only if the provider-index design on `main` is still substantially
   what the branch was written against. Check that first; if it has diverged,
   resolving 13 files across two designs will cost more than a rewrite.
3. **Abandon.** Legitimate, but then *delete the rescue branch on purpose* and say
   so here. Leaving it is how it becomes a second orphan.

## Do this before deciding anything

Read `store-active-read.ts` against the current `provider-index/store.ts` on
`main` and answer one question: **is the abstraction it assumes still the one
`main` uses?** Everything above follows from that answer, and it is a ten-minute
read.

## Provenance

These commits were unreachable — `git fsck` listed `e28cfa11` as dangling — because
`tasks/HANDOFF.md` named `campaign/auto-improve` and `wip/devhub` as live while both
had been deleted from origin. A `git gc` would have destroyed all 33.
