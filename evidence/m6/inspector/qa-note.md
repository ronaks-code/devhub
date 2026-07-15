# M6 Task 6 — InspectorDock Browser QA

DevHub-own Browser QA for the canonical `InspectorDock` (M6 slice 6), run with the
Playwright MCP browser against self-contained fixtures built from the SHIPPED
`apps/web/src/index.css` + REAL `InspectorDock` SSR markup (`renderToStaticMarkup`),
served over `http://localhost:5219`, dark color scheme.

Fixtures (real component output, not hand-written DOM):
- `fixture-diff.html` — Codex task, Diff selected, two changed paths + bounded unified diff, `2 files · +84 -19`.
- `fixture-terminal.html` — Terminal selected, provider-emitted `pnpm test` / `622 passed`, no shell input.
- `fixture-browser-unavailable.html` — Browser selected, capability-gated → `Not available for this task`.
- `fixture-artifacts-empty.html` — Artifacts selected, supported but empty → `No artifacts` (distinct from unsupported).
- `fixture-disconnected.html` — Claude task, Diff disconnected → cached read with the reconnect note.
- `fixture-disclosure.html` — narrow (390-wide) → `Desktop required for terminal and diff` disclosure, no tablist.

## Live measurements (getBoundingClientRect / getComputedStyle)

| Point | Measured | Expected | Finding |
| --- | --- | --- | --- |
| Dock width | 300 | 300 | Match |
| Dock height (diff) | 321 (viewport 900) | content-height, not full | Match — content-height, NOT a full-height IDE pane |
| Surface fill | rgb(45,45,45) | `#2d2d2d` | Match |
| Border radius | 16px | ~16 | Match |
| Inner padding | 16px | 16 | Match |
| Destination tabs | 5 — Diff/Files/Terminal/Browser/Artifacts | exactly five | Match |
| Selected tabs | exactly 1 | one | Match |
| Rendered panels | 1 | exactly one | Match |
| Environment position | above tablist, above panel | persistent summary first | Match — Environment is a summary region, not a tab |
| Footer | `Availability follows the task runtime` | verbatim | Match |
| Diff scroll region | overflow-y auto, max-height 220px | bounded ScrollArea | Match — scroll only inside the bounded diff |
| Terminal body | `pnpm test\n622 passed`, no input/textarea/button | provider output only | Match — no unsandboxed shell affordance |
| Browser gated | `Not available for this task` | gated when no runtime | Match |
| Artifacts empty | `No artifacts`, no unavailable node | distinct empty state | Match — distinct from unsupported |
| Disconnected diff | `Showing cached data — reconnect to refresh.` + cached content still readable | cached read | Match |
| Narrow disclosure | `Desktop required for terminal and diff` + title `Task inspector`, no tablist/tabpanel | disclosure, not the dock | Match |

## Screenshots (device scale)

- `m6-inspector-diff-wide.png` — Diff destination, populated + bounded diff.
- `m6-inspector-terminal-wide.png` — Terminal, provider output only.
- `m6-inspector-browser-unavailable-wide.png` — Browser gated.
- `m6-inspector-disconnected-wide.png` — Diff disconnected cached read.
- `m6-inspector-disclosure-narrow.png` — narrow desktop-required disclosure.

## Notes

- The fixtures inline the raw `index.css`; the browser's failed `@import "tailwindcss"`/
  `highlight.js`/`katex` fetches are harmless console errors — every measured `.dh-*`
  rule is plain CSS that applies regardless, so the geometry/color/radius/padding
  numbers above are the shipped values.
- All comparison points Match. No provider logo rendered (`<svg>`/`<img>` count 0 in the
  unit suite). Flag stays default-off; this is the presentation + flag gate only.
