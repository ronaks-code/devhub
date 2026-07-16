# M8-PWA-BROWSER-SMOKE — fidelity ledger (2026-07-16)

Task: re-run the browser/PWA packaged smoke against the default-on shell (all 6
`codexStyleShell` slice flags plus the umbrella flag, `unifiedTaskIndex`, and
`workMode` are default-`true` in `packages/engine/src/providers/feature-flags.ts` —
verified by reading `DEFAULT_DEVHUB_FEATURE_FLAGS` directly before starting, no
flag defaults changed by this task). Isolated-scratch, real build, real server —
no real dataset, no real Codex/Claude runtime spawned.

## 1. Environment (isolated, torn down after capture)

- Scratch dir under `mktemp -d /tmp/devhub-m8-pwa-qa.*`: `HOME`, `CLAUDE_CONFIG_DIR`,
  `DEVHUB_DATA` all pointed inside it. One synthetic Claude session fixture
  (`/synthetic/demo-project`, session `session-m8-pwa`, ~460 bytes, labeled
  PROVISIONAL) gave Home/Browse/Search/Dashboard real content.
- Server: real `buildApp` via `tsx src/index.ts` (the actual production wiring),
  port 8793. `/api/health` confirmed strict identity:
  `{"ok":true,"ready":true,"sessionCount":1,"service":"devhub-server","version":"0.0.1"}`.
- Web: real `vite build` output (`apps/web/dist`, fresh build in this task) served
  by a throwaway static+proxy shim (`http.createServer`, no framework) on port
  5194, `/api/*` proxied to 8793. Shim script and scratch dir deleted after
  capture; both processes killed (`kill <server-pid> <shim-pid>`, verified
  `lsof -i :8793 -i :5194` empty).
- **Native-Codex safety note** (same hazard the prior M8-PRESERVATION-MATRIX task
  documented): first load resolved `nativeCodex: true` because a real Codex CLI
  is discoverable on this machine's `PATH`, independent of the isolated
  `CLAUDE_CONFIG_DIR`. Rolled back immediately via the flag's own documented
  non-destructive mechanism, `PUT /api/settings {"devHubFeatures":{"nativeCodex":
  false, ...}}`, before any further navigation. `persistentClaude` was already
  honestly `Requested` (not `Enabled` — no mutation token configured).
  `evidence/m8/qa-live-settings-pwa-browser-smoke.json` is the captured
  `GET /api/settings` after rollback. No task was created, sent, forked, or
  archived through any real provider during this walkthrough.

## 2. Suite gate at the exact wip tip, before capture

`turbo run test --filter @devhub/engine --filter @devhub/server --filter @devhub/web --force`:

| Package | Files | Tests |
|---|---|---|
| `@devhub/engine` | 82/82 | **2243/2243** |
| `@devhub/server` | 16/16 | **270/270** |
| `@devhub/web` | 44/44 | **586/586** |

`turbo run build --filter @devhub/engine --filter @devhub/server --filter @devhub/web`:
clean (`vite build` succeeded, `tsc` server build succeeded) — this is the exact
`apps/web/dist` served for the walkthrough below.

## 3. Click-through captured (`evidence/m8/qa-screenshots/pwa-*.png`), 0 unexpected console errors

| # | Screenshot | Surface | What it proves |
|---|---|---|---|
| `pwa-01-home.png` | Home, wide 1800x1130 | dark rail with the one task row, `New task`, secondary-nav row, `WorkModeSurface` bottom-right (`Code`/`Work` toggle, honest `0/0` outcome) | shell/task rail/home load clean on the default-on build |
| `pwa-02-browse.png` | Browse — project + session list, `InspectorDock` (Diff/Files/Terminal/Browser tabs, `Environment` summary) | matches the M8-PRESERVATION-MATRIX `02-browse.png` layout exactly (same panel widths, same session-row-not-auto-expanding behavior) | inspector dock + browse preserved |
| `pwa-02b-browse-session.png` | Browse, session selected via `@ref` click | URL round-trips to `&session=session-m8-pwa`; accessibility tree confirms `dh-thread-workspace`/`dh-composer-input`/`dh-inspector-tablist` are all mounted in the DOM even though the Browse route's own project/session columns stay visually in front (same as the governing capture) | session deep-link preserved; matches documented Browse-tab behavior, not a regression |
| `pwa-03-chat-composer.png` | Chat tab, clicked live (not URL-typed) via the real `Chat` rail button | `ThreadWorkspace` + `Composer` (`Describe the outcome or change...`, `Anthropic · Claude`, `Folder /synthetic/demo-project`, `Send` disabled) + `InspectorDock` all render; composer honestly reads `Reconnect to send. Your draft is saved.` because this scratch shim proxies HTTP only, not the WebSocket upgrade — expected given the setup, not a defect | thread workspace + composer surface load clean |
| `pwa-04-search-empty.png` | Search dialog (`Cmd+K`) | `Global`/`demo-project` scope, date facets, `↑↓ navigate / ↵ open / esc close` footer | Search dialog opens clean |
| `pwa-05-search-results.png` | Search, query `PWA` | `1 result`, highlighted match, `demo-project`/`Claude` tags | `/api/search` live round-trip |
| `pwa-06-command-palette.png` | Command palette (`Cmd+Shift+P`) | separate dialog from Search: `New task ⌘N`, `Search tasks ⌘K`, `Toggle inspector`, `Open Settings ⌘,` | Commands stays a distinct surface from Search, per the M6-T7 contract |
| `pwa-07-settings.png` | Settings route | 10-tab `SettingsRoute`, `Provider runtime status` table showing `Native Codex: Disabled` (post-rollback), `Persistent Claude: Requested`, `Unified task index: Enabled` | Settings preserved; table honestly reflects this run's safety rollback |
| `pwa-08-ops.png` | Live Ops (secondary nav) | destination reachable | preserved |
| `pwa-09-inbox.png` | Inbox (secondary nav) | destination reachable, empty triage state | preserved |
| `pwa-10-dashboard.png` | Dashboard (secondary nav) | usage/heatmap sections render | preserved |
| `pwa-11-narrow-home.png` | Home at 768x1024 | `document.documentElement.scrollWidth <= clientWidth` asserted `true` live in-page; collapsed rail, `WorkModeSurface` still reachable | narrow-viewport contract holds on the default-on build |

## 4. PWA manifest install check

- `document.querySelector('link[rel=manifest]').getAttribute('href')` → `/manifest.webmanifest`
  (present in `apps/web/index.html`, served by the built `dist/index.html`).
- Live in-page `fetch('/manifest.webmanifest')` → `{"name":"DevHub","short_name":
  "DevHub","display":"standalone","start_url":"/"}` — matches
  `apps/web/public/manifest.webmanifest` verbatim (`name`/`short_name` = `DevHub`,
  as required by this task's DoD).
- Not exercised: the actual OS-level "Install app" browser chrome affordance
  (headless Chromium has no installability UI to click) — the manifest content
  and link-tag wiring it depends on are both proven live instead, which is the
  part that can regress from a code change.

## 5. >=5 concrete comparison points vs the governing captures

Governing reference: `evidence/m8/preservation-matrix.md` +
`evidence/m8/qa-screenshots/0{1,2,4,5}-*.png` (the immediately-prior same-state
capture at these exact flag defaults, landed by M8-PRESERVATION-MATRIX on this
same branch).

1. **Home overview cards** — `CLAUDE — THIS MONTH: 1 sessions` / `TOTAL CLAUDE: 1`
   /`TOTAL CODEX: 0` in both `01-home.png` (governing) and `pwa-01-home.png` (this
   run): identical card labels, identical layout, only the session id differs
   (`a2bb5ed25c48` here vs. the governing run's own synthetic project id) because
   each run seeds its own isolated fixture.
2. **Browse panel geometry** — governing `02-browse.png` and this run's
   `pwa-02-browse.png` have byte-for-byte identical column widths (Projects
   ~200px, session list ~500px, Inspector ~415px) and identical `InspectorDock`
   tab set (`Diff`/`Files`/`Terminal`/`Browser`, `Environment` / `No active
   subagents`) — the Browse surface's layout did not drift between the two runs.
3. **Search dialog chrome** — governing `03-search-empty.png` and this run's
   `pwa-04-search-empty.png` show the identical scope pills (`Global`/
   `demo-project`), identical date facets (`Today`/`7d`/`30d`/`90d`/`Custom`), and
   identical footer copy (`↑↓ navigate / ↵ open / esc close`) — no visible-copy
   drift on the default-on build.
4. **Settings provider table** — governing `05-settings.png` and this run's
   `pwa-07-settings.png` both show the exact same 10-tab set and the same
   `Provider runtime status` table shape; the only difference is `Native Codex`
   reads `Disabled/Off` (governing) vs `Disabled` (this run, after this run's own
   rollback) — both runs independently hit and defused the exact same real-Codex-
   on-PATH hazard, confirming that hazard is a property of this machine, not a
   regression in either run.
5. **Narrow-viewport no-overflow contract** — governing `06-narrow-home.png` and
   this run's `pwa-11-narrow-home.png` both assert
   `document.documentElement.scrollWidth <= clientWidth === true` live in-page at
   768px, and both show the same collapsed-rail strip + reachable
   `WorkModeSurface` — the narrow contract holds identically across both runs.
6. **New surface this run adds over the governing capture**: the PWA manifest
   link-tag + live `fetch` check (§4) and the Command palette capture
   (`pwa-06-command-palette.png`) — the governing M8-PRESERVATION-MATRIX capture
   set did not include either, so this run is a strict superset, not just a
   re-run.

## 6. What this task did NOT do (by design)

- Did not flip any flag default — all were already `true` per
  `DEFAULT_DEVHUB_FEATURE_FLAGS`, verified by reading the source before starting.
- Did not exercise the real WebSocket-backed send path (the throwaway static+proxy
  shim proxies HTTP only) — `pwa-03-chat-composer.png`'s honest "Reconnect to
  send" state is the composer's own documented fail-closed behavior, not masked.
- Did not exercise `nativeCodex`/`persistentClaude` live runtimes — both held at
  `false`/`Requested` for this QA run's safety, per §1.
- Did not touch the first-party Computer-Use PWA-install-affordance gate (browser
  chrome "Install app" UI) — held, not exercised, per the standing hard-gate
  policy; the manifest content/wiring it depends on is proven live instead.
- Did not merge to `origin/main` — lands on `wip/devhub-background-runner` only.
