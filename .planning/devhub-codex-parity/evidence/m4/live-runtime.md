# M4 selected-runtime and live-gate status

Date: 2026-07-13

## Selected runtime

- Execution owner: installed Claude CLI `2.1.207` through the persistent stream/control transport.
- Agent SDK: pinned current `0.3.207` for the official control-shape and session-helper boundary; it is not the execution owner.
- Production feature: `persistentClaude`, requested/effective state false until the exact raw lifecycle gate passes.
- Fallback: the existing process-per-turn Claude route remains available and unmodified behind the false feature flag.

## Proven

- M1 direct selected-CLI start, stream, native UUID persistence, settings-source hooks, plugin/skill/agent inventory, and billed/model observations.
- M1 installed-CLI restart under the official SDK reference client, same-ID resume/nonce continuity, one exact file permission allow, native interrupt acknowledgement, and official helper list/read/rename/fork-creation/delete.
- M4 deterministic persistent transport, control correlation, fail-closed permission bridge, event normalization, model-evidence divergence, restart/circuit behavior, official helpers, one-writer lease, adapter/server composition, and provider-native pane implementation.
- Unknown/malformed drift frames are retained as bounded, redacted, backend-only process-memory diagnostics keyed by opaque home scope, session, and event. Known raw lifecycle envelopes are not retained by that ring and it is not a substitute for the selected-wrapper artifact below.
- Current post-hardening focused gates: engine `179/179`, server `65/65`, web `102/102`; engine/server/web typechecks and `git diff --check` pass.
- Fresh full-repo gate: `pnpm exec turbo run typecheck test build --force --concurrency=2` passed `11/11` tasks in `2m23.664s`, including the supported desktop application and x64 DMG bundles. The shared FIFO wait was `766,562 ms` (`12m46.562s`). Turbo emitted only its existing non-fatal missing-output declaration warning for the desktop build. Exact-copy Browser/Computer Use recapture remains open.

## Not proven and therefore disabled

The explicit Claude budget was two billable turns plus one allowed unresolved-lifecycle turn. All three were consumed during M1. The selected production wrapper still lacks one retained raw artifact proving the complete product-owned sequence:

1. multiple queries through the same persistent raw peer;
2. raw `--resume` after DevHub/runtime restart;
3. raw product permission response;
4. raw interrupt receipt;
5. post-interrupt same-ID resume and continued conversation;
6. fork continuation through the selected execution owner.

Synthetic conformance, SDK-reference ownership, and the M1 direct proof support the architecture but do not replace this product-wrapper gate. No additional provider turn was spent. `persistentClaude` stays false, the legacy route stays present, and M4 is not reported complete.

## Cleanup

No retained scratch Claude task, API credential, copied private transcript, provider process, or temporary test listener is part of this evidence. The deterministic screenshots and Markdown records under `evidence/m4/` are intentional program artifacts.
