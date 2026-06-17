# Claude UI

A personal, all-projects **control center for Claude Code**: browse every past chat, search/rename/organize, chat live (terminal replacement), and oversee running sessions — across *all* your projects.

**One brain, many faces:** a single framework-agnostic engine powers a web app today, and a desktop app (Tauri) + terminal UI (Ink) later.

## Architecture

```
packages/engine   The brain — discovery, transcript parsing, indexing, the Claude driver. Zero UI.
packages/server   Fastify transport — REST + SSE (+ WS later) over the engine. Browser talks to this.
apps/web          Vite + React + Tailwind + shadcn/ui. The first face.
```

The HTTP boundary lives in `packages/server`, not the engine — so the future TUI imports the engine
directly and the future desktop app runs the server as a sidecar. Only the browser crosses the wire.

## Develop

```bash
pnpm install
pnpm dev          # runs the server + web together
```

Web: http://localhost:5173 · API: http://127.0.0.1:8787

## Status

- [x] **M0 — Monorepo scaffold** (pnpm + Turborepo; engine / server / web)
- [x] **M1 — Read path**: browse + render past chats across all projects, newest-first,
      grouped by true `cwd` (orphan recovery), huge-file-safe (tail-window), per-session
      token stats, inline rename + pin, live SSE updates. claude-mem noise filtered.
- [x] **M2 — Live chat** (terminal replacement): drive a real Claude Code session in-app over a
      WebSocket — streaming thinking/text/tool-calls/results (reusing the M1 renderer), model +
      permission-mode toggles, resume across turns, Stop/interrupt, per-turn cost. Wraps the local
      `claude` CLI (your login, no API key).
- [x] **M3 — Search**: cross-project full-text search (SQLite FTS5) + a ⌘K palette with highlights.
- [x] **M4 — Oversee**: Dashboard tab — running-now sessions (from `~/.claude/sessions`), usage
      analytics (totals, top projects, 30-day activity).
- [x] **M5 — More faces**: **Ink TUI** (`pnpm tui`) imports the engine *directly* (no server);
      **Tauri desktop** shell (`pnpm desktop`) loads the web in a native window. *(Standalone signed
      packaging — bundling the server as a sidecar — is the remaining follow-up.)*

## Faces

| Face | Run | Notes |
|---|---|---|
| Web | `pnpm dev` → http://localhost:5173 | server + Vite |
| Terminal (TUI) | `pnpm tui` | reuses the engine in-process; browse projects → sessions → transcript |
| Desktop | `pnpm dev` then `pnpm desktop` | Tauri native window loading the web (dev) |

### Live-chat notes
- Driver = `claude -p --output-format stream-json` per turn, `--resume <id>` to continue context
  (validated on 2.1.178). Permissions via a mode toggle (`acceptEdits` default); inline per-tool
  approve/deny needs the SDK control-protocol and is a later refinement.
- WS at `/api/ws/session`, registered inside a child plugin so `@fastify/websocket`'s `onRoute`
  hook applies (otherwise the handler is wrongly called with `(req, reply)` instead of a socket).

### Engine notes
- Reads `~/.claude/projects/**/*.jsonl` (honors `CLAUDE_CONFIG_DIR`); never decodes the
  lossy folder name — groups by the true `cwd` inside each transcript.
- Durable index in `~/.claude-ui/index.db` (`node:sqlite`, loaded via `createRequire` so
  Vite/vitest don't choke on the newer builtin); byte-offset **incremental** re-indexing.
- Custom names / pins live in a sidecar table — transcripts are never modified.

### Verify
```bash
pnpm --filter @claude-ui/engine test   # 23 unit tests (parser, index, search, encoding)
pnpm -r typecheck                       # all packages
pnpm --filter @claude-ui/tui smoke     # render the TUI's first frame (no TTY needed)
```

> Desktop requires rustc ≥ 1.88 (`rustup update stable`); the shell compiles and runs via `pnpm desktop`.

See the full plan at `~/.claude/plans/federated-swimming-penguin.md`.
