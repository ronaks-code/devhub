# Aurora Cockpit redesign — build tracker

Branch: `feat/aurora-redesign` (base `10a68bf`). Spec: `tasks/devhub-redesign-spec.md`.
Routing (per Ronak): Fable = design lead + validation gate. Opus = implementers.
Every code piece gets 2 different-model adversarial reviewers (told "it's wrong, find bugs").
Loop Fable↔Opus until genuinely good. Fable=design spec done ✅.

## Phase 1 — Foundation (serial, one Opus writer) — owns index.css / App.tsx / features/shell/*
- [x] Tokens retint + glass/aurora/typography + light mode + perf fallback (index.css) — commit 81d5652
- [x] Shell fix: null-settings fallback legacy→devhub (kills flash) — flipped all 8 M6 slice resolvers. NOTE: ActivityTimeline is NOT dead (ThreadWorkspace.tsx:227 renders it) — kept, do NOT delete. commit 81d5652
- [x] Sidebar (§3.1): DONE — new Sidebar.tsx (52px icon-rail + g-chord sidecar + 272px glass panel), real status groups (Running/Needs review/Idle) from the running join, two-line rows (StatusDot + title + ProviderChip / project·branch + reltime + cost-on-hover), filter + chips, footer provider segment + model line + spend meter, ⌘\ collapse. commit fb79bcd. (Worktrees group DEFERRED — no worktree data at App root; would need a git/worktree endpoint join.)
- [~] TopBar + ChatTabs + StatusBar + drag: StatusBar DONE (§3.7, commit b97f750 — 'N need you' on every route). TopBar now reads glass + drag region (commit 3a0b7c6). ChatTabs (Conductor multi-chat) + breadcrumb + openTabs/activeTabId state + ⌘1..9/⌘⇧W: NOT done — the one risky bit is integrating tabs into the single-row in-App TopBar; needs the TopBar extraction. See handoff.
- [~] Chat surface glass: composer/inspector/canvas glass + aurora done via CSS (commit 83b0c77). STRUCTURAL (compact tool cards, who-line avatars, InspectorDock→session-state sections, Launchpad §3.3b) NOT done.
- [x] Shared primitives: StatusDot, ProviderChip (components/ui/), global kbd — commit 81d5652
- [x] Verify: typecheck clean + 694 tests pass (1 pre-existing unrelated api-auth fail) + build clean + boots w/ zero console errors + screenshot — /Users/ronak/.claude/jobs/977ae4f4/tmp/aurora-foundation/shell-dark.png
- [ ] Adversarial review x2 (Codex + Fable) → fixes
- [ ] Fable design-validation gate (screenshot walkthrough) → fixes → sign-off

### opus-foundation handoff — CORRECTED data model (spec §3.1 inventory was wrong; verified in code)
- `SessionSummary` (packages/engine/src/types.ts:90) has NO `provider`, NO `status`, NO `projectName`. It HAS: title, gitBranch(nullable), lastTimestamp, costUsd, model, usage, projectId. Legacy sessions are implicitly provider=anthropic (m6-compose `LEGACY_SESSION_PROVIDER`). Native Codex sessions are a SEPARATE `CodexSession` type, not in the `sessions` array.
- Session run-status (Running/Needs review/Idle groups), the topbar running/needs-you pills, statusbar "N need you", and the footer spend-meter ALL require `api.running()` + `stats.budget`, which App.tsx does NOT poll at root today. The structural rebuild must add ONE app-root `useStatsPolling` (hooks/useStatsPolling.ts → {stats, running, ...}) and join to sessions by sessionId. Verified safe: NO full-`<App/>` render test exists (App.*.test.ts are pure-fn + source-string only).
- Test contracts the structural rebuild MUST update-not-delete: TaskRail.test.ts (~40 SSR assertions on data-dh-* attrs — preserve the attrs, extend for new rows), DevHubShell.test.ts (SHELL_GEOMETRY.railWidth=273 — the 52+272 split changes this contract), App.qa-regressions.test.ts (source-string asserts on the `taskRailModel` block + `"New Claude Chat"`/`"New OpenAI Chat"` + `dh-dialog-overlay` count).
- Reusable now: `components/ui/StatusDot.tsx` (status: running|waiting|idle|failed), `components/ui/ProviderChip.tsx` (provider: anthropic|openai → CLD/CDX), `.glass-chrome/.glass-card/.glass-hi`, `.dh-label/.dh-mono-ui/.dh-nums`, global `kbd`, `--dh-aurora`/`--dh-aurora-soft`, all warm/chat tokens.

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
