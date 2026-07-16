# M6 Task 8 — Settings + secondary utilities gate evidence addendum

Date: 2026-07-16. Slice flag: `settingsSecondary` (default false). Fixture: `fixture.html`
served over `http://localhost:5299/qa-tmp/settings-secondary/fixture.html`, measured live
with an isolated `playwright-cli` session.

## Screenshots (current / min / narrow)

| Tier | File | Viewport | `scrollWidth` vs `innerWidth` | Result |
| --- | --- | --- | --- | --- |
| Current | `m6-settings-secondary-wide.png` (existing) | 1000x780 | — | existing |
| Min (1024) | `m6-settings-secondary-min-1024.png` | 1024x1130 | 1024 / 1024 | No overflow |
| Narrow (768) | `m6-settings-secondary-narrow-768.png` | 768x1130 | **886 / 768** | **Overflow — see finding below** |

## Finding: the 768 overflow is a fixture-harness artifact, same pattern as Task 4

Widest-right-edge probe at 768 identifies `.frame` (`fixture.html`, `width:820px;...`) as
the overflowing node — a fixed-px demo card the fixture author added, not a rule inside
`SettingsRoute.tsx` (`grep -n "820px" apps/web/src/components/features/settings/SettingsRoute.tsx`
returns nothing). This is the SAME class of finding as `evidence/m6/thread/gate-evidence-2026-07-16.md`.

**This one is more significant than Task 4's**, because Task 8's own DoD explicitly
requires "narrow uses slim/sheet navigation, one field-group column, no horizontal
overflow" as a named acceptance criterion (`m6-implementation-plan.md` Task 8 RED-first
DoD, final clause) — and neither `SettingsRoute.test.ts`, `settings-ui.test.ts`, nor
`SecondaryNav.test.ts` contains a `768|narrow|matchMedia` assertion (grepped: 0 hits in
all three). So the ONE explicit narrow requirement this slice's own plan calls out by name
is unverified by any test or fixture today.

**Disposition: real, open gap.** Recorded in `fidelity-ledger.md` Task 8 and
`tasks/STATUS.md` as a named unmet DoD item, not folded into a "Match" row.

## ≥5 comparison points (new)

| # | Comparison | Governing reference | Measured | Disposition |
| --- | --- | --- | --- | --- |
| 1 | No overflow at min (1024) | per-slice gate criteria | `scrollWidth === innerWidth === 1024` | Match |
| 2 | Narrow (768) — DoD-named "no horizontal overflow" requirement | Task 8 DoD, final clause | fixture-harness card overflows to 886; no test asserts the real `SettingsRoute` narrow layout | Open gap (not Match) |
| 3 | `Saved in this browser` copy | `SettingsRoute.tsx:131` | present verbatim in fixture Connection field group | Match |
| 4 | `Not synced — stored only on this device, never sent to the server.` copy | `SettingsRoute.tsx:132` | present verbatim | Match |
| 5 | Field groups, not generic cards | `component-state-matrix.md` §13 | fixture renders `Appearance`/`Providers`/`Budget`/`Permissions` `<section aria-labelledby>` groups; `border:0px none` (no card chrome) — matches the existing ledger row | Match (re-confirmed live) |

## Visible-copy diff

Cross-checked `SettingsRoute.tsx`'s inline local/sync copy against `surface-inventory.md`
`L-settings`/`L-ops`/`L-inbox`/`L-dashboard`:

| String | Present | Where |
| --- | --- | --- |
| `Saved in this browser` / `Not saved` | Yes | `SettingsRoute.tsx:131` |
| `Not synced — stored only on this device, never sent to the server.` | Yes | `SettingsRoute.tsx:132` |
| 10-section `SETTINGS_TABS` order preserved | Yes | unchanged from legacy `SettingsPane`, per the existing ledger row (re-verified: `grep -c` the tab-label list against the legacy pane's own labels shows identical set) |

No preserved config string dropped in this addendum's spot-check.

## Keyboard / a11y pass — same cross-slice gap, plus the narrow gap above

`SettingsRoute.test.ts`/`settings-ui.test.ts`/`SecondaryNav.test.ts` assert
`role="tablist"`/`role="tab"` counts and real `<label for>` bindings as static markup
(43 total grep hits), plus the destructive-confirmation contract
(`describeClearLocalDataConfirmation`) as a pure-function check. No
`fireEvent`/`userEvent`/`dispatchEvent` exercises a live tab switch or the confirm dialog's
actual focus-on-Cancel behavior in a mounted DOM. Same cross-slice disposition as Tasks
3-7 (see `evidence/m6/thread/gate-evidence-2026-07-16.md`), COMPOUNDED here by the missing
narrow-layout test noted above.
