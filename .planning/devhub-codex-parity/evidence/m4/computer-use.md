# M4 Computer Use evidence

Date: 2026-07-13

Computer Use was attempted only after Browser/IAB evidence existed.

## Results

- `@oai/sky` listed both Google Chrome and `com.openai.codex`.
- First-party Codex state capture returned the exact host-policy error: `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` This remains a conditional first-party evidence blocker, not a pass.
- Computer Use successfully controlled DevHub in Google Chrome: it read the access-token screen, entered the literal fake fixture token, dismissed onboarding/password prompts, navigated to Chat, and exposed the Claude task surface through the accessibility tree.
- `computer-use-chrome-devhub.jpg` (`768x965`) shows the active Anthropic task, plans, shell activity, unsupported command approval, diff summary, usage, stable composer, and visible `Anthropic · Claude` identity.
- The Chrome accessibility state exposed named Home/Browse/Chat/Ops/Inbox/Dashboard, Search, Commands, the provider-native task surface, and the focused control. No real provider credential was entered or captured.

## Classification

| Surface | Status | Evidence |
| --- | --- | --- |
| DevHub web UI through Computer Use | verified for this deterministic M4 workflow | `computer-use-chrome-devhub.jpg` plus accessibility-state output |
| First-party Codex app through Computer Use | blocked by host policy | exact error above |
| Packaged DevHub desktop | not yet available | M8 gate; Browser/Chrome evidence does not substitute |

Temporary fixture/Vite listeners on ports `8787` and `5173` were stopped after capture.
