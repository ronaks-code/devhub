# M3 Computer Use evidence

Date: 2026-07-13 (America/Los_Angeles)

Tool path: `@oai/sky` through the persistent Node REPL. No Python process was invoked.

## Attempt

- `list_apps()` succeeded and reported the installed first-party app as running:
  - bundle id: `com.openai.codex`
  - display name: `ChatGPT`
  - running: `true`
- `get_app_state({ app: "com.openai.codex" })` was then attempted before any click or mutation.

## Result

Computer Use rejected the app before returning state:

```text
Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.
```

This is an explicit host-policy blocker. No Computer Use screenshot, accessibility tree, menu interaction, transient request state, or current first-party narrow-layout evidence is claimed. Browser/IAB evidence is used only for DevHub's local web implementation and does not substitute for first-party app control.
