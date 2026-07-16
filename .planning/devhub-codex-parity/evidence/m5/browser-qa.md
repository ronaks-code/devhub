# M5 Browser QA — indexed-transport UI, flag applied-on

Date: 2026-07-16

Scope: DevHub's own Browser QA (gstack `browse`, Playwright-driven headless Chromium) of
the `unifiedTaskIndex`-applied-true surface — the Settings "Provider runtime status" panel
and a direct in-page exercise of the real `/api/provider-index/*` transport. This is
DevHub's own QA; the first-party `com.openai.codex` Computer-Use QA is out of scope for
this task (hard gate) and is not attempted here.

## Fixture

`.planning/devhub-codex-parity/qa/m5-fixture-server.ts` — a minimal hand-rolled Fastify
app (same pattern as the M3/M4 fixtures), NOT the full `buildApp` from
`packages/server/src/app.ts`. `buildApp` wires transcript/config filesystem watchers meant
for a real `~/.claude` home; pointed at this fixture's synthetic temp home they retry-loop
and run the process out of memory (observed firsthand: two OOM crashes before switching to
this pattern). The fixture instead registers the real, unmodified
`registerProviderTaskRoutes` and `registerProviderIndexRoutes` route functions directly
against a real `ProviderTaskIndexStore` (via a real temp-file `Engine`) and a real,
initialized `ProviderTaskIndexCoordinator` — so `unifiedTaskIndex` is genuinely applied
true end to end, not hand-mocked. `settingsSecondary` is also set true purely so the
Settings surface renders `SettingsRoute` (which has the "Provider runtime status" table)
instead of the legacy `SettingsPane`; this is unrelated to and does not gate the M5
cutover. `nativeCodex`/`persistentClaude` stay false — no provider process is spawned, and
no live-runtime hard gate is crossed. Auth token: `m5-fixture-token` (synthetic, matches
the M3/M4 convention of a literal fixture token, never a real credential).

Vite dev served the real `apps/web` unmodified on `:5173`, proxying `/api` to the fixture
on `:8787` (`apps/web/vite.config.ts`, unchanged).

## Comparison points (measured geometry + functional)

| # | Check | Wide (1280×720) | Narrow (768×900) |
| --- | --- | --- | --- |
| 1 | `document.body.scrollWidth` / `documentElement.scrollWidth` — no horizontal overflow | `1280` / `1280` (== `innerWidth`) | `768` / `768` (== `innerWidth`) |
| 2 | "Provider runtime status" table (`[data-dh-settings-table]`) bounding-box height | `124px` | `124px` (stable across breakpoints — same 3 rows, same row height) |
| 3 | Same table bounding-box width | `720px` (scales with the wider content column) | `592px` (scales with the narrower content column) |
| 4 | "Unified task index" row cell text | `Enabled` / `Active` | `Enabled` / `Active` (identical at both breakpoints) |
| 5 | "Native Codex" / "Persistent Claude" rows (control: features still correctly off) | `Disabled` / `Off` for both | `Disabled` / `Off` for both |
| 6 | Real indexed-transport network round trip, executed from the loaded page's own JS context (not curl) | `GET /api/provider-index/homes` → `200`, `GET /api/provider-index/tasks` → `200`, 3 tasks returned with opaque locators | (same fixture; not re-driven narrow — transport is viewport-independent) |
| 7 | Console errors on load | Only unrelated 401/404 noise from endpoints this minimal fixture doesn't implement (`/api/events`, `/api/export/archive`) — nothing from `/api/provider-index/*` or `/api/providers/*` | same |

Screenshots: `browser-wide-settings-provider-table.png` (1280×720),
`browser-narrow-settings-provider-table.png` (768×900). Both show the full Settings page
with the "Provider runtime status" table in view, "Unified task index: Enabled / Active".

## Real indexed-transport round trip (network-level proof)

Ran directly in the loaded DevHub page's JS context (same origin, same stored auth token
the app itself uses — not a separate curl session):

```js
Promise.all([
  fetch('/api/provider-index/homes', { headers: { authorization: 'Bearer ' + localStorage.getItem('devhub-token') } }).then(r => r.json()),
  fetch('/api/provider-index/tasks', { headers: { authorization: 'Bearer ' + localStorage.getItem('devhub-token') } }).then(r => r.json()),
]).then(([homes, tasks]) => JSON.stringify({
  homesCount: homes.length,
  taskCount: tasks.items.length,
  firstTaskLocator: tasks.items[0] && tasks.items[0].locator,
  firstTaskTitle: tasks.items[0] && tasks.items[0].title,
}))
```

Result:

```json
{"homesCount":1,"taskCount":3,"firstTaskLocator":{"version":1,"provider":"openai","homeFingerprint":"f66ee66654175058d60f74ff316571ab56a52259e2d7f08681ea132603deb16c","nativeTaskId":"m5-active"},"firstTaskTitle":"Indexed transport verification"}
```

The browser's own network log confirms both calls actually crossed the wire:

```
GET http://localhost:5173/api/provider-index/homes → 200 (6ms, 500B)
GET http://localhost:5173/api/provider-index/tasks → 200 (10ms, 1890B)
```

Only an opaque locator (`provider` + `homeFingerprint` + `nativeTaskId`) crosses to the
browser — no raw filesystem home, matching the M5 locator-only public-surface contract
pinned in `packages/server/test/provider-index.test.ts`.

## What this does NOT claim

- This is not the M4 "exact-copy" pixel-parity pass (that's `codexStyleShell`/M6 scope);
  it's a functional + geometry-stability check that the indexed transport is live and the
  Settings surface truthfully reports it, at two breakpoints, with no overflow regression.
- The first-party `com.openai.codex` Computer-Use QA is a hard gate and is not attempted
  here — this is DevHub's own Browser QA only, as scoped.
- `nativeCodex`/`persistentClaude` stay false in this fixture; no native provider process
  was spawned or exercised. The indexed transport itself is provider-agnostic (it fronts
  whatever `ProviderRegistry` adapters are registered), so this is a faithful exercise of
  the M5 code path without crossing the M3/M4 live-runtime hard gates.

## Judgment

The indexed-transport UI surface renders correctly and truthfully at both breakpoints
with `unifiedTaskIndex` applied true, with no horizontal-overflow regression, and the
real `/api/provider-index/*` routes serve real data end to end from the browser's own
fetch calls using the app's own stored auth token. Fixture and processes were shut down
cleanly after capture (no lingering servers).
