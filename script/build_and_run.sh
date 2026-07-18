#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="DevHub"
APP_BUNDLE="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/$APP_NAME.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/app"
QUEUE="/Users/ronak/.codex/bin/ronak-codex-heavy-queue"

pkill -f "$APP_BINARY" >/dev/null 2>&1 || true

RONAK_CODEX_CHAT="${RONAK_CODEX_CHAT:-devhub-tauri}" \
  "$QUEUE" run "devhub-tauri: build DevHub.app" -- \
  pnpm --filter @devhub/desktop build -- --bundles app

case "$MODE" in
  run)
    /usr/bin/open -n "$APP_BUNDLE"
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs|--telemetry|telemetry)
    /usr/bin/open -n "$APP_BUNDLE"
    /usr/bin/log stream --info --style compact --predicate "process == \"app\""
    ;;
  --verify|verify)
    /usr/bin/open -n "$APP_BUNDLE"
    sleep 2
    pgrep -x app >/dev/null
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
