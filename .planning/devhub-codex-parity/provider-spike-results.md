# Provider Spike Results

## Executive result

- Codex mandatory native lifecycle: **PASS for installed CLI 0.144.1**, with safety/compatibility findings below.
- Claude mandatory native lifecycle: **PASS for selected installed CLI 2.1.207**, with Agent SDK 0.2.116 used only as a resume/control reference client and official session-helper source, under API-key auth in an isolated native config.
- M1 overall provider gate: **PASS** for native start, stream, persistence, provider-process restart, same-ID resume, and interruption on both providers. Unexercised approval/input variants remain explicitly capability-gated.

## Codex schema generation

Repository-resident stable bindings:

- `.planning/devhub-codex-parity/provider-bindings/codex-0.144.1/json-schema` - 267 files.
- `.planning/devhub-codex-parity/provider-bindings/codex-0.144.1/typescript` - 598 files.
- Size: 5.8 MiB.
- `SHA256SUMS` digest: `261ceff557260a6ad05fb5a429bce30991d0e962e5f57fe2a4cad3058cd3f63e`.
- Codex binary digest: `29915529b97697def1a957b0505e770aa6a45744435d62fc263e98d7619e167a`.
- Compact stable fallback: `provider-bindings/fallback/protocol.ts`.

Generated TypeScript passes:

```bash
pnpm exec tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2022 --skipLibCheck \
  .planning/devhub-codex-parity/provider-bindings/codex-0.144.1/typescript/index.ts \
  .planning/devhub-codex-parity/provider-bindings/fallback/protocol.ts
```

It does not pass NodeNext unchanged because the generator emits extensionless relative imports. Production code must either use bundler resolution, post-process a copied generated surface reproducibly, or import a compact adapter-owned fallback; it must not silently edit generated files.

## Codex live probe

Scratch root: `/private/tmp/devhub-codex-m1-20260713T003719Z`.

Billable turn count: exactly 2.

### Handshake

- Pre-initialize `thread/list`: rejected with `Not initialized`.
- `initialize` with `{name:"devhub",title:"DevHub",version:"0.0.1"}`: passed.
- `initialized`: sent.
- Duplicate `initialize`: rejected with `Already initialized`.
- Returned home: `/Users/ronak/.codex`.
- Returned platform: `unix` / `macos`.
- Stderr: 0 bytes for successful phase 2 and capability census.

### Turn 1 - complete and persist

- Native thread: `019f58e9-8cde-7cb2-9a3a-444e3dc54967`.
- Native turn: `019f58e9-94c1-7462-8dd4-df2e965af075`.
- Tagged name: `DevHub M1 Codex DEVHUB_CODEX_M1_20260713_003719Z`.
- Assistant returned the exact nonce and used no tool.
- Final status: `completed`.
- `thread/read includeTurns:true`: one full persisted turn.

The first harness run exited after the completed turn because it asserted that `sourceKinds:["appServer"]` would list the task. Installed 0.144.1 returned `source:"vscode"` for the honest unknown DevHub client, so the explicit appServer-only list was empty. The turn was not replayed; its native ID was recovered from captured envelopes.

### Restart, resume, turn 2, and interrupt

- A new app-server process listed/read the same task when current observed `vscode` plus future `appServer` sources were requested.
- `thread/resume` returned the same native ID.
- One persisted turn was present before resume.
- The resumed model streamed the prior nonce as 15 fine-grained `item/agentMessage/delta` notifications.
- Native turn `019f58eb-2686-7671-8912-65901a960135` was interrupted through `turn/interrupt`.
- Final status: `interrupted`; duration 3,309 ms.
- `thread/read` contained two turns after interruption.

### Fork/archive

- Fork ID: `019f58eb-338b-7953-9c4e-f3913894d29b`.
- Initial fork response included `forkedFromId` pointing at the source.
- Archive list and unarchive both succeeded.
- Installed behavior diverged from current documentation expectations: the fork's `sessionId` equaled its own ID, and archive/list/unarchive later returned `forkedFromId:null`. DevHub must keep additive fork provenance.

### Safety findings

1. Start returned `workspaceWrite`, but resume without explicit overrides returned `dangerFullAccess`. DevHub must pass and verify the intended policy on every resume and refuse a silent elevation.
2. Unknown-client source classification is `vscode`, not `appServer`; a narrow appServer filter loses DevHub-created tasks on this installed build.
3. Startup hooks created a scratch `AGENTS.md` containing local memory context. Provider hooks are real external writers; writer-revision checks must include hook-created changes.
4. Notifications observed beyond the compact fallback include `remoteControl/status/changed`, `mcpServer/startupStatus/updated`, `thread/status/changed`, `thread/goal/cleared`, `hook/started`, and `hook/completed`. Unknown notifications must remain forward-compatible diagnostics.
5. No live server-request approval/input occurred. Installed permission/input features are disabled or unproven; capability remains off.

### Read-only capability census

- Account type: API key; token stayed backend-only.
- Models: 7.
- Permission profiles: read-only, workspace, danger-full-access.
- Skills/hook calls: passed.
- Apps/plugins: enabled surfaces, current count 0.
- MCP status: 9 configured servers.
- Config/read and requirements/read: passed; only key names were recorded.
- Experimental feature census: 92 rows with stage/enabled state.

## Codex SYNC-3 result

Required Computer Use calls by bundle ID and display name both failed before state capture with: `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.`

The bundled screenshot fallback enumerated and captured the installed window. The purpose-built Codex app navigator then opened native thread `019f58e9-8cde-7cb2-9a3a-444e3dc54967`; a second capture visibly rendered both app-server turns.

Status: `verified-current-build` for direct native-ID navigation on app build 5175. Standard sidebar/project discovery remains unproven because the tagged scratch project was absent from the visible rail and interactive search was unavailable.

Evidence: `reference-capture-manifest.md` and `reference-captures/chatgpt-devhub-sync3-thread-1800x1130.png`.

After capture, both known disposable native IDs were deleted through app-server `thread/delete`. Subsequent `thread/read` calls failed for both IDs, and no rollout/database file was directly edited. Sanitized evidence is in `probe-evidence/codex-0.144.1/cleanup-summary.json`.

## Claude native CLI and Agent SDK probe

Retained evidence: `probe-evidence/claude-2.1.207-sdk-0.2.116/`.

Ephemeral scratch root: `/private/tmp/devhub-claude-m1-20260713T015750Z` (removed after evidence capture).

Versions:

- Installed CLI: `/Users/ronak/.local/bin/claude`, `2.1.207`, SHA-256 `1397a062c6889675055e3314dd956376ac51262a7734ad9e819c26975d71547a`.
- Current official Python Agent SDK: `0.2.116`, run with Python `3.11.15` and explicit `cli_path` pointing at that installed CLI.
- Requested/init model: `claude-haiku-4-5-20251001`, effort low. Direct turn 1 actually emitted and billed `claude-sonnet-5`; the SDK extra turn emitted Haiku. Reliable model selection is therefore not claimed.

### Authentication

The initial zero-turn audit correctly found that the default CLI login is `claude.ai` and that an empty synthetic `CLAUDE_CONFIG_DIR` has no copied credential. A follow-up filename-only search found an ignored local environment file containing an Anthropic-shaped API key. The value was loaded in memory only and never printed, sourced as shell code, copied, or retained.

Under the isolated config, redacted `auth status` returned:

```json
{
  "loggedIn": true,
  "authMethod": "api_key",
  "apiProvider": "firstParty",
  "subscriptionType": null,
  "email_present": false
}
```

This satisfies Anthropic's documented third-party API/cloud authentication requirement without routing the user's Claude subscription OAuth.

### Turn 1 - direct installed CLI

- Started the installed CLI as a persistent stream-JSON child with partial and hook events, replayed user messages, all three setting sources, plan permissions, no tools, a local synthetic plugin, and a bounded budget.
- Native session: `df6288da-e4f7-48b1-a7ab-323c1e4c92fe`.
- Stream contained granular message events and the exact synthetic nonce.
- Three `hook_started` and three `hook_response` events proved user, project, and local hook loading.
- `system/init` exposed 38 slash commands, the local plugin, five default/configured agents, model, permission mode, and the native UUID.
- Installed model mismatch: `system/init.model` was `claude-haiku-4-5-20251001`, while `message_start`, final assistant metadata, and `result.modelUsage` all identified `claude-sonnet-5`. DevHub must record requested/init/actual turn model separately and gate a model picker claim until the adapter explains or detects this divergence.
- Result: `success`, same UUID, one provider turn, 2.683 seconds, `$0.02737395`.
- The child then exited; no desktop app was involved.

### Provider-process restart and turn 2 - Agent SDK resume

- Official `list_sessions()` and `get_session_messages()` discovered/read the CLI-created session after child exit.
- A new `ClaudeSDKClient` process launched the same installed CLI with `resume` and the same cwd/config home.
- It returned and extended the same UUID.
- Without receiving the value again, the model recalled the prior nonce and passed it to `mcp__devhub_probe__echo`, proving native context continuity and in-process SDK MCP execution.
- The model then ran the requested safe `sleep 30`. Claude classified this harmless command as auto-approved, so no permission callback fired and the planned permission-triggered interrupt did not arm. The native second turn still completed and persisted, bringing official helper history from two to nine messages.
- The initial harness raised after that auto-approval outcome and did not retain turn-2 SDK stream/control files. Same-ID resume, MCP input, Bash invocation, completion, and history growth are evidenced through the official helper's synthetic native-message view, not a reconstructed claim about missing control envelopes.

### One justified extra lifecycle turn - real approval and interrupt

The goal permits one third billable turn for a specific unresolved lifecycle state. It was used only because the safe command's installed permission classifier bypassed the callback.

- The same native UUID resumed again.
- A scratch-only `Write` generated a real SDK `can_use_tool` control request with a provider tool-use ID and permission suggestion.
- The callback allowed only the exact expected path and bytes; the resulting file contained exactly `approved\n`.
- An SDK `PreToolUse` hook observed the subsequent exact `sleep 60` call and armed interruption independently of permission classification.
- `client.interrupt()` received a control acknowledgement; no `sleep 60` process remained.
- Installed terminal representation: `error_during_execution`, `stop_reason:"tool_use"`, same UUID, 2.791 seconds. The acknowledged interrupt plus correlated hook/tool lifecycle distinguishes user cancellation from an upstream failure.
- Cost: `$0.01633875`.
- The 2.791-second figure is total turn duration, not interrupt-acknowledgement round-trip latency. The interrupted session was not model-resumed before cleanup.

Total billable count: 3, comprising the two normal smoke turns plus one explicitly permitted unresolved-lifecycle turn.

### Session helpers, fork, and cleanup

- Official helpers listed/read the session, persisted a rename, and forked it to `36c32267-a82a-4b98-a15e-8e2913a7055d`.
- Source message count stayed 15 before and after fork; the fork inherited 15 messages.
- The helper-created fork was not continued with a model turn; only native creation, inherited history, and source immutability are proven.
- Official `delete_session()` removed both source and fork. The scratch session list was empty afterward.
- No native transcript JSONL was directly opened for mutation or used as an application parser.
- Retained evidence has no `sk-ant-*` string and was SHA-256 inventoried.

### Selection and capability gates

The persistent installed CLI is selected as the execution transport. Agent SDK `0.2.116` proved that it can resume the same native UUID and is approved as a reference client plus official session-helper source, but the program's stricter SDK-selection gate also requires live skill, subagent, and background-work preservation. Those were not proven, and `--bg` is not the same `-p` persistent JSON supervisor, so SDK execution is not selected by inference.

Direct selected-transport proof: API-key auth, native CLI start, stream, persistence, settings-source hooks, plugin/skill/agent inventory, and clean shutdown.

Provider-contract/interoperability proof under SDK reference ownership: process restart, same-ID resume and nonce continuity, MCP, real file-approval allow, hook callback, interrupt acknowledgement, plus official-helper list/read/rename/fork creation/delete.

Still capability-gated in the selected raw CLI adapter: raw multi-query longevity, raw resume/control correlation, approval responses, interrupt, post-interrupt resume, fork continuation, reliable model selection, permission deny/cancel/modify/timeout variants, `AskUserQuestion`, MCP elicitation responses, live skill invocation, subagent execution, and background supervision. Claude first-party GUI visibility remains unsupported by the documented picker contract.
