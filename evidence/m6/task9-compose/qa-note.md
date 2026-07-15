# M6-T9-COMPOSE — App.tsx composition + live data-wire note (non-cutover half)

Scope: this task wires the data-wires Tasks 1-8 deliberately deferred to Task 9 —
"live mounting into `App.tsx` ... is a DEFERRED data-wire staged for the Task 9
`codexStyleShell` cutover" (verbatim from every prior M6 task's STATUS entry). It does
**not** flip `codexStyleShell`'s requested default, does **not** remove `ui.tsx`, and
does **not** run the Task 9 cutover's induced-failure drills / final independent
review — those remain the separate, still-`[RONAK-GATE]`-held cutover task.

This is composition + real-data wiring, not new visual work: every mounted component
is the SAME, already-QA'd component from its own Task 1-8 slice. No `design-lock.md`
geometry/copy/primitive changed. New screenshots would show the identical pixels the
Task 1-8 `evidence/m6/<slice>/` fixtures already captured — this note instead proves
the *wiring* (real props, real state, real fetches) with code references + real test
counts, which is the part that changed.

## What got wired (per slice, all still default-OFF)

| Slice flag | Legacy owner (flag-off, unchanged) | New live data-wire (flag-on) | Where |
| --- | --- | --- | --- |
| `taskRail` | `App.tsx` rail / `ProjectsPane`/`SessionsPane`/`RecentMenu` | `TaskRail`'s `sections` now built from the active project's REAL sessions (most-recent-first, capped at 50, provider always the honest `anthropic` legacy encoding) via `buildTaskRailSections` | `App.tsx` (`taskRailModel`), `lib/m6-compose.ts` |
| `taskHeaderSetup` | `ProjectDetailHeader` (Browse) / `ChatPane` header (Chat) | Browse: `TaskHeader` replaces `ProjectDetailHeader` with the real session/project title + `onFork` wired to an honest "not available yet" toast. Chat: part of the `ChatHost` AND-gate (see below) | `App.tsx` Browse branch; `ChatHost.tsx` |
| `threadWorkspace` | `TranscriptPane` (Browse) / `ChatPane` transcript (Chat) | Browse: `ThreadWorkspace` replaces `TranscriptPane`, fed REAL `ThreadItem[]` mapped from `page.messages` via `mapMessagesToThreadItems` (plain text → `user`/`assistant`; every other block → a bounded `raw` diagnostic, never a fabricated tool card); `canSend=false` (Browse is genuinely read-only — an honest disabled composer, not a faked one). Chat: part of the `ChatHost` AND-gate | `App.tsx` Browse branch; `lib/m6-compose.ts`; `ChatHost.tsx` |
| `composerSurface` | `ChatPane` composer | Only live inside `ChatHost` (Chat tab) — see below. Added the missing `onDraftChange`/`onKeyDown`/`onSend` props to `Composer.tsx` itself (additive, optional; omitted keeps the exact presentation-only contract Task 5 shipped) | `Composer.tsx`; `ChatHost.tsx` |
| `inspectorDock` | `GitPanel`/`FileChangeSummary` (inline in `TranscriptPane`) | Browse + Chat: `InspectorDock` mounted with a real `Environment` summary (`api.gitStatus` branch + `buildFileChanges`-derived change count) and real Diff/Files content; Terminal/Browser/Artifacts have no backing runtime in either view, so they honestly render "Not available"/"No artifacts" — never a faked capability. Added the missing `onSelectDestination` prop to `InspectorDock.tsx` (additive; wired with the existing `nextTabIndex` roving-focus math) | `App.tsx` (both views); `ChatHost.tsx`; `lib/m6-compose.ts` |
| `searchCommands` | `SearchPalette`; `CommandPalette` stays unmounted | `TaskSearchDialog` replaces `SearchPalette`, backed by a REAL debounced `/api/search` fetch (same endpoint the legacy palette calls) mapped through `searchHitToResult`/`legacyDestinationForTarget`. `CommandDialog` is mounted for the first time ever (the legacy `CommandPalette` import was always dead code — confirmed by grep: imported, never rendered), wired to the 5 approved `DEFAULT_COMMANDS` rows with real handlers (`New task`→`startNewChat`, `Search tasks`→ closes Commands + opens Search, `Toggle inspector`→ a new `inspectorVisible` flag, `Open Settings`/`Go to Ops`→ real tab navigation). Added `onQueryChange`/`onScopeChange`/`onDateFacetChange`/`onRetry`/`onClose` to `TaskSearchDialog.tsx` and `onQueryChange`/`onClose` to `CommandDialog.tsx` (additive; omitted keeps every legacy snapshot test's exact `readOnly`/inert markup) | `App.tsx`; both dialog components; `lib/m6-compose.ts` |
| `settingsSecondary` | `SettingsPane`/`LiveOpsBoard`/`InboxPane`/`DashboardPane` as primary tabs | `SettingsRoute`/`OpsRoute`/`InboxRoute`/`DashboardRoute` now actually mount in the Settings/Ops/Inbox/Dashboard tabs (same props each already accepted; Task 8 built and unit-tested them but never wired the live mount, exactly as its own STATUS entry says) | `App.tsx` |
| `codexStyleShell` | — | Unchanged. Requested default stays **false**. Not touched by this task. | — |

## The Chat tab's "composer host" — an honest, conservative AND-gate

`taskHeaderSetup`, `threadWorkspace`, and `composerSurface` each own an independent
flag, but inside the legacy Chat tab they gate ONE inseparable region of the
user-owned `ChatPane.tsx` (header + transcript + composer are not independently
extractable without editing that file). `ChatHost.tsx` (new, not user-owned) is a
from-scratch adapter over the SAME real transport `ChatPane` uses (`openChat` from
`lib/ws.ts`) that mounts **only** when `resolveChatHostMode` sees all three resolve
`devhub` together (`App.m6-t9.test.ts`, 3 tests). An explicit stored `false` on ANY
ONE of the three still restores `ChatPane` untouched — the slice contract's own
instant-rollback promise, honored conservatively (AND, not OR) rather than violated.

`ChatHost` proves the honest core contract: a real prompt in (`{t:"prompt", cwd,
prompt, sessionId, model, permissionMode}` over the live socket), real
`NormalizedMessage`s out (mapped via the same `mapMessagesToThreadItems`), and the
honest Stop-gating `Composer`'s own `resolveSendState` already specifies (`Stop`
never appears for Claude — `persistentClaude` stays false). It intentionally does
**not** reimplement every `ChatPane` richness (permission-card interactive approval,
image attach, mention/slash picker dropdown rendering, token meter) — a message it
can't yet render richly (a tool call, an image, thinking, etc.) becomes a bounded
`raw` diagnostic, the exact honest fallback `ThreadWorkspace`'s own model reserves
for real data, never a fabricated tool card.

## Verification (real counts, this exact commit)

- Web: **478/478** tests, **33** files (+21 over the Task 8 tip: `lib/m6-compose.test.ts`
  18, `App.m6-t9.test.ts` 3; zero existing test edited/weakened).
- Server: **236/236** tests (11 files) — unchanged, no server files touched.
- Engine: **2204/2204** tests (79 files) — unchanged, no engine files touched.
- All 3 package typechecks (`engine`, `server`, `web`) PASS; `vite build` PASS.
- `git diff --check` clean; zero NUL/control bytes in every touched/new file
  (verified byte-by-byte, not just visually).
- Four user-owned paths (`.gitignore`, `AGENTS.md`, `ChatPane.tsx`, `SlashPalette.tsx`)
  byte-identical (`git diff --stat HEAD -- <path>` reports 0 lines for all four).

## Flag safety (unchanged shipping default)

Every flag touched here (`taskRail`, `taskHeaderSetup`, `threadWorkspace`,
`composerSurface`, `inspectorDock`, `searchCommands`, `settingsSecondary`) stays at
its Task 1-8 default (`false`). `codexStyleShell` stays `false`. `nativeCodex`/
`persistentClaude` stay `false`. With every flag at its shipping default, `App.tsx`
renders the exact legacy tree: `taskRailMode`/`taskHeaderSetupMode`/
`threadWorkspaceMode`/`inspectorDockMode`/`searchCommandsMode`/`settingsSecondaryMode`
all resolve `"legacy"`, `chatHostMode` resolves `"legacy"` (AND of three legacy
values), `devhubClaudePane` is `null` so `devhubClaudePane ?? legacyClaudePane`
renders the untouched `legacyClaudePane`, and the new `CommandDialog` never mounts
(matching the pre-existing behavior where `CommandPalette` was imported but never
rendered) — byte-for-byte the same render output as before this task.

## Scope (honest) — what's still deferred to the Task 9 cutover

This is the **non-cutover half** of Task 9. Still deferred, by design:
- Flipping `codexStyleShell`'s requested default to `true`.
- The full induced-failure drill suite (flag rollback, provider-failure isolation,
  disconnect-before-send reconciliation, long-transcript virtualization + focus
  retention, reduced-motion/forced-colors) at the exact cutover tip.
- Removing `apps/web/src/components/ui.tsx` (its `D` gate — zero imports — has not
  been run; `ui.tsx` still has real importers via `SettingsPane`/`SessionsPane`/etc.).
- A fresh independent specification + design/quality/security review of the exact
  cutover commit.
- `ChatHost`'s richer `ChatPane` parity (permission-card approval, image attach,
  mention/slash dropdown rendering, token meter) — a real, larger follow-up, not
  fabricated here.
- Ops/Inbox/Dashboard's TopBar/TaskRail primary-tab labels are unchanged (still
  "Live Ops"/"Inbox"/"Dashboard" primary destinations); only their tab CONTENT now
  routes through `SecondaryNav` when `settingsSecondary` is on. Restructuring the
  primary nav itself into secondary-only destinations is cutover-task scope.

Not promoted to `campaign/auto-improve`. The M6 milestone stays `[RONAK-GATE]`.
