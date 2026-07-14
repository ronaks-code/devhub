# M4 final Computer Use interaction trace

Date: 2026-07-13

Target: the deterministic Anthropic fixture at `http://127.0.0.1:5173/library?tab=chat` in Google Chrome. Authentication remained the literal synthetic token `m3-fixture-token`; no provider credential or private transcript was entered or captured.

## Trace

1. Computer Use read the active `Anthropic · Claude` task surface and its named task history, selected-task region, transcript, status, composer, and interrupt control.
2. It clicked `New native Claude task`. The accessibility state exposed all repaired setup copy:
   - `Claude model selection unavailable until runtime support is verified.`
   - `Permission mode` with exactly `Manual`, `Accept edits`, and `Plan`.
   - `First message (required)`.
   - `Provider is fixed after creation. Fork to another provider to continue there.`
   - disabled `Create task` before the required fields were populated.
3. It selected `Manual`, then `Accept edits`, proving both values through the live popup and selected-value accessibility state. The original setup capture proves the selected `Plan` value.
4. It entered synthetic cwd `/workspace/devhub-fixture` and synthetic first message `Verify exact copy and lifecycle evidence.`. `Create task` changed from disabled to enabled.
5. It clicked `Create task`. The fixture produced `Task created with Anthropic · Claude.`, a completed synthetic plan/activity/result, and the selected task-history row became `idle`.
6. It selected the existing idle task and observed the exact composer placeholder `Ask for follow-up changes`.
7. It selected the active release-verification task and clicked `Interrupt active Claude turn`. The correlated fixture receipt changed the row to `idle` and exposed exact `Cancelled by you` text in both status and transcript.
8. It rechecked the installed first-party app. Bundle-ID selection was ambiguous because `/Applications/ChatGPT.app` and a mounted installer shared `com.openai.codex`; targeting `/Applications/ChatGPT.app` returned the unchanged host-policy denial: `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` No bypass was attempted.

## Saved screenshots

- `computer-use-chrome-create-exact-copy.png` — setup with `Plan`, model disclosure, required message, provider lock, and disabled creation.
- `computer-use-chrome-create-manual.png` — selected `Manual`.
- `computer-use-chrome-create-accept-edits.png` — selected `Accept edits`.
- `computer-use-chrome-create-ready.png` — both required fields populated and creation enabled.
- `computer-use-chrome-completed-exact-copy.png` — created task, completed transcript, and idle history row.
- `computer-use-chrome-idle-exact-copy.png` — idle-task composer state.
- `computer-use-chrome-cancelled-by-you.png` — strict interrupt result and idle history row.

The fixture and Vite listeners were stopped immediately after Browser and Computer Use evidence capture; ports `8787` and `5173` were verified free.
