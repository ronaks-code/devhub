# M6 Task 2 — TaskRail QA note (`taskRail` slice flag, default OFF)

DevHub-own Browser QA of the extracted `TaskRail` (open-list rail). Measured against a
self-contained `fixture.html` built from the SHIPPED `index.css` token/`.dh-*` blocks
plus the REAL `TaskRail` SSR markup (rendered by the component via
`renderToStaticMarkup`, not hand-authored), mounted inside the shipped `.dh-rail` /
`.dh-rail-content` shell chrome. Served on `http://localhost:5202`, viewport 1000x900,
`device` scale. This is the same fixture-measurement method used for the M6 Task 1 shell.

## Fixtures / screenshots
- `fixture.html` — rich open list: two groups (`Today`, `Earlier`), a selected + active
  Claude row, two Codex rows, and four secondary destinations.
- `fixture-empty.html` — empty state (`No tasks`) with the same brand/actions/destinations.
- `m6-taskrail-wide.png` — rich open list, 1000x900.
- `m6-taskrail-empty.png` — empty state, 1000x900.

## Live `getBoundingClientRect` / `getComputedStyle` measurements (rich fixture)
| # | Property | Measured | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Rail width | 274 (273 + 1px border) | 273 (`--dh-rail-width`) | Match |
| 2 | Selected row width | 256 | 256 (`--dh-selected-row-width`) | Match |
| 3 | Selected row height | 30 | 30 (`--dh-selected-row-height`) | Match |
| 4 | Selected row inset from rail-content left | 8 | 8 (`--dh-rail-inset`) | Match |
| 5 | Selected fill | `rgb(49,49,49)` = `#313131` | `--dh-selected` `#313131` | Match |
| 6 | Selected row radius | 9px | `--dh-radius-row` 9px | Match |
| 7 | Provider quiet text (visible suffixes) | `Codex`, `Claude`, `Codex` | quiet suffix per row, no logo | Match |
| 8 | Provider full identity in accessible name | `OpenAI · Codex` / `Anthropic · Claude` present | full identity, never absent | Match |
| 9 | Active row height with quiet spinner | 30 (unchanged) + spinner present | height invariant | Match |
| 10 | Roving focus: open buttons at `tabIndex 0` | 1 | exactly one roving tabstop | Match |
| 11 | Overflow `Actions for {task}` tabbable | all `tabIndex 0`, reachable without hover | independently tabbable | Match |
| 12 | Provider logos (`svg`/`img`) in rail | 0 | 0 (quiet text only) | Match |
| 13 | Open-list role | `role="list"` with 3 `data-dh-task-row` list items | open list, not nested cards | Match |
| 14 | Rows visible inside rail (not clipped) | all 3 `visibleInRail: true` | rows render, list scrolls | Match |
| 15 | Secondary destinations pinned at bottom | destinations top 755, rail bottom 900 | pinned footer | Match |
| 16 | Empty state copy | `No tasks` shown, `New task` present | `T-rail` copy | Match |

16 concrete comparison points, all Match. Brand stays `DevHub` (never a provider
wordmark). One layout fix landed during QA: `.dh-tasklist-root` needed `height: 100%`
and the list `flex: 1 1 auto` so the flex-basis-0 list did not collapse to zero height
inside the block-level rail-content (rows were laid out but clipped); after the fix all
three rows render and the destinations pin to the bottom.

## Flag safety
`taskRail` requested-default stays **false**; flag-off keeps the legacy
`ProjectsPane`/`SessionsPane`/`RecentMenu` rail unchanged, and `App.tsx` instantiates
`TaskRail` ONLY in the `taskRailMode === "devhub"` branch (the model is built there too),
so flag-off never constructs the model or mounts the component. `nativeCodex` /
`persistentClaude` stay false.

## Scope (honest)
This task claims the rail open-list PRESENTATION, provider-identity quiet text,
selection geometry, roving-focus/overflow semantics, failure isolation, and flag safety.
The App-side model currently supplies the reachable primary tabs as secondary
destinations and an EMPTY task list (`No tasks`); populating live native task rows (each
carrying its immutable provider identity) is a later data-wire, deliberately not in this
unit — mirroring how M6 Task 1 left rail rows as slots.
