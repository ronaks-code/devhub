# M6 Task 1 — DevHubShell geometry QA

Date: 2026-07-15
Slice flag: `shellChrome` (default false)
Governing reference: `reference-captures/chatgpt-empty-task-1800x1130.png` (REF-EMPTY) /
`chatgpt-current-1800x1130.png` (REF-RICH); `design-lock.md` §4;
`reference-capture-manifest.md` "Measured wide-shell geometry".

## Method

The shipped `--dh-*` tokens + `.dh-*` rules from `apps/web/src/index.css` and the exact
`DevHubShell.tsx` DOM were rendered in a self-contained harness (`fixture.html`) served
over `http://127.0.0.1:5199`, driven with the Playwright browser at three viewport tiers.
Geometry was read from live `getBoundingClientRect()` / `getComputedStyle()`, not eyeballed.
Slot content is representative placeholder only — the real rail/header/transcript/composer/
inspector arrive in M6 Tasks 2–8. Console was clean apart from a benign `favicon.ico` 404.

Screenshots: `m6-shell-wide-1800x1130.png`, `m6-shell-narrow-768.png`, `m6-shell-pwa-390.png`.

## Measured comparison points (wide 1800x1130) vs the locked geometry

| # | Comparison point | Governing / locked value | Measured | Disposition |
|---|---|---|---|---|
| 1 | Left rail width | 273 | 273 | Match |
| 2 | Header height | 46 | 46 | Match |
| 3 | Canvas interior color | `#181818` | `rgb(24,24,24)` = `#181818` | Match |
| 4 | Transcript/composer column | 736 | 736 | Match |
| 5 | Inspector dock width | 300 (content-height) | 300, `#2d2d2d`, radius 16 | Match |
| 6 | Inspector lane / gutters | lane 316, top 12, right 16 | 316 / 12 / 16 | Match |
| 7 | Composer box | 736x98, 16 bottom gutter, ~21 radius | slot 736 wide, box 98 high + 16 pad-bottom, radius 21 | Match |
| 8 | Canvas origin | body starts at `x=273, y≈46` | `x=273, y=46` | Match |
| 9 | Brand wordmark | `DevHub` (never a provider wordmark) | `DevHub` | Match (intentional deviation from capture's `Codex`) |
| 10 | Composer left origin | manifest `x=510` | `x=511` | Match (≤1px sub-pixel centering) |
| 11 | No horizontal shell overflow | doc width == viewport | 1800 == 1800 | Match |

## Responsive tiers

- Narrow (768x1024): rail collapses in place to a 48 icon strip (still ONE `<nav>`),
  inspector lane hidden, transcript clamps to 720, header 46, canvas `#181818`, exactly
  1 nav / 1 main / 1 skip link, no horizontal overflow. No hidden duplicate tabbable rail.
- PWA (390x844): rail `display:none` (removed from tab order, not a hidden tabbable
  duplicate), header 44, canvas `#181818`, 1 main, no horizontal overflow.

## Intentional Task-1-scope deviations (not defects)

- Brand is `DevHub`, not the capture's `Codex` wordmark (design-lock §3, invariant 9).
- Rail rows, header title/actions, inspector rows, and composer footer are placeholder
  content; their production owners land in M6 Tasks 2 (TaskRail), 3 (TaskHeader), 5
  (Composer), and 6 (InspectorDock).
- Rail fill uses the active-window `#404040` browser fallback per design-system §2.1.
