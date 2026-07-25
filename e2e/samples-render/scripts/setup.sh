#!/usr/bin/env bash
#
# Shared samples-render setup: build the @ggui-ai/* cohort and publish it to a
# throwaway Verdaccio. This is the pre-compose half of the harness, extracted
# so the host-side harness AND the container cell share one code path. (The
# retired scaffolder-era setup also assembled + git-inited a template repo
# here; compose-app.mjs now composes per-SDK at boot time, so no assemble
# step remains.)
#
#   - Host-side: boots its own Verdaccio via `docker run` (default).
#   - Container cell: Verdaccio runs as an in-container process (cell-entry
#     starts it), so the caller sets SKIP_VERDACCIO_BOOT=1 + REGISTRY=:4873 and
#     this script just waits for it.
#
# Inputs (env):
#   REGISTRY             (default http://localhost:4874) the Verdaccio base URL.
#   SKIP_VERDACCIO_BOOT  (default 0) when "1", do NOT `docker run` Verdaccio —
#                        the caller already provides it at REGISTRY.
#   VERDACCIO_CONTAINER  (default ggui-samples-render-verdaccio).
#
# Emits a final `setup-ok REGISTRY=…` line. Idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
REGISTRY="${REGISTRY:-http://localhost:4874}"
# The harness's own Verdaccio config — @ggui-ai/* served local-only (no uplink
# fallthrough, which would re-open the npmjs leak) and max_body_size raised to
# 50mb because @ggui-ai/ui-gen packs to ~18 MB.
VERDACCIO_CONFIG="$REPO_ROOT/oss/e2e/samples-render/verdaccio.yaml"
PUBLISH_ALL="$REPO_ROOT/oss/e2e/clean-room-consumer/scripts/publish-all.sh"
CONTAINER="${VERDACCIO_CONTAINER:-ggui-samples-render-verdaccio}"
SKIP_VERDACCIO_BOOT="${SKIP_VERDACCIO_BOOT:-0}"

_lap=$SECONDS
lap() { echo "[setup] ⏱ $1: $((SECONDS - _lap))s"; _lap=$SECONDS; }

echo "[setup 1/3] build @ggui-ai/* (dist must exist before publish)"
# Scope to the publishable cohort ONLY (oss/packages — exactly what
# publish-all.sh uploads). The root `pnpm build` also builds the
# @ggui-apps/* Next apps, which can't resolve the sandbox-generated
# backend/amplify_outputs.json in a fresh cell → breaks setup before any
# render assertion runs. The apps are never published, so exclude them.
( cd "$REPO_ROOT" && pnpm exec turbo build --filter='./oss/packages/*' )
lap "build cohort"

if [ "$SKIP_VERDACCIO_BOOT" = "1" ]; then
  echo "[setup 2/3] SKIP_VERDACCIO_BOOT=1 — using sibling Verdaccio at $REGISTRY"
else
  echo "[setup 2/3] start throwaway Verdaccio at $REGISTRY"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --rm -p 4874:4873 \
    -v "$VERDACCIO_CONFIG:/verdaccio/conf/config.yaml:ro" \
    verdaccio/verdaccio:5 >/dev/null
fi
echo "  waiting for Verdaccio at $REGISTRY"
for _ in $(seq 1 60); do
  curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 || { echo "  Verdaccio unreachable at $REGISTRY" >&2; exit 1; }
echo "  Verdaccio is up"
lap "verdaccio ready"

echo "[setup 3/3] publish the full @ggui-ai/* graph (leaf-first) to Verdaccio"
bash "$PUBLISH_ALL" "$REPO_ROOT/oss/packages" "$REGISTRY"
lap "publish cohort"

echo "setup-ok REGISTRY=$REGISTRY"
