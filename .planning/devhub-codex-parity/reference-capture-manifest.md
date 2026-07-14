# Installed Codex Reference Capture Manifest

Status: current-build wide-shell reference is sufficient for the bounded concept phase. Computer Use remains host-blocked, so unavailable menus, transient states, narrow behavior, and motion are explicitly batched into the single design gate rather than inferred as observed fact.

## Environment

| Field | Evidence |
|---|---|
| Application | ChatGPT/Codex desktop, bundle `com.openai.codex` |
| Version/build | `26.707.51957` / `5175` |
| macOS | `26.5.1 (25F80)` |
| Theme | Dark |
| Reported window | ID `19836`, title `ChatGPT`, bounds `1800x1130+0+39` |
| Capture pixels | `3736x2396` PNG, including macOS window shadow |
| Display environment | Built-in Liquid Retina XDR `3024x1964 Retina`; two `2560x1440 @ 240Hz` displays also connected |
| Backing scale | Window capture is high-density and includes shadow; exact per-window backing scale is not exposed by the capture helper and remains to be recorded during design lock |
| Screen Recording | Permission already granted |
| Computer Use | Attempted by bundle ID and display name; host rejected `com.openai.codex` before returning state |
| Fallback capture | Bundled screenshot skill; navigation used the purpose-built Codex app thread navigator |

## Captures

### `chatgpt-current-1800x1130.png`

- Absolute path: `/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-current-1800x1130.png`
- Captured: `2026-07-12T17:48:01-0700`
- SHA-256: `05df79981a704194bc7b5d84039a0355cb475ea94421555991fb33e5a948eceb`
- Source task: `Audit conductor worktrees`
- State: completed rich response with table, bullets, links/code tokens, memory disclosure, footer actions, resting composer, task rail, and Environment inspector showing changes/repository/branch/commit/PR/subagents.
- Use: governing reference for wide completed-task shell, dense transcript typography, environment inspector, rail grouping, selected row, and resting composer.

### `chatgpt-devhub-sync3-thread-1800x1130.png`

- Absolute path: `/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-devhub-sync3-thread-1800x1130.png`
- Captured: `2026-07-12T17:48:26-0700`
- SHA-256: `35e2db5bc18427a66c940a4b5dfde722b8e03f8dea7d5198f1ac4633b856320d`
- Source native thread: `019f58e9-8cde-7cb2-9a3a-444e3dc54967`
- Source task name: `DevHub M1 Codex DEVHUB_CODEX_M1_20260713_003719Z`
- State: first app-server turn completed with the exact nonce; second app-server turn interrupted after streaming the nonce. Resting composer and Environment inspector are visible.
- Use: SYNC-3 proof and governing reference for a sparse short task, user bubbles, assistant plain text, interrupted-history spacing, and task title truncation.

### `chatgpt-active-goal-1800x1130.png`

- Absolute path: `/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-active-goal-1800x1130.png`
- Captured: `2026-07-12T17:50:29-0700`
- SHA-256: `2fd16fd4e925a793bde91fa432ab22ec51f460843a10cfa57832445ad8d7dfbd`
- Source native thread: `019f58d5-7466-7463-953d-e31e105ee96b`
- Source task name: `Build DevHub parity`
- State: active persistent goal after about 33 minutes, task working for 3m12s in the current turn; commentary, tool activity summaries, image inspection, file edits, diff summary, subagent completion, web source inspector, goal card, and stop control are visible.
- Use: governing reference for active/long-running task presentation, tool-activity rows, selected-task spinner, diff-summary pill, goal lifecycle card, Source/Subagent inspector sections, active composer model/mode/stop controls, and dense scroll anchoring.

### `chatgpt-empty-task-1800x1130.png`

- Absolute path: `/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/chatgpt-empty-task-1800x1130.png`
- Captured: `2026-07-12T19:16:19-0700`
- SHA-256: `3913db2bcd65db2e343f9bd8522b6ae64ef88c9c623f593d78decbb260527244`
- Capture pixels: `3824x2484`, including active-window shadow; content rectangle is exactly `3600x2260` pixels at `(112,76)`, corresponding to the same `1800x1130` logical window.
- Source native thread: `019f5942-8751-7503-91de-d87f7185a04d`
- Source task name: `DevHub reference empty task`
- State: provider-native thread exists but has zero turns; blank central canvas, resting composer, disabled send arrow, active-window rail, title/header, and compact Environment inspector are visible.
- Use: governing reference for an empty existing task, intentional negative space, disabled-send state, and active-window rail vibrancy. It does not show the global pre-task project/provider setup flow.
- Cleanup: navigated back to the active goal, deleted the known scratch thread through `thread/delete`, verified `thread/read` rejection, and removed the scratch repository. No billable turn was used.

### `devhub-current-search-results.png` — preservation reference, not a Codex reference

- Absolute path: `/Users/ronak/Documents/01-code/active/claude-ui/.planning/devhub-codex-parity/reference-captures/devhub-current-search-results.png`
- Captured: `2026-07-13T02:54:28Z`
- SHA-256: `690a419149dcc6b4b73e210548ab8b0787411f231ec9256438103591f4f8971f`
- Capture pixels: `1280x720`.
- Source: current unmodified DevHub browser surface at `http://localhost:5173/`, captured with the in-app Browser after opening the existing `Search all sessions…` dialog and querying `DevHub`.
- State: populated global Search results with scope and date facets, highlighted snippets, keyboard-selected row, and navigate/open/close instructions.
- Use: preservation authority for the existing functional Search-results contract required by concept 8. It does not supply Codex visual tokens and is not evidence of first-party Codex Search behavior. Production combines this functional contract with the measured Codex shell language and keeps Search distinct from Commands.
- Verification/cleanup: the populated result DOM was inspected before capture, the saved PNG was reopened at original detail with `view_image`, the in-app browser tab was finalized, and the temporary DevHub server/listeners were stopped.

## SYNC-3 finding

The installed first-party app successfully navigated to and rendered the DevHub-created app-server thread by native ID. Both persisted turns were visible. Therefore native GUI visibility is **verified by direct navigation for build 26.707.51957 (5175)**.

The task was not visible in the captured sidebar project groups, and Computer Use could not operate search or project navigation. Standard sidebar discovery is therefore **not proven**, not failed. DevHub must not claim more than direct-address visibility for this build.

## Measured wide-shell geometry

Pixel sampling used the exact `3600x2260` content rectangle and 2x backing scale. Measurements below are logical units.

| Surface | Measured geometry | Flat interior color / shape evidence |
|---|---:|---|
| Window | `1800x1130` at reported `(0,39)` | Prior inactive captures are `3736x2396` with content origin `(68,52)`; active empty capture is `3824x2484` with content origin `(112,76)`. |
| Rail/content split | central region starts at `x=273` | Inactive rail fill `#202020`; active-window vibrancy resolves mainly to `#404040`; separator at `x=272` is `#424242` in the inactive capture. |
| Task header | `x=273..1799`, `y=1..45`; divider at `y=46` | `#181818`; one-pixel logical divider. |
| Thread canvas | `x=273..1799`, `y=47..1128` | `#181818`; open canvas with no enclosing card. |
| Transcript/composer column | `x=510..1245`, width `736` | Content and composer share the same right/left alignment. |
| Resting composer | `(510,1016)`, `736x98`; bottom gutter `16` | `#2d2d2d`; top edge inset `22` pixels at the first fill row, consistent with an approximately 20-22 radius. |
| Environment inspector | `x=1484`, width `300`, top `59`, right gutter `16` | `#2d2d2d`; height follows content: `199` sparse/empty, `282` completed, `396` active. Top edge inset `16`, approximately 16 radius. |
| Selected task row | `(8,489)`, `256x30` in completed capture | `#313131`; first-row inset `9`, approximately 8-9 radius. |
| User bubble | `x=680..1245`, width `566`; heights `60` and `82` | `#242424`; top-row inset `12`, approximately 12 radius; right-aligned to transcript column. |
| Active diff summary | `(789,939)`, `178x33` | `#262626`; capsule radius approximately half-height. |
| Active goal card | `(531,982)`, `694x34` immediately above composer | Main `#262626`, lower six-pixel seam `#252525`; top inset `18`. |

Measured dominant semantic candidates, not yet locked tokens:

- canvas/header `#181818`;
- inactive rail `#202020` and active rail material/vibrancy near `#404040`;
- elevated surface/composer/inspector `#2d2d2d`;
- user bubble `#242424`;
- selected row `#313131`;
- compact active controls `#262626`;
- primary text frequently `#ffffff` or `#dedede`;
- secondary/disabled text commonly `#969696` and `#676767`.

The active/inactive rail difference is real window-state behavior, not a theme inconsistency. DevHub should preserve an active-state/material token rather than hard-code one sampled rail color. Typography, icon strokes, focus rings, and motion still require design-lock confirmation because static screenshots cannot expose font metadata or transition timing.

## Observable interaction/visual findings

1. Product identity is restrained: a plain `Codex` wordmark, monochrome Lucide-like icons, and no decorative gradients or cards.
2. The left rail is an open list, grouped by Projects and Tasks; selection is a single low-contrast rounded row.
3. The central transcript is open canvas, not a card stack. User text is in a compact raised bubble; assistant prose is unframed.
4. The right Environment inspector is one rounded elevated surface containing compact rows rather than separate cards.
5. Provider/model/permission controls live inside the composer footer. `Full access` is the only strong warm accent in the sparse-task capture.
6. The composer is bottom anchored and stable between dense and sparse transcripts.
7. Task title is left-aligned in a thin header and truncates before the overflow menu.
8. The sparse task shows large intentional negative space rather than invented empty-state content.
9. Active work does not replace the transcript with a separate progress dashboard: commentary and compact tool rows remain in the same vertical narrative.
10. Persistent goal state appears as a narrow card directly above the composer, with elapsed time and compact edit/pause/delete/disclosure actions.
11. Active composer state swaps the send arrow for a high-contrast stop square while keeping layout stable; the task row uses a quiet circular spinner.
12. File-change summary is a single centered compact control above the goal card, not a permanent dashboard widget.

## Unavailable or conditional reference states

The Claude provider gate is now clear. The following first-party states remain unavailable because Computer Use cannot control this app build; they are disclosed in the single approval package and must not be described as directly observed:

- launch and global pre-task/new-task setup (the empty existing native task is captured);
- rail hover/context/search/collapse/resize;
- setup pickers and permission modes;
- streaming start/midpoint animation, plan expansion, raw terminal, full diff, browser, and artifacts (active commentary/tool summaries are captured);
- approval and user-input flows;
- retry/reconnect/error/cancel indicators;
- rename/archive/fork menus, settings, command palette, keyboard/focus labels;
- narrow/minimum-width/PWA behavior;
- animation start/mid/end, reversal, and reduced motion.

ImageGen may preserve the measured shell and propose clearly labeled DevHub-only/provider-neutral additions. It must not claim that unavailable Codex transient behavior was observed; those states use the measured shell plus documented capability semantics and remain subject to user approval.
