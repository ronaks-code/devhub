# M6 Task 5 — Composer Browser QA

DevHub-own Browser QA for the canonical `Composer` (M6 slice 5), run with Playwright
against self-contained fixtures built from the SHIPPED `apps/web/src/index.css` + REAL
`Composer` SSR markup (`renderToStaticMarkup`), served on `:5209`, viewport 1440x900,
`deviceScaleFactor: 2`, dark color scheme.

Fixtures (real component output, not hand-written DOM):
- `fixture-resting.html` — existing Claude task, empty draft, Send disabled.
- `fixture-active.html` — Codex task, running turn with a native interrupt enabled → Stop.
- `fixture-new.html` — brand-new task, outcome placeholder.
- `fixture-disconnected.html` — disconnected transport, draft preserved + editable.

## Live measurements (getBoundingClientRect / getComputedStyle)

| Point | Resting | Active (Stop) | Disconnected | Expected | Finding |
| --- | --- | --- | --- | --- | --- |
| Composer width | 736 | 736 | 736 | 736 | Match |
| Composer height | 98 | 98 | 98 | 98 | Match |
| Surface fill | rgb(45,45,45) | rgb(45,45,45) | rgb(45,45,45) | `#2d2d2d` | Match |
| Radius | 21px | 21px | 21px | ~21 | Match |
| Bottom gutter (margin-bottom) | 16px | 16px | 16px | 16 | Match |
| Send affordance | `Send` (send) | `Stop current turn` (stop, red `#d95c5c`) | `Send` (send) | send↔stop, same slot | Match — geometry unchanged across the swap |
| Send disabled + reason | disabled, `Write a message to send.` via `aria-describedby` | enabled (Stop) | disabled, `Reconnect to send. Your draft is saved.` | accessible reason present | Match |
| Textarea editable | not disabled | not disabled | not disabled (draft `Unsent work stays here.` preserved) | always editable | Match |
| Placeholder | `Describe the outcome or change…` | — | — | outcome-oriented | Match |
| Accessible label element | `label[for=dh-composer-textarea]` present | — | — | not placeholder-only | Match |
| Provider identity (quiet text) | `Anthropic · Claude` | `OpenAI · Codex` | `Anthropic · Claude` | quiet, never a logo | Match |
| Provider-native permission | `Permission mode` / `plan` | `Permissions` / `workspace-write` | `Permission mode` / `plan` | never cross-mapped; Claude never `Workspace` | Match |
| Reconnect note | — | — | `Reconnect to send. Your draft is saved.` | shown while disconnected | Match |
| Logos (svg/img) | 0 / 0 | 0 / 0 | 0 / 0 | 0 | Match |

15 comparison points, all Match.

## Console

Only benign `@import` 404s from `index.css` (tailwindcss, highlight.js github-dark.css,
katex.min.css) + `favicon.ico`; ZERO JavaScript/page errors. These `@import`s are the
app's normal bundler-resolved assets, absent from the static fixture server — expected.

## Screenshots
- `m6-composer-resting-wide.png`
- `m6-composer-active-wide.png`
- `m6-composer-disconnected-wide.png`

## Scope (honest)

This claims the composer PRESENTATION, stable-slot geometry, provider-native footer,
honest Stop gating, accessible disabled reasons, and disconnect-editable draft only.
Live mounting into the task canvas (wiring `useDraft`/`usePromptHistory`/pickers to a
running task) is a deferred data-wire — the live composer host is the user-owned
`ChatPane.tsx` (off-limits) — mirroring how Tasks 3 and 4 deferred their data-wires to
the Task 9 `codexStyleShell` cutover. The `composerSurface` flag gate + resolver land
here; the App mount is staged. `composerSurface` requested-default stays false.
