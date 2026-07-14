# DevHub Preservation Matrix

This is the brownfield contract. A later milestone may relocate or restyle a feature, but may not silently remove it, change its persisted meaning, or advertise a capability its runtime cannot execute.

Gate values:

- `baseline`: observed in the current source/runtime.
- `must-pass`: required before the legacy path can be removed.
- `conditional`: retain only when the provider/runtime supports it and render that state honestly.
- `migration`: dual-read/alias is required because the identifier is already persisted.

## Routes and navigation

| Surface | Baseline contract | Preservation gate | Target milestone |
|---|---|---|---|
| `home` | Claude/Codex counts, unified recent activity, Claude quick start. | Same information remains reachable; quick start becomes provider-aware and creates a real native task. | M6 |
| `browse` | Project -> sessions -> transcript, filters, tags, pin/archive/rename, overview, responsive drill-down. | Existing Claude history and additive metadata survive; provider filter/identity added; direct URL state still restores. | M5-M6 |
| `chat` | Claude live process-per-turn UI with queue/stop/retry/resume. | Legacy adapter remains until persistent native Claude lifecycle passes side-by-side. | M2, M4, M6 |
| `ops` | Running board and up-to-six live panels. | Move behind secondary navigation if needed; provider-specific live status remains real. | M6-M8 |
| `inbox` | Recent-session triage with tags/pin/archive. | Fix archive contract; keep triage reachable as a secondary utility. | M5-M8 |
| `dashboard` | Usage, activity, models, tools, spend, projects, dirty repos. | Retain as secondary utility; provider dimensions and native-source caveats added. | M5-M8 |
| `settings` | Preferences, budgets, memory, MCP, hooks, webhooks, permissions, agents, skills, plugins. | Preserve configuration writes and provider capability differences; no fake cross-provider settings. | M4, M6-M8 |
| `openai-chat` | Dirty raw Chat Completions experiment. | Quarantined as development/chat-only with tools disabled by default; never named Codex. | M2-M3 |
| `codex-history` | Static rollout-derived list and stats. | Retained only as degraded read-only fallback after native Codex history is green. | M3 |
| URL state | `?tab=&project=&session=` plus transcript hashes. | Old URLs remain readable; new task URLs include provider without colliding; popstate works. | M5-M6 |

## Visible web features

| Family | Baseline inventory | Must-pass proof before cutover |
|---|---|---|
| Project/session browsing | Filtering, favorites, archived projects, keyboard navigation, session search/tags/rename/pin, multi-select and bulk operations, project overview. | Browser fixture and real-index smoke cover every control, keyboard path, URL restoration, and persistence after restart. |
| Transcript reading | Virtualization, tail loading, role/tool filters, find, errors, outline, minimap, replay, bookmarks, reading mode, notes, tags, permalinks, comparison. | Long-transcript anchor test; direct URL/hash tests; metadata round trip; no provider transcript writes. |
| Tool rendering | Bash, Edit/Write diff, Read, Grep/Glob, Task/subagent, TodoWrite, Web, image, Markdown/GFM/KaTeX. | Provider fixture corpus maps native events to existing renderers; unknown events retain raw diagnostics. |
| Repository utilities | File changes, Git status/diff/branch/worktree, open in editor. | Existing APIs stay reachable; mutations remain explicit/authenticated; inspectors do not expose unsandboxed automatic shell. |
| Claude composer | Draft/history, slash palette, snippets, `@file`, paste/drop images, model/permission, send/queue/stop. | Persistent Claude adapter passes start/stream/interrupt/restart/resume; unsupported approval/fork controls hidden or disabled. |
| Search/commands | Global search, command palette, project switcher, recent sessions. | Keyboard and focus restoration tests; provider/task search results remain distinguishable. |
| Shell preferences | Theme, reduced motion, onboarding, auth gate, toasts, browser notifications. | Light/dark/reduced-motion/browser and packaged desktop checks. |
| Responsive behavior | Browse one-pane drill-down below 1024 px; fixed main sidebar elsewhere. | Preserve supported current path, then meet approved narrow/minimum-width lock without overflow. |

## Engine/server capabilities not consistently reachable from web

These remain preservation scope even if the new shell moves them to Settings, command palette, or an inspector:

- checkpoints and restore;
- hybrid and session-local search;
- effective-config resolution and config search/lint/backups;
- MCP health/toggles;
- permission audit/suggestions;
- saved views and related sessions;
- symbols and AI summary;
- process stop;
- PR creation and Git stage/unstage/discard/fetch/pull/push;
- individual Markdown/JSON/HTML, usage CSV, and portable archive export/import;
- file changes and transcript tail SSE;
- diagnostics and integrity repair.

Each feature needs either a real reachable workflow test or an intentional-deviation entry. Existence of an engine method or route alone is not a green preservation result.

## HTTP/SSE/WebSocket contract inventory

### Core and sessions

- `GET /api/health`
- `GET /api/search`
- `GET /api/running`
- `GET /api/stats`
- `GET /api/projects`
- `GET /api/projects/:id/sessions`
- `GET /api/sessions/:id/messages`
- `GET /api/sessions/:id/subagent`
- `PATCH /api/sessions/:id`
- `GET /api/events` (SSE)
- `WS /api/ws/session`

### Search, analytics, and maintenance

- `GET /api/all-sessions`
- `GET /api/search/session`
- `GET /api/rollups`
- `GET /api/stats/tools`
- `GET /api/projects/:id/overview`
- `GET /api/sessions/:id/related`
- `GET /api/sessions/:id/files`
- `GET /api/symbols`
- `POST /api/summary`
- `GET /api/sessions/:id/tail` (SSE)
- `GET /api/health/diagnostics`
- `POST /api/reindex`
- `GET /api/maintenance/integrity`
- `POST /api/maintenance/repair`
- `GET /api/budget`
- `PUT /api/budget`
- `GET /api/sessions/:id/autotag/suggest`
- `POST /api/sessions/:id/autotag`
- `POST /api/running/stop`

### Metadata and settings

- `GET /api/settings`
- `PUT /api/settings`
- `PATCH /api/settings`
- `PATCH /api/projects/:id`
- `GET /api/saved-views`
- `POST /api/saved-views`
- `DELETE /api/saved-views/:id`
- `GET /api/webhooks`
- `POST /api/webhooks`
- `PUT /api/webhooks/:id`
- `DELETE /api/webhooks/:id`
- `POST /api/webhooks/:id/test`

### Claude configuration

- `GET /api/config/mcp`
- `GET /api/config/agents`
- `GET /api/config/skills`
- `GET /api/config/commands`
- `GET /api/config/hooks`
- `PUT /api/config/hooks`
- `GET /api/config/plugins`
- `GET /api/config/claudemd`
- `PUT /api/config/claudemd`
- `PUT /api/config/mcp`
- `DELETE /api/config/mcp`
- `GET /api/config/backups`
- `POST /api/config/restore`
- `GET /api/config/lint`
- `GET /api/permissions`
- `PUT /api/permissions`
- `GET /api/permissions/suggest`
- `POST /api/hooks/test`

### Files, Git, and external actions

- `GET /api/assets`
- `GET /api/files`
- `POST /api/attachments`
- `POST /api/open`
- `GET /api/git/status`
- `GET /api/git/diff`
- `GET /api/git/branches`
- `GET /api/git/log`
- `GET /api/git/worktrees`
- `POST /api/git/stage`
- `POST /api/git/commit`
- `POST /api/git/branch`
- `POST /api/git/suggest-message`
- `POST /api/git/worktree`
- `DELETE /api/git/worktree`
- `POST /api/git/unstage`
- `POST /api/git/discard`
- `POST /api/git/fetch`
- `POST /api/git/pull`
- `POST /api/git/push`
- `POST /api/pr`

### Export/import

- `GET /api/sessions/:id/export`
- `GET /api/sessions/:id/export.html`
- `GET /api/export/usage`
- `GET /api/export/archive`
- `POST /api/import/archive`

### Provider-specific baseline

- `GET /api/codex/sessions`
- `GET /api/codex/stats`
- `GET /api/openai/models`
- `GET /api/openai/sessions`
- `POST /api/openai/sessions`
- `DELETE /api/openai/sessions/:id`
- `WS /api/ws/openai/:sessionId`

There are 93 registered surfaces in total: 89 ordinary HTTP routes, 2 SSE routes, and 2 WebSockets. New provider endpoints must be additive until client and persistence parity tests pass.

## Persistence and ownership

| Store/identifier | Baseline | Target rule | Migration gate |
|---|---|---|---|
| Claude native JSONL under `CLAUDE_CONFIG_DIR` | Read directly and watched. | Native runtime/session helpers are authoritative; parsing is read-only degraded fallback. | No DevHub write; restart/resume proven. |
| Codex rollouts under `~/.codex/sessions` | Read recursively and fully; `CODEX_HOME` ignored. | App-server is authoritative; parser is bounded degraded fallback honoring effective home. | App-server list/read/start/resume green. |
| `~/.claude-ui/index.db` / `CLAUDE_UI_DATA` | SQLite projection and additive metadata. | Rebuildable projection plus additive DevHub metadata only. | Delete-DB rebuild test leaves native sessions unchanged. |
| `~/.claude-ui/archive/*.jsonl.gz` | Full raw transcript copies. | Remove authority role; define bounded cache retention/invalidation or retire safely. | Native deletion and cache rebuild tests. |
| `~/.claude-ui/attachments` | DevHub-owned uploads. | Retain with provider/task ownership and redaction rules. | Provider-dimension migration. |
| Portable archive | Can carry mirrored transcript text. | Export additive metadata and explicitly user-requested content without becoming native authority. | Round-trip plus native-source labeling. |
| Browser localStorage `claude-ui:*` | UI state, recents, prompts, drafts, theme, perf, bookmarks, snippets, onboarding, connection. | Dual-read old keys, write new `devhub:*`, provider-dimension task keys. | Migration tests and rollback read. |
| `claude-ui-token` | Browser auth token. | Migrate without logging/URL leakage; use authenticated channel. | Security integration tests. |
| `CLAUDE_UI_*` env vars | Existing operational config. | Keep aliases while introducing `DEVHUB_*`; document precedence. | CLI/desktop tests. |
| `claude-ui-archive` discriminator | Persisted portable schema. | Keep reader; version new writer. | Fixture compatibility. |
| Webhook `source:"claude-ui"` | External persisted semantic. | Preserve old reader/event consumer compatibility; new events may use versioned DevHub source. | Webhook fixtures. |
| Tauri `dev.sixthsense.claude-ui` | Installed app identity. | Decide migration without orphaning preferences; visible product becomes DevHub. | Packaged upgrade smoke. |

Deleting the DevHub database or cache must never delete or modify native Codex or Claude sessions. Native provider credentials never enter browser state, URLs, logs, screenshots, fixtures, or telemetry.

## Keyboard contract

### Global web

- Cmd/Ctrl+K: search.
- Cmd/Ctrl+Shift+P: command palette.
- Cmd/Ctrl+P: project switcher.
- `?`: shortcut sheet.
- Escape: close overlays with focus restoration.
- Arrow keys + Enter: palette/search/switcher traversal.

### Lists and transcripts

- `j`/`k`, arrows, Home/End: move list focus.
- Enter or Space: open focused item.
- `x`: toggle selected session; Shift+X: range select; Escape: clear.
- Cmd/Ctrl+F: transcript find; Enter/Shift+Enter: next/previous.
- Alt+E / Alt+Shift+E: next/previous error.
- `[` / `]`: previous/next bookmark.

### Approval/composer

- A allow once, S allow session, D deny, E edit; J/K or arrows move requests. These shortcuts remain conditional until the provider can answer the request.
- Enter sends/queues; Shift+Enter inserts newline.
- Up/Down traverses prompt history only at textarea boundaries while idle.
- Mention/slash menus support arrows, Enter/Tab, and Escape.

### Desktop/TUI

- CmdOrCtrl+Shift+K globally toggles the desktop window.
- TUI browse: arrows/J/K, Enter, C, `/`, D, Q; transcript Space page-down; chat Enter and Escape interrupt/back; search supports typing, Backspace, Enter, arrows, Escape.

The current shortcut sheet is incomplete and must be reconciled against the real inventory during design lock.

## Desktop and TUI contract

| Surface | Preserve | Known baseline defect |
|---|---|---|
| Tauri window | 1400x900, min 920x600, resizable, overlay title bar. | Visible product/window still `Claude UI`. |
| Server lifecycle | Detect/spawn/cleanup server. | Stale package name; accepts any listener on 8787; packaged static UI has no proven API bridge. |
| Tray | Show/Hide, left-click toggle, Quit, dock badge. | Legacy copy and server identity coupling. |
| Global shortcut | CmdOrCtrl+Shift+K. | Needs packaged regression test. |
| Notifications | Native completion notification. | Current code focuses app when sending, not when clicked. |
| TUI | Projects, sessions, transcript, chat, search, dashboard. | Legacy title, hard-coded Haiku/permission, no automated suite, shortcut-doc drift. |

## Test and verification preservation

Baseline collected 624 tests: engine 494, server 98, web 32. The migration must add, not substitute:

- Codex app-server real/synthetic protocol tests;
- Claude persistent transport/approval/restart tests;
- provider failure isolation and writer lease tests;
- React DOM/browser workflow tests;
- accessibility/keyboard/visual/responsive tests;
- TUI tests and Tauri packaged smoke;
- uncached gates so stale Turbo artifacts cannot mask failures.

The existing index-worker fallback warning is preserved as a known diagnostic until separately resolved.

## Milestone exit rule

At the end of each milestone, add a result column or linked ledger entry for every affected row. A legacy path may be deleted only when functional, persistence, recovery, security, and visual gates are all green side-by-side.
