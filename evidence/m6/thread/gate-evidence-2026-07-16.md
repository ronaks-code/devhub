# M6 Task 4 — ThreadWorkspace + ActivityTimeline gate evidence addendum

Date: 2026-07-16. Slice flag: `threadWorkspace` (default false). Fixture:
`fixture-active.html` served over `http://localhost:5299/qa-tmp/thread/fixture-active.html`
(temporary Vite-served copy of the existing evidence fixture), measured live with an
isolated `playwright-cli` session.

## Screenshots (current / min / narrow)

| Tier | File | Viewport | `scrollWidth` vs `innerWidth` | Result |
| --- | --- | --- | --- | --- |
| Current | `m6-thread-active-wide.png` (existing) | 1000x780 | — | existing |
| Min (1024) | `m6-thread-active-min-1024.png` | 1024x1130 | 1024 / 1024 | No overflow |
| Narrow (768) | `m6-thread-active-narrow-768.png` | 768x1130 | **900 / 768** | **Overflow — see finding below** |

## Finding: the 768 overflow is a fixture-harness artifact, not a proven production result

`document.querySelectorAll('*')` widest-right-edge probe at 768 identifies
`.dh-canvas-frame` (`fixture-active.html:1192`,
`width:900px;min-height:640px;...height:640px;`) as the overflowing node — a **fixed-px
demo wrapper the fixture author added to stage the screenshot**, not a rule inside
`ThreadWorkspace.tsx` itself (the real component has no such fixed frame; `grep -n
"900px" apps/web/src/components/features/shell/ThreadWorkspace.tsx` returns nothing).
So this is not evidence that the shipped `ThreadWorkspace` overflows at 768 — it is
evidence that **no fixture or test in this slice actually exercises narrow-width
behavior**, because the demo harness pins a wide-only frame. Unlike Task 1
(`shell/fixture.html`) and Task 2, which both built dedicated narrow-viewport DOM
variants and asserted zero overflow live, `ThreadWorkspace.test.ts` contains no
viewport/media-query assertion at all (grepped for `768|narrow|matchMedia`: 0 hits).

**Disposition: real, open gap — not fabricated as a pass.** `ThreadWorkspace`'s narrow
behavior is UNVERIFIED, not merely "styled for wide only": the M6 plan's Task 4 DoD does
not explicitly demand a narrow layout contract the way Task 1/2/6/8 do, so this is not a
blocking regression, but it must not be recorded as a green `V` gate at narrow. Logged in
`fidelity-ledger.md` and `tasks/STATUS.md`.

## ≥5 comparison points (new)

| # | Comparison | Governing reference | Measured | Disposition |
| --- | --- | --- | --- | --- |
| 1 | No overflow at min (1024) | per-slice gate criteria | `scrollWidth === innerWidth === 1024` | Match |
| 2 | Narrow (768) overflow traced to fixture harness, not `ThreadWorkspace` source | per-slice gate criteria | `.dh-canvas-frame` fixed 900px in `fixture-active.html`; absent from `ThreadWorkspace.tsx` | Intentional-fixture-limitation; production narrow behavior unverified (open) |
| 3 | `requestExpired` copy | `THREAD_COPY.requestExpired` = `Request expired — no action taken` (`ThreadWorkspace.tsx:70`) | present verbatim in the component source; not present in this state's fixture (no expiry state staged) | Match (source-level; fixture doesn't stage this state) |
| 4 | `cancelledByYou` copy | `THREAD_COPY.cancelledByYou` = `Cancelled by you` | present verbatim in source | Match (source-level) |
| 5 | Single polite live region | `component-state-matrix.md` §8 | `aria-live="polite"` count = 1 in the rendered fixture (re-confirmed live via DOM query, not just string count) | Match |

## Visible-copy diff

`THREAD_COPY` (`ThreadWorkspace.tsx:68-79`) and `ACTIVITY_COPY`
(`ActivityTimeline.tsx:37`) are the frozen dictionaries. Cross-checked against
`surface-inventory.md` `T-thread`/`T-active`/`T-intervention`:

| String | In dictionary | Where |
| --- | --- | --- |
| `Request expired — no action taken` | Yes | `THREAD_COPY.requestExpired` |
| `Cancelled by you` | Yes | `THREAD_COPY.cancelledByYou` |
| `Working for` (prefix) | Yes | `THREAD_COPY.workingPrefix` |
| `Plan` | Yes | `ActivityTimeline.tsx` plan-toggle title (matches fixture `Plan` heading) |

No preserved copy regressed; no new unapproved string introduced (both dictionaries are
closed `Object.freeze` sets consumed directly by the components, not re-typed elsewhere).

## Keyboard / a11y pass — REAL FINDING: no live-interaction test exists

`ThreadWorkspace.test.ts` and `ActivityTimeline.test.ts` render exclusively via
`renderToStaticMarkup` (server-side static HTML) and assert ARIA attribute **strings**
(`aria-expanded`, `aria-current="step"`, `role="group"`, `aria-live="polite"` counts).
Grepped for `fireEvent|userEvent|dispatchEvent`: **0 hits** in either file. This means:
- The single-polite-live-region and non-modal-request-surface claims (`role="group"`,
  not `role="dialog"`) ARE verified — as static markup facts, which is what they are.
- The plan's Task 4 keyboard/a11y gate items — "Cmd/Ctrl+F, bookmark/error shortcuts,
  virtualization keeps focused node, inline request does not steal focus" — are
  **NOT** verified by any live keydown/focus-retention test in this codebase today.

**Disposition: gap, not fabricated as a pass.** This mirrors the identical pattern found
in Task 3 and (below) Tasks 5-8: every M6 slice's "keyboard/a11y" ledger row is backed by
static-markup string assertions and pure-function math, never a live DOM/browser
interaction test. Recorded once here and cross-referenced from the other slices' evidence
files rather than repeated as five separate discoveries.
