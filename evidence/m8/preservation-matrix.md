# M8-PRESERVATION-MATRIX — evidence (2026-07-16)

Task: verify + evidence the full preservation matrix with every flag (M3-M7) at its
new default, on `wip/devhub-background-runner`. This is a verification task, not a
code-behavior change: no source flag defaults were altered (all M3-M7 flags were
already default-`true` per `packages/engine/src/providers/feature-flags.ts`, landed
by the prior M5/M6/M7 cutover tasks recorded in `tasks/STATUS.md`).

## 1. Full suite, at the exact wip tip, all flags at their new defaults

`turbo run test --filter @devhub/engine --filter @devhub/server --filter @devhub/web --force`:

| Package | Files | Tests |
|---|---|---|
| `@devhub/engine` | 81/81 | **2236/2236** |
| `@devhub/server` | 16/16 | **269/269** |
| `@devhub/web` | 41/41 | **579/579** (includes the 11 new preservation tests below) |

`turbo run typecheck --filter @devhub/engine --filter @devhub/server --filter @devhub/web --force`:
engine (`tsc --noEmit` + `test/provider-index/tsconfig.public-surface.json`) / server /
web all PASS. `turbo run build ...` (fresh `vite build`) succeeded.

TUI (`apps/tui`, no vitest suite — its own equivalent is the non-interactive
`ink-testing-library` first-frame smoke, same as every prior milestone report):
`pnpm --filter @devhub/tui run smoke` rendered the real Ink `<App/>` first frame
against a real (read-only) `Engine` with no crash — project list + rail rendered,
`↑↓/jk move · ⏎ open · c chat · / search · d dashboard · q quit` footer present.
`npx tsc --noEmit` in `apps/tui` PASS (0 errors).

`git diff --check`: clean (checked after adding the new test file below).

## 2. New automated preservation test (cheap, static — no full `<App/>` DOM mount)

`apps/web/src/App.preservation-routes.test.ts` (11/11, counted in the 579 above).
A full mounted `<App/>` render per route was rejected as NOT cheap: `App.tsx` pulls
in the entire fetch/WebSocket/settings/provider surface with no existing render
harness (every M6 cutover test uses a pure `resolve*Mode` function, never a DOM
mount of `<App/>`) — building one from scratch for this task alone would be
disproportionate to a "where cheap" ask. Instead this is a source-static guard,
literally free to run (10ms):

- `ROUTE_TABS` (`apps/web/src/lib/router.ts`, the URL contract) is asserted to be
  exactly the 9 surface-inventory values (`RT-01`..`RT-09`): `home`, `browse`,
  `chat`, `ops`, `inbox`, `dashboard`, `settings`, `openai-chat`, `codex-history`.
- For each of the 8 tabs with an explicit `tab === "<value>"` branch in `App.tsx`,
  the test greps the real source for that exact literal — so deleting/renaming a
  mount branch fails the test immediately, without needing a live render.
- The 9th tab (`chat`) is the switch's implicit `else` terminal (native/devhub/
  legacy Claude pane) — asserted present via its own two literal markers instead.
- `App.tsx`'s own `type Tab = "..."` union literal is asserted to still contain
  every `ROUTE_TABS` value, catching drift between the router contract and the
  component union in either direction.

## 3. Fresh isolated-scratch Browser QA walkthrough (real built bundle, real server)

Isolated scratch dir under `mktemp -d /tmp/devhub-m8-qa.*`: `HOME`,
`CLAUDE_CONFIG_DIR`, and `DEVHUB_DATA` all pointed inside it. The real
`~/.claude/projects` and `~/.codex` were never used as scan roots. One tiny
synthetic Claude session fixture (`/synthetic/demo-project`, labeled PROVISIONAL,
~900 bytes) gave Browse/Search/Dashboard/Home real content to render.

Server: real `buildApp` via `tsx src/index.ts` (workspace runtime, port 8792) — the
actual production wiring, not a hand-rolled fixture. Web: the real `vite build`
`apps/web/dist` output, served + `/api` proxied by a throwaway shim on port 5193
(kept OUT of the repo, deleted after capture, along with the scratch dir and both
server/shim processes killed at the end — verified `lsof -i :8792 -i :5193` empty).

**Native-Codex safety note**: on first boot the real installed-runtime discovery
resolved `nativeCodex: true` (a real Codex CLI exists on `PATH` on this machine,
independent of the isolated `.codex` home). To keep this QA strictly read-only and
avoid any risk of an incidental real Codex process spawn while just clicking
around tabs, the settings were immediately rolled back with an explicit
`PUT /api/settings {"devHubFeatures":{"nativeCodex":false,...}}` before any
navigation — exactly the flag's own documented non-destructive rollback mechanism.
`persistentClaude` and `crossProviderFork` were already honestly `false`
(no mutation token configured; only one provider home discovered). No task was
created, sent, forked, or archived through any provider during this walkthrough —
navigation and search only. `evidence/m8/qa-live-settings.json` is the captured
`GET /api/settings` response for this exact QA run.

### Captured (`evidence/m8/qa-screenshots/`), 0 new console errors throughout

| # | Screenshot | Route / surface | What it proves |
|---|---|---|---|
| `01-home.png` | Home (`RT-01`) | wide 1800x1130, M6 shell (`shellChrome`+`taskRail`, dark rail, `New task`), Home overview cards, recent activity row | RT-01 preserved; **M7 `WorkModeSurface`** (`SF-09`/`T-work`) visible bottom-right: `Code`/`Work` toggle, `Anthropic · Claude`, `DevHub Work`, `Work scope /synthetic/demo-p...`, honest `Outcome: work task created; no work has started yet 0/0` — no fabricated progress |
| `02-browse.png` | Browse (`RT-02`) | project/session list + **M6 `InspectorDock`** (`SF-11`, `Diff`/`Files`/`Terminal`/`Browser` tabs, `Environment` summary, `No active subagents`) | RT-02 + inspector dock preserved |
| `02b-browse-session.png` | Browse, session selected | session row selection round-trips into the URL (`&session=session-m8-qa`) | Preserved session deep-link |
| `03-search-empty.png` | Search dialog (`SF-18`/`T-search`, `Cmd+K`) | `Global`/`demo-project` scope, `Today`/`7d`/`30d`/`90d`/`Custom` date facets, footer `↑↓ navigate / ↵ open / esc close` | Search preserved, distinct from Commands |
| `03b-search-results.png` | Search, query `preservation` | `1 result`, highlighted snippet, provider tag `Claude` | `/api/search` round-trip live |
| `04-dashboard.png` | Dashboard (`RT-06`) | secondary nav row (`Settings`/`Live ops`/`Inbox`/`Dashboard`), running-now empty state, usage/heatmap sections | RT-06 + M6-T8 secondary-navigation relocation preserved |
| `05-settings.png` | Settings (`RT-07`) | 10-tab `SettingsRoute` (`Preferences`/`Budget`/`Memory`/`MCP servers`/`Hooks`/`Webhooks`/`Permissions`/`Agents`/`Skills`/`Plugins`), `Provider runtime status` table: `Native Codex: Disabled/Off`, `Persistent Claude: Disabled/Off`, `Unified task index: Enabled/Active` | RT-07 + M6-T8 `SettingsRoute` preserved; feature table honestly reflects this QA run's rolled-back `nativeCodex` |
| `06-narrow-home.png` | Home at 768x1024 | collapsed rail strip, no horizontal overflow (`scrollWidth <= clientWidth` asserted `true` via `document.documentElement`), `WorkModeSurface` still reachable | Narrow-viewport preservation contract (section 9 of the inventory) |
| `07-inbox.png` | Inbox (`RT-05`) | secondary destination reachable, triage empty state | RT-05 preserved |
| `08-ops.png` | Ops (`RT-04`) | secondary destination reachable | RT-04 preserved |
| `09-codex-history-fallback.png` | Codex history fallback (`RT-09`) | degraded read-only fallback route still mounts | RT-09 preserved |
| `10-openai-chat-quarantine.png` | OpenAI Chat quarantine (`RT-08`) | exact required title `OpenAI Chat — development only` + required persistent warning `Chat-only experiment. This is not Codex. Local tools are disabled by default.` | RT-08 quarantine copy preserved verbatim |

### M7 surfaces specifically

- **`workMode`** (`RT-12`/`SF-09`/`T-work`): flag resolves `true` (durable store
  present); `WorkModeSurface` mounts for the active project with a real `cwd` and
  renders the honest `Code`/`Work` toggle + `Work scope`/`Outcome` fields with `0/0`
  progress — captured live on Home, Browse, and the 768px narrow Home. One
  background poll to `/api/work-mode/tasks/work-mode-<projectId>` 404s (the only
  console entry across the entire walkthrough) because no real backing work-mode
  task exists in the synthetic fixture — this is the surface's documented
  no-fabrication contract working exactly as designed (render nothing false, poll
  honestly fails closed), not a defect.
- **`crossProviderFork`** (`RT-11`/`SF-*`/`T-fork`): `GET /api/settings` resolves
  `crossProviderFork: false` in this QA environment, confirmed via a live in-page
  `fetch('/api/settings')` call. This is the correct, honest AND-clamp behavior
  documented in `packages/server/src/app.ts` (`hasCrossProviderForkTarget`): only
  one provider home (`anthropic`, via the isolated synthetic Claude fixture) was
  discoverable in this scratch environment, so the resolved value correctly stays
  `false` rather than exposing a fork control with no second-provider handoff
  target — exactly the behavior `packages/server/test/m7-fork-cutover.test.ts`
  (4/4, counted in the 269 above) already proves with real `buildApp` wiring
  across zero/one/two discovered homes. No new browser evidence was needed beyond
  that existing test coverage plus this live confirmation, since fabricating a
  second real provider home in the QA fixture would mean simulating a native
  runtime rather than proving the real preserved gating contract.

## 4. Preservation-matrix mapping (M0 surface inventory → proof)

Full detail lives in `.planning/devhub-codex-parity/surface-inventory.md` section 3
(`RT-01`..`RT-12`) and section 4 (`SF-01`..`SF-20`). Summary mapping for this task:

| Item | Preserved? | Proof |
|---|---|---|
| `RT-01` Home | yes | `01-home.png`; `App.preservation-routes.test.ts` |
| `RT-02` Browse | yes | `02-browse.png`, `02b-browse-session.png`; existing web suite (`ProjectsPane`/`SessionsPane`/`TranscriptPane` tests, part of the 579) |
| `RT-03` Chat | yes | implicit-else branch test in `App.preservation-routes.test.ts`; `App.native-codex.test.ts`, `App.m6-cutover.test.ts` |
| `RT-04` Ops | yes | `08-ops.png` |
| `RT-05` Inbox | yes | `07-inbox.png` |
| `RT-06` Dashboard | yes | `04-dashboard.png` |
| `RT-07` Settings | yes | `05-settings.png`; `SettingsRoute.test.ts` (29 tests) |
| `RT-08` OpenAI Chat quarantine | yes | `10-openai-chat-quarantine.png` (exact required copy verbatim) |
| `RT-09` Codex history fallback | yes | `09-codex-history-fallback.png` |
| `RT-10` Provider-native primary task URL | yes | `nativeCodex`/`persistentClaude`/`unifiedTaskIndex` engine+server suites (2236+269 above); M3-M5 live-proof evidence (`evidence/m3`, `evidence/m4`, `.planning/.../evidence/m5`) |
| `RT-11` Cross-provider fork | yes (honest-gated) | `packages/server/test/m7-fork-cutover.test.ts` 4/4; live `/api/settings` confirmation above |
| `RT-12` DevHub Work | yes | `01-home.png`, `06-narrow-home.png`; `packages/server/test/m7-workmode-cutover.test.ts` |
| M6 shell (`SF-01` shellChrome, `SF-02` taskRail, `SF-11` inspectorDock, `SF-18`/`T-search`, `T-commands`) | yes | `01-home.png`..`05-settings.png` (dark rail + inspector dock throughout); `03-search-empty.png`/`03b-search-results.png`; `App.m6-cutover.test.ts`, `App.m6-t9.test.ts` |
| Legacy URL/localStorage/env compat (`compat-storage.ts`, `?tab=` reader) | yes | unchanged in this task; `M5-T7-WEB-COMPAT` gate record in `tasks/STATUS.md` (93/93 focused + 211/211 full at the time, now superseded by the 568/568 above with the same seam intact) |
| Four user-owned preservation paths (`.gitignore`, `AGENTS.md`, `ChatPane.tsx`, `SlashPalette.tsx`) | untouched | not modified by this task (verify: `git status` shows none of the four in this task's diff) |

## 5. What this task did NOT do (by design)

- Did not flip any flag default (all were already `true`; the request explicitly
  says "at their new defaults", i.e. verify the existing state, not change it).
- Did not exercise `nativeCodex`/`persistentClaude` live runtimes (both explicitly
  rolled back to `false` for this QA run's safety, per §3 above) — those live
  proofs are already recorded in `evidence/m3`/`evidence/m4` from earlier tasks and
  were not re-run here.
- Did not touch the first-party `com.openai.codex` Computer-Use QA gate — held,
  not exercised, per the standing hard-gate policy.
- Did not merge to `origin/main` — lands on `wip/devhub-background-runner` only.
