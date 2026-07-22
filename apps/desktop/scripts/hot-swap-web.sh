#!/bin/sh
# Fast UI update — rebuild ONLY the web bundle and swap it into the already-installed
# ~/Applications/DevHub.app's sidecar, then relaunch. No full Tauri/Rust rebuild
# (~5s vs ~60s). The app serves its web from Contents/Resources/sidecar/web at
# runtime, so replacing those files + relaunching is all it takes.
#
# Use for WEB/UI changes (React/CSS). Rust code or tauri.conf.json changes STILL
# need a full `pnpm tauri build` + reinstall.
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="${DEVHUB_APP:-$HOME/Applications/DevHub.app}"
WEB="$APP/Contents/Resources/sidecar/web"
[ -d "$WEB" ] || { echo "No installed app web dir at $WEB — run a full 'pnpm tauri build' + install first."; exit 1; }
cd "$ROOT"
echo "building web…"; pnpm -s --filter @devhub/web build
pkill -f "DevHub.app/Contents/MacOS/app" 2>/dev/null || true
sleep 1
rm -rf "$WEB"/* && cp -R apps/web/dist/* "$WEB"/
open -a "$APP"
echo "DevHub UI hot-swapped + relaunched (no Rust rebuild)."
