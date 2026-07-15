# STATUS — DevHub
<!-- SOURCE OF TRUTH. Any fresh Claude/Codex chat reads this FIRST, before touching code. -->
<!-- Update rule: edit this file in the SAME commit as the work it describes. Never let it drift. -->

Last updated: 2026-07-14 by Codex goal 019f6268-781e-77a2-898c-2dadacae509f
Goal: Deliver the mandatory M0-M8 DevHub goal as a provider-native Codex-quality environment for real Codex and Claude runtimes, with preservation, review, verification, and conditional gates reported honestly.

Progress: 3 / 9 milestones done (33%) — denominator FROZEN at 9. Do not change it; partial M3-M8 work receives no percentage credit.

Blocker legend:
  [SOFTWARE]    = unblocked, any agent can start now
  [ALEX]        = waiting on Alex (external human)
  [HARDWARE]    = waiting on a physical device / bench test
  [S3]          = waiting on data/asset in S3
  [RONAK-GATE]  = needs Ronak's decision or approval before proceeding

## Core tasks (counts toward %)
- [x] M0  Baseline, backup, preservation, and execution plan                 [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/baseline.md`
- [x] M1  Native provider contracts, reference package, and design approval  [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/provider-spike-results.md`
- [x] M2  Provider-neutral adapter seam and disabled-by-default flags         [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/implementation-plan.md#M2---Provider-adapter-seam`
- [ ] M3  Native Codex vertical slice, including production-wrapper resume    [RONAK-GATE] → RESOLVER: `tasks/HANDOFF.md` (BLOCKED: extra billable proof turn; see Blocked)
- [ ] M4  Persistent Claude vertical slice, including raw lifecycle parity    [RONAK-GATE] → RESOLVER: `tasks/HANDOFF.md` (BLOCKED: extra billable proof turns; see Blocked)
- [ ] M5  Unified provider-locked task/index model                            [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/m5-implementation-plan.md`
- [ ] M6  Approved reference-first Codex-style shell                          [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/design-lock.md`
- [ ] M7  Cross-provider fork, DevHub Work mode, and synchronization           [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/implementation-plan.md#M7---Cross-provider-fork-Work-mode-synchronization`
- [ ] M8  Packaging, cutover, performance, preservation, and cleanup           [SOFTWARE]   → RESOLVER: `.planning/devhub-codex-parity/implementation-plan.md#M8---Desktop-packaging-cutover-performance-cleanup`

## Blocked — needs a human (agents STOP here, do not loop)
- M3  [RONAK-GATE] Needs Ronak to authorize the additional billable Codex production-wrapper resume/continued-conversation proof turn. Added 2026-07-14; keep `nativeCodex=false`.
- M4  [RONAK-GATE] Needs Ronak to authorize additional billable Claude selected-wrapper raw multi-query/resume/permission/interrupt/post-interrupt/fork-continuation proof turns. Added 2026-07-14; keep `persistentClaude=false`.
- M8  [RONAK-GATE] If signed/notarized distribution is required and Apple credentials are absent, Ronak must provide/authorize them. Conditional as of 2026-07-14; do not fake-pass signing.
- QA  [RONAK-GATE] First-party `com.openai.codex` Computer Use requires a host build whose allowlist permits that bundle. Added 2026-07-14; DevHub's own browser/Computer-Use QA remains allowed.

No [ALEX], [HARDWARE], or [S3] dependency exists for this project.

## Added after freeze (does NOT count toward %)
- None.

## Active worktrees / WIP branches
- `campaign/auto-improve` — tested shared branch; M5 E/F plus the Task 3 native-missing, verified-legacy mapping, opaque observation, and atomic-missing prerequisites are integrated through this checkpoint after exact mainline gates and independent SPEC/QUALITY/SECURITY GO.
- detached `m5` at `3808d21` — exact reviewed M5 E source retained read-only after promotion; current goal coordinator.
- detached `m5-f` at `4244c39` — historical reviewed F internal-foundation source; read-only and never replayed wholesale.
- detached `m5-facade` at `6e1804c` — exact reviewed M5 F facade source retained read-only after promotion; current goal coordinator.
- detached `m5-task3-contracts` at `537891d` — exact reviewed Task 3 native-missing source retained read-only after promotion; current goal coordinator.
- detached `m5-task3-store` at `364d736` — exact reviewed verified-legacy mapping source retained read-only after promotion; current goal coordinator.
- detached `m5-task3-observation` at `307c223` — exact reviewed Task 3 observation/atomic-missing source retained read-only after promotion; current goal coordinator.
- `wip/devhub` at `641af8e` — remote-backed WIP with user-owned dirt and evidence; never merge wholesale.
- detached `m5-c0-schema` at `377a724` and `m5-cursor` at `82a8b74` — stale; do not build on them.

## Recent checkpoints (last 3 tested commits on shared branch)
- `this commit`  Task 3 opaque observation and atomic-missing promotion; 556/556 provider-index tests plus exact-tip SPEC/QUALITY/SECURITY GO.
- `ca9f180`  Task 3 verified-legacy mapping lookup promotion; 532/532 provider-index tests plus exact-tip SPEC/QUALITY/SECURITY GO.
- `256bb7a`  Task 3 native-task-missing prerequisite promotion; 351/351 affected tests plus exact-tip SPEC/QUALITY/SECURITY GO.
