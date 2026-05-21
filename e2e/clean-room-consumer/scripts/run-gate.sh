#!/usr/bin/env bash
#
# Clean-room-consumer orchestrator. Runs inside the gate-runner container.
#
#   [1] wait for Verdaccio
#   [2] publish all 38 @ggui-ai/* packages to Verdaccio (leaf-first)
#   [3] install them into a clean-room consumer — npm, fresh dir,
#       registry pinned to Verdaccio, ZERO workspace linkage
#   [4] run packaging smokes against the installed artifacts
#
# Any failing step aborts (set -e) → non-zero exit → the gate blocks.
set -euo pipefail

PACKAGES_ROOT=/build/packages
REGISTRY="${VERDACCIO_URL:-http://verdaccio:4873}"
GATE=/gate
CONSUMER=/tmp/consumer

echo "════════════════════════════════════════════════════════════"
echo "  ggui clean-room consumer"
echo "════════════════════════════════════════════════════════════"

echo
echo "[1/4] Waiting for Verdaccio at $REGISTRY"
for _ in $(seq 1 60); do
  curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 || {
  echo "  Verdaccio unreachable after 60s" >&2
  exit 1
}
echo "  Verdaccio is up"

echo
echo "[2/4] Publishing @ggui-ai/* packages to Verdaccio"
bash "$GATE/scripts/publish-all.sh" "$PACKAGES_ROOT" "$REGISTRY"

echo
echo "[3/4] Installing into a clean-room consumer (zero workspace linkage)"
rm -rf "$CONSUMER"
mkdir -p "$CONSUMER"
node "$GATE/scripts/compute-order.mjs" "$PACKAGES_ROOT" --consumer-pkg \
  > "$CONSUMER/package.json"
cp "$GATE/consumer-template/npmrc" "$CONSUMER/.npmrc"
cp -r "$GATE/consumer-template/smoke" "$CONSUMER/smoke"
cd "$CONSUMER"
# npm (not pnpm) — pnpm has workspace-aware resolution paths that would
# mask publish-shape breakage. A fresh dir outside the monorepo means
# there is no parent node_modules to fall through to.
npm install --no-audit --no-fund --loglevel=error
echo "  installed $(node -pe 'Object.keys(require("./package.json").dependencies).length') deps from Verdaccio"

echo
echo "[4/5] Running packaging + CLI smokes"
node smoke/import-smoke.mjs
node smoke/cli-smoke.mjs

echo
echo "[5/5] Running serve smoke"
node smoke/serve-smoke.mjs

echo
echo "════════════════════════════════════════════════════════════"
echo "  CLEAN-ROOM CONSUMER PASSED"
echo "════════════════════════════════════════════════════════════"
