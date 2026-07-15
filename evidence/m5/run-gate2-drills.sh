#!/usr/bin/env bash
#
# M5 Task 9 gate-2 induced-failure drill runner.
#
# Runs the full gate-2 drill corpus (the new consolidated drill file plus the
# adversarial induced-failure suites mapped in gate2-drills.manifest.json) at
# <=2 workers and stages JSON + text evidence next to this script.
#
# No provider process is spawned: the native runtimes stay disabled and the
# unifiedTaskIndex / nativeCodex / persistentClaude flags stay false.
#
# Usage:  bash evidence/m5/run-gate2-drills.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/evidence/m5"
WORKERS=2

cd "${REPO_ROOT}"

ENGINE_FILES=(
  test/provider-index/gate2-drills.test.ts
  test/provider-index/migration.test.ts
  test/provider-index/store.test.ts
  test/provider-index/store-active-cache.test.ts
  test/provider-index/store-stage.test.ts
  test/provider-index/store-stage-write.test.ts
  test/provider-index/store-codec.test.ts
  test/provider-index/store-observation.test.ts
  test/provider-index/cursor.test.ts
  test/provider-index/coordinator-rebuild.test.ts
  test/provider-index/coordinator-readthrough.test.ts
  test/provider-index/identity.test.ts
  test/portable.test.ts
  test/providers/codex-native-adapter.test.ts
  test/providers/claude-native-adapter.test.ts
  test/providers/reconciliation-store.test.ts
  test/providers/writer-lease.test.ts
  test/providers/feature-flags.test.ts
)

SERVER_FILES=(
  test/provider-index.test.ts
  test/app.test.ts
)

echo "== gate-2 drills: engine (${WORKERS} workers) =="
npx vitest run --dir packages/engine "${ENGINE_FILES[@]}" \
  --maxWorkers="${WORKERS}" --minWorkers=1 \
  --reporter=default --reporter=json --outputFile="${OUT_DIR}/engine-drills.json" \
  2>&1 | tee "${OUT_DIR}/engine-drills.log"

echo "== gate-2 drills: server (${WORKERS} workers) =="
npx vitest run --dir packages/server "${SERVER_FILES[@]}" \
  --maxWorkers="${WORKERS}" --minWorkers=1 \
  --reporter=default --reporter=json --outputFile="${OUT_DIR}/server-drills.json" \
  2>&1 | tee "${OUT_DIR}/server-drills.log"

echo "== gate-2 drills complete; evidence staged under ${OUT_DIR} =="
