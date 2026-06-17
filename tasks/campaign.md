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
- [ ] W3 Settings UI, GitService, config module, LCS diff, draft persistence
- [ ] W4 Inline permissions, faceted search, git panel, projects keyboard nav
- [ ] W5 Search ranking, MCP manager, permission rules, transcript outline
- [ ] W6 Approve-and-remember, commit composer, role filters, light theme
- [ ] W7 Dangerous-command classifier, jump-to-match, per-day usage
- [ ] W8 Hooks editor, what-changed panel, monthly budget, slash palette
- [ ] W9 Settings scope diff, checkpoint/rewind, queue messages, error states
- [ ] W10 Permission polish, MCP health, archive sessions, inline images
- [ ] W11 PR creation, agents library, period selector, tool-running status
- [ ] W12 CLAUDE.md editor, deny-with-feedback, calendar heatmap, @-symbol
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
- **W2** ✅ (4 lanes, green: tc×4 + 34 tests + build + live-chat-stream smoke) — engine-driver: permission-request/response WS frames + `PersistentSession` stream-json scaffold (runTurn unchanged). engine-data: `archive.ts` durable gzip archive + deleted-session fallback in getSessionMessages + watcher unlink; `pricing.ts` model→USD + costUsd(); `detectSourceKind()` multi-source. server: `/api/settings` GET/PUT. web: `formatUsd()`; ChatPane virtualized.
- **W1** ✅ (3 lanes, green: tc×4 + 27 tests + build) — engine: `settings.ts` SettingsStore + `migrations.ts` (PRAGMA user_version) + sqlite PRAGMAs + indexAll per-file try/catch + AppSettings type. server: Fastify route schemas + WS ClientMsg guard. web: localStorage UI-state restore + rAF delta coalescing. New engine API: `engine.getSettings()/setSettings()`.
