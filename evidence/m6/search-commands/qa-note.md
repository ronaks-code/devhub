# M6 Task 7 — Search + Commands QA note (`searchCommands` flag, default OFF)

DevHub-own Browser QA of the extracted `TaskSearchDialog` + `CommandDialog`. Measured
against a self-contained `fixture.html` built from the SHIPPED `index.css`
token/`.dh-*` blocks plus the REAL `TaskSearchDialog`/`CommandDialog` SSR markup
(rendered by the components via `renderToStaticMarkup`, not hand-authored). Served on
`http://localhost:5309`, viewport 1200x2600. Same fixture-measurement method used for
M6 Tasks 1–6.

## Fixtures / screenshots
- `fixture.html` — 8 labeled sections: Search populated (Codex + Claude + a degraded
  raw-OpenAI `Read-only fallback` row), Search project-scope + `7d` date facet (idle,
  no query), Search loading (Skeleton placeholder rows), Search empty (`No results`),
  Search error (distinct Alert, retains query), Commands default (5 approved rows,
  active row `Search tasks`), Commands filtered (`ops`), Commands empty (`No commands`).
- `m6-search-commands-wide.png` — full-page capture at 1200 wide.

## Live `getBoundingClientRect` / `getComputedStyle` measurements
| # | Property | Measured | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Both dialogs share ONE `#2d2d2d` surface + 12px radius | `rgb(45,45,45)` / `12px` | design-system §7.9 shared Dialog composition | Match |
| 2 | Search + Commands are SEPARATE dialog surfaces | 5 `data-dh-search-dialog` + 3 `data-dh-command-dialog`, `0` overlap | Search ≠ Commands (design-lock §8) | Match |
| 3 | Result/action row min-height 36px | `36px` on `data-dh-search-result` | design-system §7.9 row height | Match |
| 4 | Loading renders Skeleton rows, not a bare spinner | `3` `data-dh-search-skeleton-row`, `aria-hidden="true"` | content-shaped Skeleton placeholder | Match |
| 5 | Error is a real accessible Alert | `role="alert"` on `data-dh-search-error` | distinct Alert, not `role="status"` only | Match |
| 6 | Error text uses the danger token | `rgb(217,92,92)` = `#d95c5c` | `--dh-danger` | Match |
| 7 | Keyboard-active row uses the shared selected token | `rgb(49,49,49)` = `#313131` on active Command row | `--dh-selected` | Match |
| 8 | FTS highlight is a semantic `<mark>`, brand-tinted | `color-mix(... var(--dh-brand) 25% ...)` on `.dh-search-mark` | highlight via token, not inline color only | Match |
| 9 | Degraded raw OpenAI session never labeled `Codex` | row text contains `OpenAI` + `Read-only fallback`, no `Codex` | design-lock §3 (raw OpenAI ≠ Codex identity) | Match |
| 10 | No provider logos anywhere | `0` `<svg>`, `0` `<img>` across all 8 sections | design-lock §3 / invariant 9 (quiet text identity) | Match |

10 concrete comparison points, all Match.

## Flag safety
`searchCommands` requested-default stays **false**. Flag-off keeps the legacy
`SearchPalette` mounted exactly as today and keeps the legacy `CommandPalette`
UNMOUNTED exactly as today (`App.tsx` still only renders `SearchPalette`);
`resolveSearchCommandsMode` returns `legacy` for false/undefined/missing settings and
`isSearchCommandsApplied` is true only for an explicit `true` (both asserted in
`TaskSearchDialog.test.ts` / `CommandDialog.test.ts`). `nativeCodex` / `persistentClaude`
/ `searchCommands` requested-defaults stay false.

## Scope (honest)
This unit delivers the Search-dialog PRESENTATION (query, global/project scope, date
facets, highlighted/provider-locked result rows, distinct error Alert, Skeleton loading,
count/status, footer) and the SEPARATE Commands-dialog PRESENTATION (approved 5-row
registry, fuzzy filter, provider-scoped-command gating, the `Search tasks` → close
Commands → open Search handoff, Escape-restores-focus contract) plus the flag gate.
Live mounting into `App.tsx`'s overlay tree (real `onOpen`/`onRun` handlers wired to
app state, real debounced search fetch, real keyboard-shortcut dispatch) is a later
data-wire, mirroring how M6 Tasks 3–6 left their live mount as a deferred data-wire
staged for the Task 9 `codexStyleShell` cutover — none of Tasks 1–6 wired their surface
into the live `App.tsx` render tree either (only the outermost `shellChrome`/`taskRail`
cutover points are live-switched today).

Tooling note: `design-lock.md` §7 names the shadcn/Radix toolchain for this build, but no
task in this M6 series (1–7) has installed shadcn/cmdk/Radix packages — the entire
`apps/web` codebase (100+ components, including the legacy `SearchPalette`/
`CommandPalette` this slice supersedes) uses hand-rolled, ARIA-correct primitives styled
through the shared `cn()` token utility, with existing shared `Skeleton`/`EmptyState`
components reused here for the loading/empty states and a `role="alert"` region standing
in for `Alert`. Installing net-new shadcn/cmdk/Radix packages for this slice alone, while
every other M6 surface (and the rest of the app) stays hand-rolled, would be an
inconsistent, higher-risk partial adoption; a full shadcn migration is an unstarted,
larger follow-up out of scope for a single slice.
