# M6 Task 5 — Composer gate evidence addendum

Date: 2026-07-16. Slice flag: `composerSurface` (default false). Fixture:
`fixture-resting.html` served over `http://localhost:5299/qa-tmp/composer/fixture-resting.html`,
measured live with an isolated `playwright-cli` session.

## Screenshots (current / min / narrow)

| Tier | File | Viewport | `scrollWidth` vs `innerWidth` | Result |
| --- | --- | --- | --- | --- |
| Current | `m6-composer-resting-wide.png` (existing) | 1000x780 | — | existing |
| Min (1024) | `m6-composer-resting-min-1024.png` | 1024x1130 | 1024 / 1024 | No overflow |
| Narrow (768) | `m6-composer-resting-narrow-768.png` | 768x1130 | 768 / 768 | No overflow |

Composer's own fixture harness has no fixed-px demo frame wider than the viewport (unlike
`thread`/`settings-secondary`, see their addenda), so this is a genuine confirmed
no-overflow result at both tiers, not merely an absence of a harness artifact.

## ≥5 comparison points (new)

| # | Comparison | Governing reference | Measured | Disposition |
| --- | --- | --- | --- | --- |
| 1 | No overflow at 1024 | per-slice gate criteria | `scrollWidth === innerWidth === 1024` | Match |
| 2 | No overflow at 768 | per-slice gate criteria | `scrollWidth === innerWidth === 768` | Match |
| 3 | `Message` textarea label | `COMPOSER_COPY.textareaLabel` = `Message` (`Composer.tsx:69`) | `label[for="dh-composer-textarea"]` renders `Message` | Match |
| 4 | New-task placeholder | `COMPOSER_COPY.newTaskPlaceholder` = `Describe the outcome or change…` | fixture textarea `placeholder` attr matches | Match |
| 5 | `Stop current turn` label | `COMPOSER_COPY.stopLabel` = `Stop current turn` | present in `fixture-active.html`'s send button | Match |

## Visible-copy diff

`COMPOSER_COPY` (`Composer.tsx:67-74`) is the frozen dictionary, plus the reused
`DISABLED_REASON` map for send-disabled copy. Cross-checked against `surface-inventory.md`
`T-composer`/`L-chat`:

| String | In dictionary | Where |
| --- | --- | --- |
| `Describe the outcome or change…` (new-task placeholder) | Yes | `COMPOSER_COPY.newTaskPlaceholder` |
| `Send` | Yes | `COMPOSER_COPY.sendLabel` |
| `Stop current turn` | Yes | `COMPOSER_COPY.stopLabel` |
| `Message` (accessible label) | Yes | `COMPOSER_COPY.textareaLabel` |
| `Reconnect to send. Your draft is saved.` | Yes | `DISABLED_REASON.disconnectedStale`, aliased as `COMPOSER_COPY.reconnectNote` |

No preserved `T-composer` string dropped; the closed dictionary is the sole source
consumed by `Composer.tsx`, so no divergent duplicate copy can exist elsewhere.

## Keyboard / a11y pass — partial: logic-level coverage exists, no live-DOM test

Unlike Tasks 3/4, `Composer.test.ts` DOES exercise the actual keyboard contract, but
through **pure decision functions** operating on synthetic key events
(`decideComposerKey({ key: "Escape", ... })`), not a live `fireEvent`/`userEvent` dispatch
against a mounted DOM (`grep -c 'fireEvent|userEvent|dispatchEvent' Composer.test.ts` = 0).
21 keyboard-shaped assertions cover Enter/Shift+Enter/Escape/picker-arrow ownership at the
function level, plus a real `aria-describedby` wiring check
(`Composer.test.ts:180`) on server-rendered markup.

**Disposition:** stronger than Task 3/4 (the actual key-handling logic is unit-tested,
not just its ARIA output), but still short of the plan's literal "keyboard/a11y" gate,
which implies a live interaction proof. Recorded as a partial pass with the same
live-DOM-test gap noted across every M6 slice (see `evidence/m6/thread/gate-evidence-2026-07-16.md`).
