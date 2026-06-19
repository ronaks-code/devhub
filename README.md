# DevHub

A personal dashboard for AI coding tools — browse Claude Code and Codex sessions, start new chats, track usage and spend across all your AI tools in one place.

## Monorepo layout

```
packages/engine   Discovery, transcript parsing, indexing, Claude driver. Zero UI.
packages/server   Fastify REST + SSE transport over the engine. Browser talks here.
apps/web          Vite + React + Tailwind. The main UI.
```

## Develop

```bash
pnpm install
pnpm dev          # server + web together
```

Web: http://localhost:5173 · API: http://127.0.0.1:8787

## Verify

```bash
pnpm --filter @claude-ui/engine test   # unit tests (parser, index, search, encoding)
pnpm -r typecheck                       # all packages
pnpm --filter @claude-ui/tui smoke     # TUI smoke test (no TTY needed)
```
