# ADR: Use the Installed Claude CLI as a Persistent Native Transport

Status: accepted for M4 implementation, behind the `persistentClaude` feature flag.

## Context

DevHub needs a supported Claude runtime with native session identity and storage, persistent bidirectional streaming, restart/resume/fork, settings, skills, plugins, hooks, MCP, agents, permissions, and interruption. Anthropic requires products built on Claude Code/Agent SDK to use API-key or supported cloud-provider authentication rather than route a user's Free/Pro/Max OAuth credential.

The machine's default Claude login is `claude.ai`, but a local Anthropic API key was subsequently found in an ignored environment file. Its value was never printed, copied into the repository, or persisted in evidence. Under an isolated `CLAUDE_CONFIG_DIR`, Claude reported API-key, first-party-provider auth.

Authority: <https://code.claude.com/docs/en/legal-and-compliance>

## Decision

Use the installed Claude CLI `2.1.207` as DevHub's primary Claude execution transport, launched by absolute path with one long-lived stream-JSON child per active native task.

```text
/Users/ronak/.local/bin/claude -p
  --input-format stream-json
  --output-format stream-json
  --verbose
  --include-partial-messages
  --include-hook-events
  --replay-user-messages
  --setting-sources user,project,local
```

The adapter will add explicit model, effort, permission, tool, plugin, MCP, budget, cwd, and resume arguments per task. It will send newline-delimited user/control frames over stdin, correlate `control_request`/`control_response` IDs, retain bounded raw envelopes before normalization, and close stdin/drain stdout for graceful idle shutdown.

Production requirements:

1. Require API-key, Bedrock, Vertex, or Foundry authentication. Never silently fall back to `claude.ai` OAuth.
2. Key each runtime by canonical `CLAUDE_CONFIG_DIR` plus native session UUID; pass the selected home and absolute CLI path explicitly because GUI apps do not inherit shell-dotfile `PATH` reliably.
3. Capture the UUID and capabilities from `system/init`; persist no alternate authoritative transcript.
4. Handle native initialize, interrupt, permission, hook, MCP, cancellation, and future unknown control/event envelopes with bounded correlation and timeouts. Timeout never accepts a permission.
5. Use official Agent SDK session helpers for list/read/rename/fork/delete when they support the selected `CLAUDE_CONFIG_DIR`; do not add another direct transcript parser or write transcript JSONL manually.
6. Preserve user/project/local settings plus provider-native skills, plugins, hooks, MCP, agents, and permission modes. Capabilities not proven end to end remain false.
7. Retain the existing process-per-turn adapter as a visibly limited fallback until M4 side-by-side parity passes. Never fall back silently after a persistent-transport failure.

The live resume, permission, MCP, hook, and interrupt controls were exercised while the Agent SDK reference client owned the installed CLI child. They prove the native provider contract, not DevHub's future raw control implementation. M4 must reproduce raw multi-query longevity, `--resume`, permission responses, and interrupt correlation before `persistentClaude` can be enabled.

## Why the Agent SDK is not selected yet

Agent SDK `0.2.116` was evaluated under the same API key with explicit `cli_path` pointing at the installed CLI. It successfully resumed a direct-CLI-created native UUID, preserved native storage and settings, called SDK MCP, handled hooks and a real permission request, acknowledged interrupt, and supplied official list/read/rename/fork/delete helpers.

That proves compatibility and makes the SDK a useful reference client/helper library, but it does not satisfy this program's stricter SDK-selection gate. The live spike did not invoke a configured skill or subagent and did not prove restart-safe background work. The installed `--bg` path is not the same persistent JSON supervisor and cannot be combined with `-p`. Because every listed SDK-selection capability must be live-proven, DevHub selects the persistent CLI instead of assuming parity.

Agent SDK execution can be reconsidered only after a separate bounded proof covers skill invocation, agents/subagents, and background supervision without weakening native identity, settings, permissions, or restart behavior.

## Live proof

Evidence: `probe-evidence/claude-2.1.207-sdk-0.2.116/summary.json` and its sanitized JSONL/control companions.

- Direct CLI turn 1 used persistent stream JSON, emitted native session `df6288da-e4f7-48b1-a7ab-323c1e4c92fe`, streamed a synthetic nonce, completed successfully, and persisted.
- After the CLI exited, official SDK helpers listed and read that same UUID.
- A new process, launched through the SDK as a reference client over the installed CLI, resumed the same UUID, recalled the prior nonce, called the in-process SDK MCP echo tool, and extended the same native history. The initial harness did not retain turn-2 SDK stream/control files after its auto-approval assertion failed; this continuity claim comes from the official helper's synthetic native-message view.
- User, project, and local setting sources each executed a distinct harmless scratch hook during the direct CLI turn. The justified extra turn separately retained SDK `PreToolUse` hook evidence. Init exposed skills, configured/default agents, the local probe plugin, permission mode, tools, capabilities, and provider version.
- One justified extra lifecycle turn was used because Claude correctly auto-approved the harmless `sleep 30`, so the first interrupt trigger never armed. The extra turn produced a real `Write` permission request; the reference client returned allow with the exact scratch-only input; the write matched byte-for-byte; a `PreToolUse` hook observed `sleep 60`; and the installed CLI acknowledged a native interrupt control request. No sleep process remained.
- Official helpers renamed the source, forked it to a new UUID without changing the source message count, read inherited fork history, and deleted both probe sessions. The scratch session list was empty afterward.
- No credential-shaped string exists in retained evidence, and no provider session file was directly edited.

Billable count: three turns. The goal permits one third turn for a specific unresolved lifecycle state; it was used only for approval/interrupt after native auto-approval behavior was observed.

Exact limitations: the SDK did not start a fresh session, a single SDK client was not exercised across multiple user queries, the interrupted session was not model-resumed before cleanup, and the helper-created fork was not continued with another model turn. Interrupt acknowledgement round-trip latency was not measured separately from total turn duration. Direct turn 1 also reported Haiku in `system/init` but emitted and billed Sonnet 5, so reliable model selection is not proven. None of these is presented as proven.

## Capability policy

Provider-contract evidence supports planning for native start, stream, persistence, restart, same-ID resume, official-helper list/read/rename/fork creation/delete, hooks, MCP, permission allow, and interrupt. Only direct CLI start/stream/persist plus settings/plugin/skill/agent inventory were exercised through the selected raw transport shape; the other controls were exercised under SDK reference ownership.

Therefore every mutation/control beyond direct start/send remains false in the product until M4 reproduces it through DevHub's persistent CLI peer. In addition, keep these false until deterministic fixtures or a bounded live state proves them end to end:

- permission deny, cancel, modification, and timeout semantics beyond the proven allow path;
- `AskUserQuestion` and MCP elicitation response bridges;
- live skill invocation, subagent execution, and background-agent supervision;
- reliable requested-model enforcement and requested/init/actual model reconciliation;
- first-party Claude GUI visibility.

Claude `-p` and Agent SDK sessions are excluded from the first-party session picker by the documented product contract, so SYNC-3 is `unsupported`, not emulated.

## Consequences

- The selected path has the smallest semantic distance from Claude Code's native CLI behavior and does not depend on unproven SDK feature preservation.
- DevHub must implement the installed CLI's bounded bidirectional control protocol carefully instead of relying on a one-shot wrapper.
- Official SDK helpers remain valuable for supported session discovery and mutation; execution ownership remains the persistent CLI child.
- A native interrupt can terminate with an error-class result. UI state must distinguish acknowledged user cancellation from provider failure using the correlated control response and lifecycle events rather than result subtype alone.
