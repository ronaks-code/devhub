# ADR: Legacy-path retention — M8-LEGACY-PATH-DECISION

Date: 2026-07-16
Status: Decided and executed on `wip/devhub-background-runner`.

## Context

The preservation matrix is green and the M6 slice flags + `persistentClaude` +
`nativeCodex` are default-on. Before M8 closes out, three legacy/compat paths
named in the task need an explicit KEEP-as-rollback vs REMOVE decision instead
of sitting around by default:

1. `LegacyClaudeAdapter` (`packages/engine/src/providers/claude/legacy-adapter.ts`)
2. `CodexHistoryFallbackAdapter` (`packages/engine/src/providers/codex/history-fallback-adapter.ts`)
3. The `apps/web/src/components/ui.tsx` compatibility facade

## Investigation

For each path I traced every import (`grep` across `packages/` and `apps/`,
excluding `dist/` and the path's own test file) and traced how
`persistentClaude:false` / `nativeCodex:false` actually behave at runtime
today, to see whether the flag path really reaches the file in question.

### 1 & 2 — `LegacyClaudeAdapter` / `CodexHistoryFallbackAdapter`: REMOVE

Both classes implement the `ProviderAdapter` interface for the
provider-registry abstraction. Grepping the whole repo for the class names
(not just the import path) turns up **zero** non-test, non-barrel-export
consumers:

- `packages/engine/src/providers/index.ts` re-exports them (barrel only).
- Their own `*.test.ts` files construct them directly.
- Nothing in `packages/server/src/app.ts`, `native-claude-runtime.ts`, or
  `native-codex-runtime.ts` ever imports or constructs either class.

Tracing the actual `persistentClaude:false` / `nativeCodex:false` rollback
mechanism that IS live end-to-end today:

- **Server side**: `createNativeClaudeRuntime` / `createNativeCodexRuntime`
  unconditionally construct and `registry.register()` a `ClaudeNativeAdapter`
  / `CodexNativeAdapter` regardless of the flag. The flag is threaded in as an
  `isEnabled`/`adapterExposed` predicate that the *same* native adapter
  instance checks per-call to gate which capabilities it exposes (list/read
  vs. start/send/etc). There is no code path that swaps in a different
  adapter class when the flag is false — the native adapter *is* the fallback,
  by degrading its own capability surface.
- **Client side**: `resolveClaudeShellMode` / `resolveCodexShellMode` in
  `apps/web/src/App.tsx` switch which *pane component* mounts (`ChatPane`
  legacy view vs. the native pane), reading history through
  `packages/engine/src/codex.ts`'s `listCodexSessions` / the existing session
  history routes directly — not through the provider-registry
  `ProviderAdapter` interface at all.

So `LegacyClaudeAdapter`/`CodexHistoryFallbackAdapter` are leftover scaffolding
from the initial "provider-neutral registry" design (commit `d0d8d08`, "feat:
add native Codex and Claude provider runtimes") that was superseded by the
isEnabled-gated native-adapter pattern before any caller was wired up. No
stored-`false` flag reaches them — `persistentClaude:false` and
`nativeCodex:false` are both fully implemented without these two classes.

**Decision: REMOVE.** Deleted:
- `packages/engine/src/providers/claude/legacy-adapter.ts`
- `packages/engine/src/providers/codex/history-fallback-adapter.ts`
- `packages/engine/test/providers/legacy-claude-adapter.test.ts`
- `packages/engine/test/providers/codex-history-fallback-adapter.test.ts`
- the two corresponding `export * from` lines in
  `packages/engine/src/providers/index.ts`

Rollback if this turns out to be wrong: `git revert` this commit — the classes
were fully self-contained (no other file's behavior depends on their
presence), so reverting is a clean, mechanical undo. This is *not* the same
as removing the flags themselves; `persistentClaude` and `nativeCodex` keep
working exactly as they do today, unchanged by this deletion.

**Explicitly NOT touched** (do not confuse with the above): the unrelated
`LegacySessionProvenance` / `VerifiedLegacyMapping` /
`VerifiedLegacySessionResolution` types in
`packages/engine/src/provider-index/store-types.ts` and
`store-local-state.ts`. These back the actively-used provider-index
reconciliation store (session-mapping verification), share only the word
"Legacy" with the adapters above, and have real production callers.

### 3 — `apps/web/src/components/ui.tsx` facade: KEEP, no removal executed

The task brief assumed "App.tsx + index.css are the only importers," but that
is not the current state of the tree. `ui.tsx` exports `Spinner`, `Badge`,
`IconButton`, `EmptyState`, and a live grep shows **34 importers** across
`apps/web/src/components/**` (`ChatPane`, `SettingsPane`, `DashboardPane`,
`TranscriptPane`, every file under `components/config/` and
`components/dashboard/`, etc.), not just `App.tsx`. This matches
`design-lock.md` / `implementation-plan.md`, which both explicitly say: *"Keep
`apps/web/src/components/ui.tsx` as a compatibility facade until no imports
remain. Do not flag-day migrate controls."* The shadcn cutover to
`apps/web/src/components/ui/*` is real (that directory exists and is used
directly by newer surfaces), but the *migration of existing callers off the
facade* has not happened — this is a many-file, mechanical follow-up, not a
by-product of this task.

**Decision: KEEP-as-rollback**, exactly per the existing design docs — this
is not gated by a `stored-false` feature flag at all; it's an
in-progress-migration facade, and premature removal would break 34 files'
imports and is explicitly out of scope for M8. Re-activation path: N/A (never
deactivated) — retire only once a dedicated shadcn-migration task drives
every one of the 34 importers to `@/components/ui/*` directly, then delete
`ui.tsx` in that same change.

## Outcome

| Path | Decision | Executed |
|---|---|---|
| `LegacyClaudeAdapter` | REMOVE | Deleted, `providers/index.ts` export removed, test file deleted |
| `CodexHistoryFallbackAdapter` | REMOVE | Deleted, `providers/index.ts` export removed, test file deleted |
| `apps/web/src/components/ui.tsx` facade | KEEP-as-rollback | No change — 34 live importers, migration out of scope |

Gate: engine/server/web suites, `tsc --noEmit` (all three packages), and
`vite build` must stay green after the two deletions — see `tasks/STATUS.md`
for the exact counts recorded in the same commit as this ADR.
