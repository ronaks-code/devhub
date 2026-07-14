# Provider Capability Matrix

Captured against Codex CLI `0.144.1`, ChatGPT/Codex app `26.707.51957 (5175)`, Claude Code CLI `2.1.207`, Claude Agent SDK `0.2.116`, and Claude app `1.17377.2` on macOS `26.5.1 (25F80)`.

Status vocabulary:

- `verified`: live or direct installed-runtime proof exists for this build.
- `schema-only`: installed schema/help exposes it, but no live proof exists.
- `capability-gated`: UI must not present it as functional until live proof exists.
- `unsupported`: official provider contract says the capability is unavailable.
- `degraded-fallback`: read-only parser/cache behavior only.

| Capability | OpenAI / Codex app-server | Anthropic / Claude | DevHub presentation rule |
|---|---|---|---|
| Runtime ownership | `verified`: real `codex app-server --stdio`; native thread IDs and rollouts. | `verified`: direct persistent CLI created the native UUID; an SDK reference client later launched that same installed CLI and preserved the UUID/session store under isolated `CLAUDE_CONFIG_DIR`. Persistent CLI, not SDK execution, is selected. | No fake provider; native IDs remain authoritative. |
| Initialize/handshake | `verified`: pre-init rejected, honest `devhub` initialize succeeded, duplicate init rejected. | `verified`: direct CLI and SDK processes emitted `system/init`; SDK initialize exposed version, capabilities, skills, agents, plugins, tools, and the resumed native UUID. | Record provider/version-specific init metadata; do not impersonate first-party clients. |
| List/history | `verified` with caveat: explicit list works only when `vscode` is included for this unknown client; installed start returned `source:"vscode"`, not `appServer`. | `verified`: official SDK `list_sessions()` discovered the CLI-created UUID after process exit and after SDK resume. | Codex adapter includes observed plus future source kinds; Claude uses official helpers, not a new parser. |
| Read | `verified`: `thread/read includeTurns:true` returned native history. | `verified`: official `get_session_messages()` read 2, then 9, then 15 native messages across lifecycle phases. | Native read wins; legacy parser is degraded fallback only. |
| Start | `verified`: non-ephemeral native thread and completed turn. | `verified`: direct persistent CLI created and completed a native API-key-backed session. | Provider remains locked at creation. |
| Stream | `verified`: agent message arrived as 15 granular deltas. | `verified`: direct CLI and SDK produced partial stream events plus final authoritative messages/results. | Preserve granular native deltas; coalesce only at browser fan-out. |
| Persist | `verified`: completed native turn survived app-server exit. | `verified`: CLI-created native history remained listable/readable after child exit and was extended by a new SDK child. | DevHub stores no authoritative transcript copy. |
| Restart | `verified`: new app-server process rediscovered the same task. | `verified`: a new SDK process launched the installed CLI after the direct CLI child exited. | Reconcile native state before resuming writes. |
| Resume | `verified`: same native Codex thread ID resumed and recalled prior nonce. Safety caveat: resume without overrides reported `dangerFullAccess` after start used `workspace-write`. | `verified`: same UUID resumed; prior nonce was recalled without restating it and passed to an SDK MCP tool. | Codex must pass/verify explicit policy; Claude must pass explicit home/cwd/mode/model. |
| Interrupt | `verified`: second native turn completed as `interrupted` after streamed continuity. | `verified`: `client.interrupt()` returned a control acknowledgement during `sleep 60`; no sleep remained. Installed result subtype was `error_during_execution`. | Stop is real for both; Claude UI correlates acknowledged user cancellation instead of treating subtype alone as failure. |
| Steer | Stable schema/help; not live-proven within two-turn budget. | Installed CLI stream input may support additional messages; not live-proven. | `capability-gated`. |
| Fork | `verified`: new native ID with initial `forkedFromId`; caveat: `sessionId` was the fork ID and archive/unarchive later lost `forkedFromId`. | `verified` creation only: official SDK `fork_session()` created a new UUID with 15 inherited messages and left source count unchanged; fork continuation was not exercised. | Persist DevHub additive provenance; gate Claude fork continuation until the vertical slice. |
| Rename | `verified`: `thread/name/set` and notification. | `verified`: official `rename_session()` persisted the custom title. | Provider-specific capability, native where supported. |
| Archive/unarchive | `verified` for fork. | No comparable installed CLI archive contract identified. | Claude archive may be local additive metadata and must be labeled local. |
| Command approval | Stable Codex server-request schema; live request not exercised. Installed `exec_permission_approvals` is under-development and disabled. | SDK permission callback is real, but the safe Bash command was natively auto-approved; command-request allow/deny/cancel remains unproven. | `capability-gated`; never simulate. Timeout never accepts. |
| File approval | Stable Codex schema; not live-proven. | `verified` allow path: scratch `Write` produced a correlated `can_use_tool` request, exact allow response, and byte-exact file. Deny/cancel/timeout remain gated. | Advertise only Claude allow after adapter fixtures cover stale/timeout behavior; Codex remains gated. |
| User input | Schema present; installed `default_mode_request_user_input` is under-development and disabled. | SDK/CLI contracts exist; no live `AskUserQuestion` response proof. | `capability-gated`. |
| Permission request tool | Schema present; installed feature disabled. | `verified` at provider contract level: SDK's stdio reference bridge delivered tool name/input, provider tool-use ID, suggestion, and allowed response from the installed CLI. DevHub deterministically handles only exact internal Write/Edit controls fail-closed; live selected-wrapper response proof remains unavailable. | Keep capability false until the selected persistent CLI lifecycle gate passes. |
| MCP elicitation | Installed `tool_call_mcp_elicitation` enabled; 9 MCP servers enumerated; live elicitation not exercised. | SDK MCP execution is `verified`; interactive MCP elicitation response is unproven. | Inventory/execution and elicitation are separate capabilities; elicitation stays gated. |
| Models | `verified`: 7 installed picker models returned. | `capability-gated` selection: direct turn init reported Haiku but `message_start`, assistant metadata, and billed `modelUsage` were `claude-sonnet-5`; SDK extra-turn events were Haiku. | Fetch per version and display requested/init/actual separately; do not claim reliable selection until divergence is resolved. |
| Reasoning/effort | Stable Codex turn field; installed current task used high. | `verified` low effort; CLI/SDK expose low/medium/high/xhigh/max. | Provider-specific values only. |
| Permission profiles | `verified`: read-only, workspace, danger-full-access. | `verified` plan/default; installed modes include acceptEdits, auto, bypassPermissions, manual, dontAsk, plan. | Never translate by string equality; use adapter mapping and descriptions. |
| Skills | `verified` list call. | Init exposed native skills and 38 slash commands; live skill invocation was not proven. | Inventory may render; invocation remains `capability-gated`. |
| Hooks | `verified` list call; hook start/completed notifications observed. | `verified`: all three settings-source hooks and SDK `PreToolUse` callback executed. | Preserve provider hook activity as real external work. |
| Plugins/apps | Installed Codex features enabled; list calls returned zero current items. | `verified`: local plugin appeared in direct CLI and SDK init. Marketplace mutation was not tested. | Empty is a real state, not unsupported; mutations remain gated. |
| MCP inventory | `verified`: 9 configured servers via app-server census. | `verified` synthetic SDK MCP server/tool; user-configured inventory remains runtime-specific. | Backend-only credentials and auth state. |
| Config | `verified`: `config/read` and requirements keys. | `verified`: isolated `CLAUDE_CONFIG_DIR`; user/project/local hooks each executed. | Read-only display first; writes require explicit supported route. |
| Auth | `verified`: app-server reports API-key account type; token never exposed. | `verified`: isolated CLI reports API key/first-party provider; credential never entered retained evidence. | Require API/cloud auth; never fall back silently to subscription OAuth. |
| Review/diff | Codex stable `review/start`, diff notifications, file items; not live-proven here. | Existing Claude transcript renders edits; native persistent review contract unproven. | Inspector capability-gated. |
| Terminal | Codex stable command execution methods; automated `thread/shellCommand` prohibited. | Provider contract `verified` in scratch through the native Bash tool and correlated hooks while the SDK reference client owned the child; DevHub deterministic event/control handling passes, while selected-wrapper raw lifecycle proof remains an M4 gate. | Never expose an unsandboxed automatic shell fallback. |
| SYNC-1 | `verified` for start/persist/restart/read/resume/continue/interrupt. | Provider lifecycle `verified`: direct CLI start/persist plus a restarted installed CLI under SDK reference control for list/read/same-ID resume/continue/interrupt. Raw multi-query/control handling and post-interrupt resume are not claimed. | Mandatory native provider gate passes; M4 must reproduce exact controls before enabling the adapter. |
| SYNC-2 | Restart discovery proven; Codex durable provider-aware reconciliation remains an M5 gate. | SQLite writer lease, durable monotonic epochs, revision invalidation/refusal, crash expiry takeover, and in-process reconciliation latches are deterministically proven. Restart-durable reconciliation metadata remains an M5 gate. | Overall continuous cross-provider SYNC-2 remains `capability-gated` until M5 migration/restart tests pass. |
| SYNC-3 | `verified-current-build` by direct native-ID navigation: app build 5175 rendered both DevHub-created turns. Sidebar/project-list discovery remains unproven because Computer Use is host-blocked. | `unsupported` by official CLI/SDK picker contract. | Never block startup; report current-build status and discovery caveat only. |
| Background work | Codex schema includes background/experimental surfaces but not production-proven. | `--bg` cannot be combined with `-p`; no supported persistent JSON supervisor contract. | `capability-gated`; do not fake. |

## Installed Codex feature evidence

Stable/enabled examples: `unified_exec`, `hooks`, `multi_agent`, `apps`, `plugins`, `in_app_browser`, `browser_use`, `computer_use`, `image_generation`, `tool_call_mcp_elicitation`, `auth_elicitation`, `goals`, and `fast_mode`.

Present but not usable as product claims: `request_permissions_tool` and `default_mode_request_user_input` are under-development and disabled; `exec_permission_approvals` is under-development and disabled; several process/realtime/artifact surfaces are experimental or under-development.

## Authority

- Codex app-server: <https://developers.openai.com/codex/app-server>
- Claude legal/authentication constraint: <https://code.claude.com/docs/en/legal-and-compliance>
- Claude CLI/Agent SDK: <https://code.claude.com/docs/en/agent-sdk>

This matrix is version-specific. Reprobe on provider binary/app changes.
