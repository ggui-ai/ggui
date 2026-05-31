#!/usr/bin/env bash
#
# Shared sub-tier-B setup: build the @ggui-ai/* cohort, publish it to a
# throwaway Verdaccio, assemble the CURRENT template tree, and git-init it.
# This is the pre-scaffold half of sub-tier A's run.sh, extracted so the
# host-side harness AND the container cell share one code path.
#
#   - Host-side: boots its own Verdaccio via `docker run` (default).
#   - Container cell: Verdaccio runs as an in-container process (cell-entry
#     starts it), so the caller sets SKIP_VERDACCIO_BOOT=1 + REGISTRY=:4873 and
#     this script just waits for it.
#
# Inputs (env):
#   TEMPLATES_SRC        (required) writable dir; the assembled + git-inited
#                        template repo lands here (per-SDK subdirs).
#   REGISTRY             (default http://localhost:4874) the Verdaccio base URL.
#   SKIP_VERDACCIO_BOOT  (default 0) when "1", do NOT `docker run` Verdaccio —
#                        the caller already provides it at REGISTRY.
#   VERDACCIO_CONTAINER  (default ggui-scaffold-render-verdaccio).
#
# Emits a final `setup-ok REGISTRY=… TEMPLATES_SRC=…` line. Idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
REGISTRY="${REGISTRY:-http://localhost:4874}"
# Reuse sub-tier A's Verdaccio config — @ggui-ai/* served local-only (no uplink
# fallthrough, which would re-open the npmjs leak) and max_body_size raised to
# 50mb because @ggui-ai/ui-gen packs to ~18 MB.
VERDACCIO_CONFIG="$REPO_ROOT/oss/e2e/scaffold-resolution/verdaccio.yaml"
PUBLISH_ALL="$REPO_ROOT/oss/e2e/clean-room-consumer/scripts/publish-all.sh"
ASSEMBLER="$REPO_ROOT/scripts/build-templates.mjs"
CONTAINER="${VERDACCIO_CONTAINER:-ggui-scaffold-render-verdaccio}"
SKIP_VERDACCIO_BOOT="${SKIP_VERDACCIO_BOOT:-0}"
: "${TEMPLATES_SRC:?caller must set TEMPLATES_SRC (a writable dir)}"

_lap=$SECONDS
lap() { echo "[setup] ⏱ $1: $((SECONDS - _lap))s"; _lap=$SECONDS; }

echo "[setup 1/4] build @ggui-ai/* (dist must exist before publish)"
( cd "$REPO_ROOT" && pnpm build )
lap "build cohort"

if [ "$SKIP_VERDACCIO_BOOT" = "1" ]; then
  echo "[setup 2/4] SKIP_VERDACCIO_BOOT=1 — using sibling Verdaccio at $REGISTRY"
else
  echo "[setup 2/4] start throwaway Verdaccio at $REGISTRY"
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

echo "[setup 3/4] publish the full @ggui-ai/* graph (leaf-first) to Verdaccio"
bash "$PUBLISH_ALL" "$REPO_ROOT/oss/packages" "$REGISTRY"
lap "publish cohort"

echo "[setup 4/4] assemble templates (PUBLISHED-version ranges) + git-init → $TEMPLATES_SRC"
node "$ASSEMBLER" --all --out-base="$TEMPLATES_SRC"
git -c init.defaultBranch=main -C "$TEMPLATES_SRC" init -q
git -C "$TEMPLATES_SRC" add -A
git -C "$TEMPLATES_SRC" -c user.email=gate@ggui -c user.name=gate commit -q -m templates
lap "assemble templates"

echo "setup-ok REGISTRY=$REGISTRY TEMPLATES_SRC=$TEMPLATES_SRC"
