# M6 Task 6 — InspectorDock gate evidence addendum

Date: 2026-07-16. Slice flag: `inspectorDock` (default false). Fixture: `fixture-diff.html`
served over `http://localhost:5299/qa-tmp/inspector/fixture-diff.html`, measured live with
an isolated `playwright-cli` session.

## Screenshots (current / min / narrow)

| Tier | File | Viewport | `scrollWidth` vs `innerWidth` | Result |
| --- | --- | --- | --- | --- |
| Current | `m6-inspector-diff-wide.png` (existing) | 1000x780 | — | existing |
| Min (1024) | `m6-inspector-diff-min-1024.png` | 1024x1130 | 1024 / 1024 | No overflow |
| Narrow (768) | `m6-inspector-diff-narrow-768.png` | 768x1130 | 768 / 768 | No overflow |

Note: a `m6-inspector-disclosure-narrow.png` already existed from 2026-07-15 for the
dedicated narrow-`Sheet`/disclosure fixture (`fixture-disclosure.html`) — that capture
already covers the slice's OWN narrow behavior contract ("Desktop required for terminal
and diff"). This addendum additionally confirms the `diff` destination fixture itself
does not overflow at 768/1024 when rendered without the disclosure swap.

## ≥5 comparison points (new)

| # | Comparison | Governing reference | Measured | Disposition |
| --- | --- | --- | --- | --- |
| 1 | No overflow at 1024 (diff destination) | per-slice gate criteria | `scrollWidth === innerWidth === 1024` | Match |
| 2 | No overflow at 768 (diff destination) | per-slice gate criteria | `scrollWidth === innerWidth === 768` | Match |
| 3 | Footer copy | `INSPECTOR_COPY.footer` = `Availability follows the task runtime` (`InspectorDock.tsx:64`) | present verbatim in `fixture-diff.html` | Match |
| 4 | `Not available for this task` copy | `INSPECTOR_COPY.notAvailable` (`InspectorDock.tsx:66`) | present verbatim in `fixture-browser-unavailable.html` | Match |
| 5 | `No artifacts` copy (distinct from unavailable) | `INSPECTOR_COPY.noArtifacts` (`InspectorDock.tsx:68`) | present verbatim in `fixture-artifacts-empty.html`, with NO `Not available` node co-present (grepped) | Match |

## Visible-copy diff

`INSPECTOR_COPY` (`InspectorDock.tsx:62-69`) is the frozen dictionary. Cross-checked
against `surface-inventory.md` `T-inspectors`:

| String | In dictionary | Verified in fixture |
| --- | --- | --- |
| `Availability follows the task runtime` | Yes | `fixture-diff.html` footer |
| `Not available for this task` | Yes | `fixture-browser-unavailable.html` |
| `No artifacts` | Yes | `fixture-artifacts-empty.html`, distinct (no `Not available` string co-present) |
| `Showing cached data — reconnect to refresh.` | Yes | `fixture-disconnected.html` |
| Five tab labels `Diff/Files/Terminal/Browser/Artifacts` | Yes | present in `fixture-diff.html` tablist |

## Keyboard / a11y pass — strongest in M6, still not a live-DOM test

`InspectorDock.test.ts` unit-tests the actual roving-focus math (`nextTabIndex`) against
Left/Right (wrap)/Home/End/Enter directly (`InspectorDock.test.ts:201-210`), plus
server-rendered ARIA structure (`role="tablist"`, one `tabindex="0"` roving tab,
`tabindex="0"` tabpanel `aria-labelledby` the selected tab). This is the most complete
keyboard-logic coverage of any M6 3-8 slice. It is still not a live `fireEvent`/`userEvent`
DOM-dispatch test (0 hits, same as every other M6 slice) — the math is proven correct, but
no test presses ArrowRight against a mounted `InspectorDock` and asserts the DOM tab that
now has `tabindex="0"`/focus. Recorded as the same cross-slice gap, with the caveat that
this slice's underlying logic coverage is the deepest of the six.
