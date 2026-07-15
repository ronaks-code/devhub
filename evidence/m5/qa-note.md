# M5 Finalize-Cutover — DevHub-own Browser QA note

Task: M5-FINALIZE-CUTOVER (integrate staged `unifiedTaskIndex` cutover onto `wip/devhub-background-runner`).
Date: 2026-07-15. QA type: DevHub's OWN first-party Browser QA (allowed). The first-party
`com.openai.codex` Computer-Use gate stays HELD and was not exercised.

## What was served
- Built web bundle: `apps/web/dist` (produced by `turbo run build ... --force`, vite build fresh).
- Built server: `packages/server` via `tsx src/index.ts` (workspace runtime; plain `node dist`
  fails because `@devhub/engine` resolves to TS source, so tsx is the sanctioned run path).
- Static+proxy shim `/tmp/qa-serve.mjs` on `http://127.0.0.1:5191` serving the built `dist` and
  proxying `/api/*` to the server on `127.0.0.1:8791`. Kept OUT of the repo so the tree stays clean.

## Isolation (no real datasets touched)
- All writable + scan roots pointed at an ISOLATED scratch dir (`$HOME`, `CLAUDE_CONFIG_DIR`,
  `DEVHUB_DATA` all under a `mktemp -d /tmp/devhub-m5-qa.*`).
- The real `~/.claude/projects` (9.2G) and `~/.codex` (8.2G) were NEVER used as scan roots after
  isolation. One tiny synthetic Claude session fixture (`/synthetic/demo-project`, 667 bytes,
  labeled PROVISIONAL) gives the browse view content. No real capture data, no dataset writes.
- First run (before isolation) pointed only `DEVHUB_DATA` at scratch but left the scan roots at
  the real corpus; the server OOM'd (JS heap) purely from decoding 9.2G+8.2G of real transcripts.
  That is a QA-env artifact of the real corpus size, NOT a cutover defect — the cutover surface
  (`/api/settings`) had already resolved `unifiedTaskIndex: true` before the crash, and every unit/
  integration suite is green. Re-run with fully isolated scan roots was stable.

## Result — CLEAN
End-to-end through the real built bundle, the cutover default-on is live:
- `GET /api/settings` (captured in `qa-live-settings.json`): `devHubFeatures.unifiedTaskIndex = true`
  AND `requestedDevHubFeatures.unifiedTaskIndex = true`; `nativeCodex = false`,
  `persistentClaude = false` (both held gates stay off). The resolved value is `true`, which the
  server only reports when the shared store exists AND the coordinator actually initialized.
- Views rendered with 0 console errors each (post-isolation): Home, Browse (synthetic session
  visible: "demo-project · 1 session · $0.0004"), Settings.
- Screenshots in `qa-screenshots/`: `01-home.png`, `02-browse.png`, `03-settings.png`.

### Only console noise (benign, pre-existing, unrelated to the cutover)
- 1 warning: `<meta name="apple-mobile-web-app-capable"> is deprecated` — a static `index.html`
  PWA meta tag; not introduced by this task.
- The 502 burst visible under console `all:true` history is entirely from the pre-isolation OOM
  window (stale real-corpus project ids); after the stable restart, each navigation logged 0 errors.

## Held / not exercised
- `com.openai.codex` first-party Computer-Use (QA [RONAK-GATE]) — held, not used.
- Production release default-on promotion + `origin/main` merge — held human actions.
