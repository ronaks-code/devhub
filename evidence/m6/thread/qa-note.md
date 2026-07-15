# M6 Task 4 — ThreadWorkspace + ActivityTimeline Browser QA

Date: 2026-07-15
Flag: `threadWorkspace` (default OFF)

## Method

Playwright (Chromium via the MCP browser) driven against the four self-contained
fixtures already staged in `evidence/m6/thread/` — `fixture-empty.html`,
`fixture-sparse.html`, `fixture-active.html`, `fixture-complete.html`. Each fixture is
the REAL `ThreadWorkspace` SSR markup wrapped in the SHIPPED `apps/web/src/index.css`
tokens + `.dh-thread-*` blocks (no React runtime, no live provider data). Served over a
static `http.server` on `127.0.0.1:5209`; viewport 1440x900; measurements taken with
`getComputedStyle` / DOM queries, not eyeballed. Screenshots: `m6-thread-wide.png`
(complete transcript, the required wide capture) and `m6-thread-active-wide.png`
(active/streaming state with the stop-composer + inline request).

Console: the only errors are three benign `404`s for the build-time `@import`
stylesheets (`tailwindcss`, `highlight.js/...`, `katex/...`) that do not exist as static
files. They do not affect the `.dh-*` layer — every measured token/geometry below
resolved correctly, which proves the inline `:root` tokens + `.dh-thread-*` rules apply.
Zero JavaScript errors.

## Live measurements (all Match)

| # | Comparison | Measured | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Assistant prose is UNFRAMED | `background: rgba(0,0,0,0)`, `border: none`, `border-radius: 0px`, `data-dh-unframed` present | transparent, no border/radius | Match |
| 2 | User bubble fill | `rgb(36,36,36)` = `#242424` | `#242424` | Match |
| 3 | User bubble max width | `max-width: 566px` (`data-dh-bubble-max="566"`) | ~566 | Match |
| 4 | User bubble is the surfaced, right-aligned bubble | `[data-dh-surface]` present; wrap `justify-content: flex-end` | one right-aligned surface | Match |
| 5 | Empty canvas has no hero/SVG/suggestions | `fixture-empty`: transcript `children=0`, `textContent=""`, `<h1..h3>=0`, `<svg>=0`, `<img>=0`, only the 1 composer button | blank canvas | Match |
| 6 | Composer still renders when empty | `fixture-empty` composer present at `height: 98px` | composer persists | Match |
| 7 | Inline request pill fill | `rgb(38,38,38)` = `#262626`, `[data-dh-surface]` present | `#262626` surfaced control | Match |
| 8 | Inline request is NOT a modal | `role="group"`, no `role="dialog"`, no `aria-modal` | inline, never modal | Match |
| 9 | Composer geometry (stable slot) | width `736px`, height `98px`, radius `21px`, bottom margin `16px`, fill `rgb(45,45,45)`=`#2d2d2d` | 736x98 / r21 / 16 gutter / #2d2d2d | Match |
| 10 | Transcript column width | `736px` | 736 | Match |
| 11 | Send↔Stop swaps label in the same slot | active fixture `data-dh-send-state="stop"` in the same composer geometry | no geometry shift | Match |
| 12 | Single polite live region | one `[data-dh-live-region]` `role="status"` `aria-live="polite"` | exactly one coarse live region | Match |
| 13 | No logos anywhere | `<svg>=0` and `<img>=0` across all fixtures | zero logos | Match |

## Judgment

The ThreadWorkspace presentation is faithful to `design-lock.md` §4/§6 and the M3/M4
transcript-is-the-task contract: assistant prose is unframed, the user bubble is the one
`#242424` right-aligned surface capped at 566, inline requests are surfaced `#262626`
non-modal controls, the empty existing task is a genuinely blank canvas (no hero, no
suggestions, no SVG) while the geometry-stable 736x98 composer still renders, and there
is exactly one polite live region. This QA validates the PRESENTATION + geometry only;
live transcript-item data (native events → `ThreadItem[]`) is a deferred data-wire (see
STATUS / fidelity-ledger Task 4 judgment). `threadWorkspace` requested-default stays
false; `nativeCodex` / `persistentClaude` stay false.
