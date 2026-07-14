# M4 Computer Use evidence

Date: 2026-07-13

Computer Use was attempted only after Browser/IAB evidence existed.

## Results

- `@oai/sky` listed both Google Chrome and `com.openai.codex`.
- A fresh first-party check found the bundle ID ambiguous because the installed app and mounted installer shared it. Targeting `/Applications/ChatGPT.app` returned the exact host-policy error: `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` This remains a conditional first-party evidence blocker, not a pass.
- Computer Use successfully controlled DevHub in Google Chrome through setup, required-field gating, synthetic creation/completion, idle composer, and strict interrupt flows. The full action/state trace is `computer-use-exact-copy-trace.md`.
- Fresh exact-copy screenshots prove selected `Plan`, `Manual`, and `Accept edits` values; exact model/provider-lock/required-message copy; disabled-to-enabled creation; an idle completed row; `Ask for follow-up changes`; and receipt-correlated `Cancelled by you`.
- `computer-use-chrome-devhub.jpg` remains the earlier active-state overview. The new `computer-use-chrome-*.png` files are authoritative for the repaired copy and interaction outcomes.
- The Chrome accessibility state exposed named navigation, the provider-native task surface, exact controls, status, transcript, and history-row states. No real provider credential was entered or captured.

## Classification

| Surface | Status | Evidence |
| --- | --- | --- |
| DevHub web UI through Computer Use | verified for the deterministic M4 setup/create/complete/idle/interrupt workflow | `computer-use-exact-copy-trace.md` plus fresh `computer-use-chrome-*.png` evidence |
| First-party Codex app through Computer Use | blocked by host policy | exact error above |
| Packaged DevHub desktop | not exercised or verified in this M4 pass | M8 gate; Browser/Chrome evidence does not substitute |

Temporary fixture/Vite listeners on ports `8787` and `5173` were stopped after capture.
