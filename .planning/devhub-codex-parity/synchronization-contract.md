# Native Synchronization Contract

## Core rule

Provider-native state is authoritative. DevHub owns only rebuildable indexes/caches, UI preferences, and additive metadata. It never directly writes Codex rollouts/databases, Claude transcript JSONL, or private desktop-app storage.

## Identity

```text
NativeTaskKey = provider + canonical effective home + native task id
NativeTurnKey = NativeTaskKey + native turn id
NativeItemKey = NativeTurnKey + native item id
```

Provider is immutable. A provider change creates a new native task through the cross-provider fork service and links the two tasks with additive DevHub metadata.

## SYNC-1 - Native continuity

Definition: a DevHub-created native session persists, is listable/readable, survives provider-process restart, resumes under the same native ID, and accepts/interrupts later work through the provider's supported runtime.

| Provider | Current status | Evidence |
|---|---|---|
| Codex | verified-current-build | Two real turns; completed persistence; app-server restart; list/read/resume same ID; streamed prior nonce; interrupt; fork/archive. |
| Claude | verified-current-build | API-key-backed direct CLI start/stream/persist; child exit; official SDK list/read; new SDK child resumed the same UUID and recalled the prior nonce through SDK MCP; native interrupt acknowledged; official rename/fork/delete helpers passed. |

Claude's row is provider-runtime/interoperability proof. The selected raw DevHub CLI peer has not yet reproduced resume/control correlation, post-interrupt resume was not tested, and the helper-created fork was not continued. Those remain M4 feature-flag gates.

## SYNC-2 - DevHub continuity

Definition: another DevHub process/restart discovers the same native task, safely resumes only after acquiring the local writer lease, and invalidates stale projections when native revision changes.

Lease contract:

- Key: `NativeTaskKey`.
- Heartbeat: 5 seconds.
- Expiry: 15 seconds after last successful heartbeat.
- Reads: concurrent.
- Writes: require the lease.
- Process crash: lease naturally expires; new writer rereads native state before acquisition is considered usable.
- External mutation: compare revision before every write after idle/reconnect; invalidate projection and reread or refuse.

Revision fields:

```text
updatedAt + provider status + last turn id/status + last item id + stable content fingerprint
```

Codex limitation: app-server exposes no documented CAS on `turn/start`. Lease prevents DevHub/DevHub races but cannot control unknown external clients. After any detected external change, DevHub refuses the write until native state is reread and the user-visible task is reconciled.

Current status: harness-process restart discovery is proven for both providers. Production lease/revision code is not implemented and remains an M5 gate. Claude's official helpers expose native message history but no documented compare-and-swap writer primitive, so the same refuse-reread-reconcile rule applies after a detected external revision.

## SYNC-3 - First-party GUI visibility

Definition: the currently installed first-party GUI displays and can safely continue the DevHub-created native session.

SYNC-3 is conditional and never blocks DevHub startup or normal use.

| Provider | Status | Reason |
|---|---|---|
| Codex app `26.707.51957 (5175)` | verified-direct-navigation | Purpose-built app navigation opened the native thread and the GUI rendered both turns. Sidebar discovery is unproven; installed app-server classified the task as `vscode`, making source behavior version-specific. |
| Claude app `1.17377.2` | unsupported by documented contract | CLI `-p` and Agent SDK sessions are excluded from first-party picker visibility. No private storage inspection is permitted. |

## Cache rules

- List/read projections are versioned by provider binary and native revision.
- Replay is idempotent on provider/native IDs.
- Unknown notifications are retained as bounded raw diagnostics.
- Deleting DevHub cache/database never calls provider delete/archive.
- Native delete/archive invalidates the projection; provider content is not retained as an alternate authoritative transcript.
- Additive metadata orphaning is explicit and recoverable; it never recreates a native task silently.

## Approval/request ownership

- Pending request identity includes provider, native task, native turn, provider request ID, and item ID when present.
- `serverRequest/resolved`, turn completion, interruption, or reconnect cleanup removes stale UI.
- Late responses are no-ops.
- Timeout never authorizes: command/file/MCP -> cancel; permissions -> empty grant; user input -> empty answers only when provider supplies auto-resolution semantics.

## External writers and hooks

Provider hooks count as external writers. The Codex spike created a scratch `AGENTS.md` via configured memory integration even though the prompt requested no file changes. The Claude spike executed user, project, local, and SDK `PreToolUse` hooks; those events and any resulting writes are provider activity. DevHub must watch workspace/native revisions and never attribute hook-produced changes solely to its own UI.
