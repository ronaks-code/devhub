# Claude UI — Todo & Review

Full plan: `~/.claude/plans/federated-swimming-penguin.md`

## Status: M0–M5 complete

- [x] **M0** Monorepo scaffold (pnpm + Turborepo: engine / server / web)
- [x] **M1** Read path — browse + render past chats across all projects (newest-first, grouped by true cwd, huge-file-safe, rename/pin, live SSE)
- [x] **M2** Live chat — drive Claude Code in-app over WebSocket (streaming, model/permission toggles, resume, stop, cost); wraps local `claude` CLI
- [x] **M3** Search — cross-project FTS5 + ⌘K palette with highlights
- [x] **M4** Oversee — Dashboard: running-now sessions + usage analytics (totals, top projects, 30-day activity)
- [x] **M5** Faces — Ink TUI (imports engine directly) + Tauri desktop shell (loads web in a native window)

## Verified
- 23 engine unit tests pass; all 4 TS packages typecheck; web builds; TUI smoke renders.
- Live chat verified in-browser (real response + cost footer); driver verified live (wrote + recalled a file).
- Search returns ranked highlighted hits across projects; Dashboard shows 3 live processes + analytics.
- Tauri shell scaffolded + compiles (needs rustc ≥ 1.88).

## Run
```bash
pnpm install && pnpm dev      # web http://localhost:5173 + API :8787
pnpm tui                      # terminal face
pnpm desktop                  # native window (after pnpm dev)
```

## Key decisions / gotchas (don't relitigate)
- Driver wraps local `claude` CLI (your login, no API key); process-per-turn + `--resume`; permission-mode toggle (no inline approve/deny: CLI lacks `--permission-prompt-tool`, default mode auto-denies headless).
- `node:sqlite` via `createRequire` (Vite/vitest can't bundle the new builtin). FTS5 IS in Node 24's sqlite.
- Group sessions by in-file `cwd` (folder encoding is lossy); claude-mem observer logs filtered out.
- @fastify/websocket route registered in a child plugin so its onRoute hook applies.
- Never edit transcripts; custom names/pins/tags live in our SQLite sidecar.

## Remaining follow-ups (not blocking)
- Inline per-tool approve/deny (needs SDK control-protocol).
- Desktop standalone packaging: bundle the Node server as a Tauri sidecar + sign/notarize.
- Desktop global hotkey + tray (plugins scaffolded path); search snippet uses `[ ]` FTS markers.
- Optional: filter more internal session noise; model breakdown in analytics.
