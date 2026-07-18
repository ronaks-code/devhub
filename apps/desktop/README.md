# DevHub for macOS

The Tauri shell packages the existing Vite UI and a relocatable pnpm deployment
of the Fastify server. On launch it starts the server as an owned process group,
waits for the strict `/api/health` identity, then loads the UI from the same
localhost origin. Finder launches receive an explicit PATH containing
`/usr/local/opt/node/bin`, `~/.local/bin`, `/opt/homebrew/bin`, and standard
system locations, so Node, Claude, and Codex do not depend on a terminal.

## Development

```bash
pnpm install --frozen-lockfile
pnpm --filter @devhub/desktop dev
```

## Build the application

Use the project entrypoint (it uses the shared heavy-job queue):

```bash
./script/build_and_run.sh
```

Or build without launching:

```bash
RONAK_CODEX_CHAT=devhub-tauri /Users/ronak/.codex/bin/ronak-codex-heavy-queue \
  run "devhub-tauri: build DevHub.app" -- \
  pnpm --filter @devhub/desktop build -- --bundles app
```

The bundle is written to
`apps/desktop/src-tauri/target/release/bundle/macos/DevHub.app`. The local build
uses ad-hoc signing. Copy it to `/Applications` or `~/Applications`, launch it
once, add **DevHub.app** in System Settings → Privacy & Security → Full Disk
Access, then quit and relaunch DevHub.

The packaged launcher expects the real Node executable at
`/usr/local/opt/node/bin/node`. Override it with `DEVHUB_NODE_EXECUTABLE` when
needed. `CLAUDE_UI_SERVER_HOST`, `CLAUDE_UI_SERVER_PORT`, and the existing
`CLAUDE_UI_SERVER_CMD` remain available for local diagnostics.
