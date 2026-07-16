# M6 Task 7 — Search + Commands gate evidence addendum

Date: 2026-07-16. Slice flag: `searchCommands` (default false). Fixture: `fixture.html`
served over `http://localhost:5299/qa-tmp/search-commands/fixture.html`, measured live with
an isolated `playwright-cli` session.

## Screenshots (current / min / narrow)

| Tier | File | Viewport | `scrollWidth` vs `innerWidth` | Result |
| --- | --- | --- | --- | --- |
| Current | `m6-search-commands-wide.png` (existing) | 1000x780 | — | existing |
| Min (1024) | `m6-search-commands-min-1024.png` | 1024x1130 | 1024 / 1024 | No overflow |
| Narrow (768) | `m6-search-commands-narrow-768.png` | 768x1130 | 768 / 768 | No overflow |

## ≥5 comparison points (new)

| # | Comparison | Governing reference | Measured | Disposition |
| --- | --- | --- | --- | --- |
| 1 | No overflow at 1024 | per-slice gate criteria | `scrollWidth === innerWidth === 1024` | Match |
| 2 | No overflow at 768 | per-slice gate criteria | `scrollWidth === innerWidth === 768` | Match |
| 3 | Search dialog title | `SEARCH_COPY.title` = `Search tasks and messages` (`TaskSearchDialog.tsx:45`) | present verbatim in fixture | Match |
| 4 | Commands dialog title | `COMMAND_COPY.title` = `Search commands and tasks` (`CommandDialog.tsx:70`) | present verbatim in fixture; NEVER co-present with the Search title in the same dialog node (grepped both ways) | Match |
| 5 | Two separate dialog surfaces, never merged | `design-lock.md` §8 | `5` `data-dh-search-dialog` nodes / `3` `data-dh-command-dialog` nodes in the fixture, zero overlap | Match |

## Visible-copy diff

`SEARCH_COPY` (`TaskSearchDialog.tsx:43-...`) and `COMMAND_COPY` (`CommandDialog.tsx:68-...`)
are the two frozen dictionaries — deliberately separate objects, matching the "Search and
Commands are separate contracts" invariant. Cross-checked against `surface-inventory.md`
`T-search`/`T-commands`:

| String | In dictionary | Verified |
| --- | --- | --- |
| `Search tasks and messages` | Yes (`SEARCH_COPY.title`) | dialog title in fixture |
| `Search commands and tasks` | Yes (`COMMAND_COPY.title`) | dialog title in fixture |
| Five commands `New task/Search tasks/Toggle inspector/Open Settings/Go to Ops` | Yes (`DEFAULT_COMMANDS`) | present verbatim, in order, in the fixture's Commands list |
| Footer `↑↓ navigate` / `↵ open` / `esc close` | Yes | present in both dialogs' footers |

## Keyboard / a11y pass — same cross-slice gap

`TaskSearchDialog.test.ts` and `CommandDialog.test.ts` render via `renderToStaticMarkup`
and assert `aria-activedescendant`/`aria-selected`/`role="radio"`/`aria-checked` as static
markup strings, plus pure-function checks (`describeSearchTasksTransition`,
`describeEscapeRestore` returning the correct invoker name to refocus). No
`fireEvent`/`userEvent`/`dispatchEvent` (0 hits in either file) drives an actual keydown
against a mounted dialog to prove the active row advances or that focus is truly restored
to the DOM node named by `describeEscapeRestore`. Same disposition as every other M6
3-8 slice: the logic that WOULD produce correct behavior is unit-tested; a live-interaction
proof does not exist yet in this codebase.
