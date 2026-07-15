# M6 Task 3 — TaskHeader + provider-aware setup QA note (`taskHeaderSetup` flag, default OFF)

DevHub-own Browser QA of the extracted `TaskHeader` + `TaskSetup`. Measured against a
self-contained `fixture.html` built from the SHIPPED `index.css` token/`.dh-*` blocks
plus the REAL `TaskHeader`/`TaskSetup` SSR markup (rendered by the components via
`renderToStaticMarkup`, not hand-authored). Served on `http://localhost:5209`,
viewport 1000x780. Same fixture-measurement method used for M6 Tasks 1 and 2.

## Fixtures / screenshots
- `fixture.html` — a Codex task header, a Claude task header with model divergence, a
  Codex new-task setup (reasoning present, all preconditions valid), and a Claude
  new-task setup (no reasoning, `Create task` disabled because project is unselected).
- `m6-taskheader-wide.png` — full-page capture at 1000x780.

## Live `getBoundingClientRect` / `getComputedStyle` measurements
| # | Property | Measured | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Task header height | 47 (46 + 1px bottom border) | 46 (`--dh-header-height`) | Match |
| 2 | Title truncation | `ellipsis / nowrap / hidden` | truncates before overflow | Match |
| 3 | Provider identity is quiet TEXT | `<span>` `OpenAI · Codex` | read-only text, not a control | Match |
| 4 | In-task provider control | 0 `<select>` in the header; 0 `data-dh-provider-picker` | none (provider immutable) | Match |
| 5 | Setup-time provider picker | 2 (one per setup, setup-only) | picker exists ONLY in setup | Match |
| 6 | Codex reasoning field present | yes | Codex real reasoning inventory | Match |
| 7 | Claude reasoning field present | no (absent) | Claude has no reasoning | Match |
| 8 | Claude permission label | `Permission mode` | provider-native (never `Workspace`) | Match |
| 9 | Claude `Create task` disabled | `disabled=true` | gated until preconditions valid | Match |
| 10 | Claude `Create task` reason | `Choose a project.` | accessible disabled reason | Match |
| 11 | Claude model divergence present | yes | shown only on divergence | Match |
| 12 | Divergence copy | `Model differs from request` | exact copy; requested not claimed as ran | Match |
| 13 | Provider logos (`svg`/`img`) | 0 | 0 (quiet text only) | Match |

13 concrete comparison points, all Match. The `+1` header height (47 vs 46) is the same
1px-border delta measured for the M6 Task 1 shell (46 content + 1px `--dh-border-subtle`
bottom border), not an invented dimension.

## Flag safety
`taskHeaderSetup` requested-default stays **false**. Flag-off keeps the legacy
`ChatPane` header / setup; `resolveTaskHeaderSetupMode` returns `legacy` for
false/undefined/missing settings (asserted). `nativeCodex` / `persistentClaude` stay
false; this is presentation only and mounts against fixtures, never a live billable
provider turn.

## Scope (honest)
This unit delivers the capability-gated TaskHeader + TaskSetup PRESENTATION, the
provider-immutability contract (no in-task provider control; change routes to a
cross-provider fork), the Claude model-divergence disclosure copy, and the flag gate.
Live mounting into the task canvas is a later data-wire (the canvas per-task header
currently lives inside the user-owned `ChatPane.tsx`, which this slice must not edit),
mirroring how M6 Tasks 1–2 left slots/rows as later data-wires.
