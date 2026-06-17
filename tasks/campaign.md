# Claude UI — Autonomous 200-Feature Campaign

Directive (2026-06-16): generate ~1000 ideas, implement the top ~200 continuously via agent
swarms — plan, build, verify, commit autonomously. Effort/cost not a constraint.

- Idea pool: **963** → selected **200** → **25 waves** of ~8. Full plan: `tasks/campaign-plan.json`.
- Branch: `campaign/auto-improve` (main is guard-protected). Each verified wave = one commit.
- Execution: per wave, bucket items by package (engine/server/web/tui/desktop); one agent owns each
  package for the wave (no intra-package races); cross-package contracts pre-defined; integrator
  (main) runs full typecheck/build/tests, fixes, commits. Self-audit (review/QA) every ~4 waves.

## Wave progress
- [x] W1 Foundations: settings store, schema/migrations, PRAGMAs, error-safety, localStorage, rAF deltas ✅
- [x] W2 Enablers: persistent driver scaffold, durable archive, multi-source, pricing, permission WS frames, /settings ✅
- [x] W3 Settings UI, GitService, config module, LCS diff, draft persistence ✅
- [x] W4 Inline permissions (UI), faceted search, git panel, projects keyboard nav, regenerate, find bar ✅
- [x] W5 Search ranking, MCP manager, permission rules, transcript outline, tags, TodoWrite card ✅
- [x] W6 Approve-and-remember, commit composer, role filters, theme tokens, prompt history, model facet, all-sessions ✅
- [x] W7 Dangerous-command classifier, jump-to-match, per-day usage, edit-resend, git diff, bulk sessions, WS reconnect ✅
- [x] W8 Hooks editor, what-changed panel, monthly budget, slash palette, live-bubble, Bash card ✅
- [x] W9 Settings scope diff, checkpoint/rewind, queue messages, error nav, model breakdown, word-diff, ⌘P switcher ✅
- [x] W10 Permission card body, MCP health, archive sessions, inline images, permalinks, @-mention, SQL aggregates ✅
- [x] W11 PR creation, agents library, period selector, tool-running state, saved views, tag filter, worktrees ✅
- [x] W12 CLAUDE.md editor, deny-with-feedback, calendar heatmap, code-symbols, query syntax, AI summary, stats poll, Read card ✅mbol
- [ ] W13 Skills manager, branch switcher, retry/queue, mini-map
- [ ] W14 TUI live chat, audit log, edit approvals, project detail header
- [ ] W15 TUI search, push notifications, secret redaction, syntax diff
- [ ] W16 Live Ops board, config watcher, keyboard approvals, prompt templates
- [ ] W17 Effective config, ahead/behind sync, config linter, semantic search
- [ ] W18 Stop running session, restore-from-backup, transcript timestamps
- [ ] W19 TUI dashboard, config search, hook dry-run, KaTeX/JSON render
- [ ] W20 Rate-limit handling, plugins view, mark interrupted, skeletons
- [ ] W21 Mobile/remote auth, tray, MCP toggles, toasts
- [ ] W22 Global error boundary, dirty-tree dashboard, scope selector
- [ ] W23 Resume after reload, TUI transcript render, sandbox, focus rings
- [ ] W24 Tests: driver, server, parser fixtures, transcript pairing
- [ ] W25 Final polish: reduced-motion, responsive, copy actions, deep links

## Wave log
- **W12** ✅ (green: tc×4 + 170 tests + build + symbols + query-syntax + chat). engine: `symbols.ts` on-demand code-symbol search (allowlisted), `query-parser.ts` inline `tool:`/`role:`/`after:`/`model:` tokens integrated into search. server: `/api/summary` (AI recap) + `/api/symbols`. web: ClaudeMdEditor (+preview/token-count), DenyFeedback, 12-month CalendarHeatmap, useStatsPolling, ReadCard.
- **W11** ✅ (green: tc×4 + 140 tests + build + saved-views/worktrees/chat). engine: `saved-views.ts` smart folders (migration v7), git worktree ops, flag-gated `index-worker.ts` (parse-session extracted as shared source; default OFF, sync fallback). server: `/api/pr` (gh + AI body), worktree routes, saved-views routes. web: AgentsLibrary, dashboard PeriodSelector (rollups-based), ToolCard running-state, TagFilterBar, WorktreePanel. (server caught a transient engine mid-edit tc-error from the parse-session extraction; final gate clean.)
- **W10** ✅ (green: tc×4 + 129 tests + build + projects-parity + files + chat). engine: `mcp-test.ts` health check, archive sessions (migration v6 + includeArchived), `aggregates.ts` SQL rollups + cache (getProjects/getStats parity-tested), image-data in parser/ContentBlock. server: `/api/assets` (allowlisted image serve) + `/api/files` (@-mention tree). web: PermissionCardBody (diffs/command), ImageBlock inline render, useMessagePermalink (#uuid), MentionPicker (@-file).
- **W9** ✅ (green: tc×4 + 109 tests + build + byModel + 2-prompt queue smoke RESULTS=2). engine: `config/resolve.ts` scope-diff, `checkpoint.ts` list/restore file-history (dryRun default), running needs-you detection, Stats.byModel. server: WS FIFO message queue (queued:N status, clear-queue, keepQueue interrupt, same-session resume). web: error-nav, ModelBreakdown, word-level diff, ⌘P ProjectSwitcher, queue UX. KNOWN: byModel top bucket "unknown" until a forced reindex backfills sessions.model.
- **W8** ✅ (green: tc×4 + 97 tests + build + search/session + stats.budget + chat). engine: `budget.ts` monthly budget status, `searchInSession` (all matches), budget in Stats. server: `/api/search/session`, PATCH `/api/projects/:id` meta, hooks-write. web: LiveBubble (token deltas re-render ONLY the live bubble via useSyncExternalStore — big perf win), BashCard, SlashPalette, HooksEditor, FileChangeSummary. (server used an in-package structural cast for searchInSession during the parallel window; engine delivered it; runtime verified.)
- **W7** ✅ (green: tc×4 + 90 tests + build + /api/rollups 200 + chat). engine: `classify-command.ts` severity tiers, `rollups.ts` per-day token/cost series, SearchHit.seq, prefix-rewrite reindex (headSig, migration v5). server: `/api/rollups` + tags in PATCH. web: jump-to-match, edit-and-resend (fork), GitDiffView (real git diffs), multi-select + bulk pin/tag, WS auto-reconnect w/ backoff.
- **W6** ✅ (green: tc×4 + 76 tests + build + all-sessions/stats/chat smoke). engine: model facet (migration v4), `all-sessions.ts` cross-project list, git write ops (stage/commit/branch), cost in Stats. server: git commit/stage/branch + AI `suggest-message` (driver-drafted) + `/api/all-sessions`. web: permission scoping UI, CSS semantic theme tokens (light-mode groundwork), CommitComposer, TranscriptFilters, dashboard $, prompt-history recall. INTEGRATOR FIX: deleted a stale server `engine-augment.d.ts` shim → surfaced + fixed a real `createBranch` arity bug.
- **W5** ✅ (green: tc×4 + 57 tests + build + config-API + ranked-search + chat). engine: BM25+role-weight+recency ranking, `tags.ts` (engine tags + `tag` facet + SessionSummary.tags, migration v3), running waitingFor/statusUpdatedAt. server: permission-rule editor (writes user settings.json) + full `/api/config/*` (mcp/agents/skills/commands/hooks/CLAUDE.md, safe writes). web: McpManager, TranscriptOutline TOC, TodoWriteCard, useStickToBottom. (server lane's mid-flight tc-fail was concurrent-edit noise; gate green.)
- **AUDIT after W4** ✅ PASS — UI coherent across W1-W4; Settings panel (gear icon) clean + functional; no console errors except favicon 404. Minor follow-ups: verify ⌘⇧P palette keybind; attachment/hook JSON renders verbosely (covered by later JSON-render wave); add a favicon.
- **W4** ✅ (green: tc×4 + 45 tests + build + git-API + chat smoke). web: `PermissionCard` (plumbed, dormant until persistent path), `GitPanel`, `useListKeyboardNav` (j/k in Projects/Sessions), regenerate-turn, `FindBar` (⌘F). engine: extracted `search.ts` with faceted filters (project/date/role/tool/branch, backward-compat), `running.ts` with pid-liveness. server: `/api/git/*` with cwd allowlist. ⟶ self-audit pass next.
- **W3** ✅ (green: tc×4 + 34 tests + build + runtime smoke: settings/projects/chat). engine: `git.ts` GitService (status/diff/branch/log), `config/` Claude-config read/write module, `project-meta.ts` favorites/archive/sort, driver `buffer.ts` line-cap. web: LCS line-diff, `SettingsPane` + Settings tab, `useDraft` composer persistence, `CommandPalette` (⌘⇧P). NOTE: both agents died on a transient API socket drop after writing all files; work was complete + verified, so kept it (recovery: assess→gate→commit).
- **W2** ✅ (4 lanes, green: tc×4 + 34 tests + build + live-chat-stream smoke) — engine-driver: permission-request/response WS frames + `PersistentSession` stream-json scaffold (runTurn unchanged). engine-data: `archive.ts` durable gzip archive + deleted-session fallback in getSessionMessages + watcher unlink; `pricing.ts` model→USD + costUsd(); `detectSourceKind()` multi-source. server: `/api/settings` GET/PUT. web: `formatUsd()`; ChatPane virtualized.
- **W1** ✅ (3 lanes, green: tc×4 + 27 tests + build) — engine: `settings.ts` SettingsStore + `migrations.ts` (PRAGMA user_version) + sqlite PRAGMAs + indexAll per-file try/catch + AppSettings type. server: Fastify route schemas + WS ClientMsg guard. web: localStorage UI-state restore + rAF delta coalescing. New engine API: `engine.getSettings()/setSettings()`.
