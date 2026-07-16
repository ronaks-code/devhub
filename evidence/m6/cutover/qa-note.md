# M6 codexStyleShell Umbrella Cutover — DevHub-own Browser QA note

Task: m6-codexstyleshell-cutover (flip `DEFAULT_DEVHUB_FEATURE_FLAGS.codexStyleShell` +
the 8 M6 slice flags `shellChrome`/`taskRail`/`taskHeaderSetup`/`threadWorkspace`/
`composerSurface`/`inspectorDock`/`searchCommands`/`settingsSecondary` false -> true as
REQUESTED defaults on `wip/devhub-background-runner`). Date: 2026-07-16. QA type:
DevHub's OWN first-party Browser QA (allowed, mirrors `evidence/m5/qa-note.md`). The
first-party `com.openai.codex` Computer-Use gate stays HELD and was not exercised.

## What changed (source)

- `packages/engine/src/providers/feature-flags.ts`: `DEFAULT_DEVHUB_FEATURE_FLAGS`
  flips `codexStyleShell` + all 8 M6 slice flags to `true` (requested default only —
  every M3/M4/M5 held gate's own default is untouched).
- `packages/server/src/app.ts`: `registerSettingsRoutes`'s `availableDevHubFeatures` /
  `appliedDevHubFeatures` now report all 9 M6 flags unconditionally available+applied
  (pure client-composition flags, no server runtime dependency — unlike
  `nativeCodex`/`persistentClaude`/`unifiedTaskIndex` which gate on a real runtime).
  This is what actually makes the flip land end-to-end: without it the generic
  `resolveSettings` AND-clamp in `packages/server/src/routes/settings.ts` would have
  kept every M6 flag resolved `false` regardless of the new default.
- No M6 slice's own `resolve*Mode` function changed — each still reads exactly its own
  flag off server-resolved `devHubFeatures` (unaffected refactor risk).

## What was served

- Built web bundle: `apps/web/dist` (`vite build`, fresh — see `tasks/STATUS.md` for the
  full-suite run this cutover shipped in the same commit as).
- Built server: `packages/server` via `tsx src/index.ts` (workspace runtime — plain
  `node dist` fails because `@devhub/engine` resolves to TS source, same sanctioned run
  path as M5).
- Static+proxy shim `/tmp/devhub-m6-qa-serve.mjs` on `http://127.0.0.1:5192`, serving
  `apps/web/dist` and proxying `/api/*` + `/events` to the server on
  `127.0.0.1:8793`. Kept OUT of the repo so the tree stays clean.

## Isolation (no real datasets touched)

- `CLAUDE_CONFIG_DIR` (and the DB it implies) pointed at an ISOLATED scratch dir under
  `mktemp -d /tmp/devhub-m6-qa.*`. The real `~/.claude/projects` was never used as a scan
  root. One tiny synthetic session fixture (`/synthetic/demo-project`, ~400 bytes,
  labeled PROVISIONAL: "ship the m6 cutover") gives the Browse view content.
- Server started with `nativeCodex`/`nativeClaude` runtime discovery left at their
  defaults (unaffected by this task); `persistentClaude` stays resolved `false` in this
  QA run because no mutation token was set — expected, that held gate is untouched.

## Result — LIVE, default-on, byte-compatible rollback confirmed

`GET /api/settings` on a fresh install with zero explicit overrides (`qa-live-settings-
default.json`):
- `devHubFeatures.codexStyleShell = true` AND all 8 slice flags `= true`.
- `requestedDevHubFeatures` matches (every M6 flag requested `true` by default).
- Held gates unaffected: `persistentClaude` resolves `false` (no mutation token in this
  QA env — expected); `crossProviderFork`/`workMode` stay `false` (not yet shipped).

Screenshots (`qa-screenshots/`), captured through the real built bundle with every M6
flag resolved `true`:
- `01-home-all-flags-on.png` — Home tab: the dark Codex-style `TaskRail` nav (`shellChrome`
  + `taskRail`) alongside the preserved legacy `TopBar`/light Home pane (Task 1 only swaps
  the OUTER chrome/rail container — Home's own pane content is untouched by any M6 slice).
- `02-browse-all-flags-on.png` — Browse tab: the dark `InspectorDock` (`Diff/Files/
  Terminal/Browser` destinations + `Environment` summary, `inspectorDock`) and the
  bottom `Composer` slot (`composerSurface`) both mounted.
- `03-settings-all-flags-on.png` — Settings tab: the canonical `SettingsRoute`
  (`settingsSecondary`) — `Appearance`/`Providers`/`Permissions` field groups, secondary
  nav (`Live ops`/`Inbox`/`Dashboard`) — replacing the legacy `SettingsPane`.
- `04-rollback-shellChrome-false.png` — after `PUT /api/settings` with an explicit
  `shellChrome: false` (every other M6 flag left `true`): the OUTER chrome instantly
  reverts to the exact legacy light `TopBar` + legacy light rail, while the INNER
  `SettingsRoute` content (still gated by its own `settingsSecondary: true`) keeps
  rendering unchanged — proving the rollback is isolated to the one flipped flag and
  does not disturb any other slice. `console --errors` was empty across every capture.

## No preserved surface disappeared

Every legacy pane (`ChatPane`, `SettingsPane`, `LiveOpsBoard`, `InboxPane`,
`DashboardPane`, the `w-44` legacy rail) is still reachable byte-for-byte the moment its
OWN flag is explicitly stored `false` — this is the exact per-slice contract each M6 Task
1-8 already shipped and tested; this cutover only changes which value is requested by
default, not the rollback mechanism itself. See the new automated proofs for the
generalized claim across all 8 slices simultaneously:
- `packages/engine/test/providers/feature-flags.test.ts` — defaults.
- `packages/server/test/m6-cutover.test.ts` — real `buildApp` wiring: default-on +
  9 explicit-false-isolates-one-flag cases (8 slices + the umbrella itself).
- `apps/web/src/App.m6-cutover.test.ts` — web composition: default-on mounts every
  slice's `devhub` mode, and an explicit `false` per flag isolates exactly that slice.

## Held / not exercised

- `com.openai.codex` first-party Computer-Use (QA [RONAK-GATE]) — held, not used.
- Production release promotion + `origin/main` merge — held human actions (this lands on
  `wip/devhub-background-runner` only, per task instructions).
