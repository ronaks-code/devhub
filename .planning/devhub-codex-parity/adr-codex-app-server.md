# ADR: Codex Uses One Supervised App-Server Per Effective CODEX_HOME

Status: accepted for implementation after the design gate.

## Decision

Use one backend-owned `/opt/homebrew/bin/codex app-server --stdio` process per canonical effective `CODEX_HOME`. All DevHub Codex tasks for that home share the process. The browser never spawns the runtime or receives provider credentials.

## Evidence

Installed 0.144.1 passed honest initialization, native start/stream/persistence/restart/read/resume/interrupt/fork/archive. It exposes stable JSONL methods and server requests required by DevHub. Filesystem rollout parsing cannot provide equivalent lifecycle fidelity and remains degraded read-only fallback.

## Required process contract

- Spawn exact binary argv without a shell.
- Verify `initialize.result.codexHome` matches the supervisor key.
- Monotonic request IDs; separate client-pending and server-request maps.
- Bound pending RPCs to 512 and decoded ingress to 1,024 envelopes/32 MiB.
- Treat oversized/malformed lines, duplicate request IDs, and unknown response IDs as protocol faults.
- Preserve unknown notifications as bounded diagnostics.
- Drain stdout continuously; keep redacted stderr in a 4 MiB ring.
- Coalesce only display deltas at browser fan-out; never drop lifecycle/request events.
- Retry overload only when safe; never replay an uncertain mutation.
- Restart at 250ms, 1s, 2s, 4s, 8s, 16s, 30s plus jitter; open circuit after five failures in 60 seconds.
- Reinitialize, reread, compare revision, and resume after restart. Never replay uncertain `turn/start`.
- Graceful shutdown: stop new work, cancel pending requests, interrupt DevHub-owned turns, close stdin, then SIGINT -> SIGTERM -> SIGKILL.

## Installed-version compatibility rules

- List both observed `vscode` and documented future `appServer` sources for DevHub tasks; tag with a DevHub service/name and diagnose classification.
- Pass explicit safe approval/sandbox/profile overrides on resume and verify the response. Refuse `dangerFullAccess` unless it is the user's explicit current choice.
- Persist additive fork provenance because archive/unarchive lost it on this build.
- Experimental capability is off by default. Apps/plugins that appear in stable bindings but are described as experimental/under-development remain gated by runtime census.
- `thread/shellCommand` and experimental process APIs are never automatic.

## Alternatives rejected

- Rollout parser as primary: cannot start, stream, approve, interrupt, resume, or correlate native events.
- Process per task: duplicates config/MCP/auth state and complicates external mutation.
- WebSocket transport: installed support is experimental; stdio is documented and local.
- Raw OpenAI Chat Completions loop: not Codex, not persistent, and unsafe.
