# Aurora Cockpit redesign — build tracker

Branch: `feat/aurora-redesign` (base `10a68bf`). Spec: `tasks/devhub-redesign-spec.md`.
Routing (per Ronak): Fable = design lead + validation gate. Opus = implementers.
Every code piece gets 2 different-model adversarial reviewers (told "it's wrong, find bugs").
Loop Fable↔Opus until genuinely good. Fable=design spec done ✅.

## Phase 1 — Foundation (serial, one Opus writer) — owns index.css / App.tsx / features/shell/*
- [ ] Tokens retint + glass/aurora/typography + light mode + perf fallback (index.css)
- [ ] Shell fix: null-settings fallback legacy→devhub (kills flash); delete dead ActivityTimeline
- [ ] Sidebar: glass rail+panel cockpit, dialed-down density, kbd sidecar, groups, worktrees, footer
- [ ] TopBar + ChatTabs (Conductor-style) + StatusBar; tab state in App.tsx; drag regions
- [ ] Chat surface glass (no diff-forward), InspectorDock→session/worktree state, Launchpad empty state
- [ ] Shared primitives: StatusDot, ProviderChip, kbd
- [ ] Verify: typecheck + tests + build + boot + screenshot; commit on branch
- [ ] Adversarial review x2 (Codex + Fable) → fixes
- [ ] Fable design-validation gate (screenshot walkthrough) → fixes → sign-off

## Phase 2 — Leaf routes (parallel, Opus in worktrees, after P1 merges) — disjoint dirs
- [ ] 2a Dashboard (Prism Glass) — features/analytics/*, components/dashboard/*
- [ ] 2b Live Ops (Glass Grid + Attention Board) — features/ops/*, LiveOpsBoard, MultiSessionGrid
- [ ] 2c Spatial (Blueprint office) — spatial/* (additive contract fields, BlueprintOffice, toggle)
- [ ] 2d Settings (Query Deck + IDE Rail) — features/settings/*, components/config/*
- [ ] Adversarial review x2 per piece → fixes; Fable validation per piece
- [ ] Merge worktrees back one at a time

## Phase 3 — Sweep + retire
- [ ] Browse/ResponsiveShell restyle; Inbox/Automations/Progress/native-pane zinc-classname sweep
- [ ] Tauri conf traffic-light tweak + on-device drag QA
- [ ] Full-app re-validation walkthrough (the gate Ronak validates himself)
- [ ] (after a week soak) delete AppShell legacy chrome branch

## Notes / decisions
- Spatial info contract (Ronak's open Q, resolved): per desk = agent+model, ticket, status(color+pulse),
  live tokens+cost, runtime, last-action line. Rooms=departments, desks=agents.
- Top bar = opt-2 (breadcrumb+status), right-of-sidebar only, + chat tabs. Confirmed.
