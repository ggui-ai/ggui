#!/usr/bin/env bash
#
# scaffold-resolution gate — proves a freshly-assembled agentic-app template
# INSTALLS cleanly from the about-to-ship @ggui-ai/* cohort (published version
# ranges), catching the version-range-resolution class (the @ggui-ai/protocol@
# 0.2.0-not-found incident) that workspace-linked tests cannot see. Deterministic,
# keyless: no LLM, no agent boot, no Playwright. (That is sub-tier B.)
#
# Usage:
#   bash run.sh                 # full gate, all 3 SDKs
#   SELFTEST=1 bash run.sh      # falsification: poison one range, expect FAILURE
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# Port 4874 (not 4873) to avoid colliding with make registry / ggui-verdaccio-smoke
# which may be running on 4873 during development. Override with REGISTRY= if needed.
REGISTRY="${REGISTRY:-http://localhost:4874}"
# Own config (not the golden-path one) — max_body_size raised to 50mb because
# @ggui-ai/ui-gen packs to ~18 MB (the golden-path default is 10 MB).
VERDACCIO_CONFIG="$REPO_ROOT/oss/e2e/scaffold-resolution/verdaccio.yaml"
PUBLISH_ALL="$REPO_ROOT/oss/e2e/clean-room-consumer/scripts/publish-all.sh"
ASSEMBLER="$REPO_ROOT/scripts/build-templates.mjs"
CONTAINER=ggui-scaffold-verdaccio
WORK="$(mktemp -d)"
SDKS=(claude-agent-sdk openai-agents-sdk google-adk)

cleanup() {
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "════════════════════════════════════════════════════════════"
echo "  scaffold-resolution gate   (work: $WORK)"
echo "════════════════════════════════════════════════════════════"

echo "[1/5] build @ggui-ai/* (dist must exist before publish)"
( cd "$REPO_ROOT" && pnpm build )

echo "[2/5] start throwaway Verdaccio at $REGISTRY"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --rm -p 4874:4873 \
  -v "$VERDACCIO_CONFIG:/verdaccio/conf/config.yaml:ro" \
  verdaccio/verdaccio:5 >/dev/null
for _ in $(seq 1 30); do
  curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 || { echo "  Verdaccio unreachable" >&2; exit 1; }
echo "  Verdaccio is up"

echo "[3/5] publish the full @ggui-ai/* graph (leaf-first) to Verdaccio"
bash "$PUBLISH_ALL" "$REPO_ROOT/oss/packages" "$REGISTRY"

echo "[4/5] assemble templates (PUBLISHED-version ranges) + git-init"
node "$ASSEMBLER" --all --out-base="$WORK/templates-src"

if [[ "${SELFTEST:-0}" == "1" ]]; then
  echo "  SELFTEST: rewriting @ggui-ai/protocol → ^99.0.0 (must break install)"
  # Poison BEFORE the git commit so the clone in step 5 sees the bad range.
  find "$WORK/templates-src" -name package.json -not -path '*/node_modules/*' -print0 \
    | xargs -0 sed -i 's#"@ggui-ai/protocol": "[^"]*"#"@ggui-ai/protocol": "^99.0.0"#g'
fi

git -c init.defaultBranch=main -C "$WORK/templates-src" init -q
git -C "$WORK/templates-src" add -A
git -C "$WORK/templates-src" -c user.email=gate@ggui -c user.name=gate commit -q -m templates

echo "[5/5] scaffold each SDK from Verdaccio + assert pnpm install resolves"
# GGUI_TEMPLATES_REPO_URL points create-agentic-app at the locally assembled
# git repo (step 4) so it clones THAT instead of GitHub. This is what makes
# both the healthy run (assembled with current source) and the SELFTEST
# (poisoned package.json) actually test what we assembled here.
export GGUI_TEMPLATES_REPO_URL="$WORK/templates-src"
# Export npm_config_registry so both npx and pnpm resolve from Verdaccio (not
# npmjs). pnpm inherits npm_config_* env vars at startup, so --registry is not
# needed on the pnpm install command. npx checks npm_config_registry before
# the npmjs default so it fetches create-agentic-app from the local registry.
# We also override the npx cache dir to force a fresh fetch — without this,
# npx may serve a stale npmjs-cached binary from ~/.npm/_npx instead of the
# Verdaccio-published one.
export npm_config_registry="$REGISTRY/"
export npm_config_cache="$WORK/npm-cache"
# Isolate pnpm's content-addressable store to $WORK so installs are forced to
# fetch from Verdaccio (or npmjs via uplink) rather than reusing a dev-machine
# store that may have cached earlier @ggui-ai/* prereleases. Omitting this
# makes the gate pass on a warm dev machine even if Verdaccio is empty —
# defeating the resolution proof.
export PNPM_HOME="$WORK/pnpm-home"
export npm_config_store_dir="$WORK/pnpm-store"
for sdk in "${SDKS[@]}"; do
  echo "  → scaffolding $sdk"
  rm -rf "$WORK/app-$sdk"
  npx -y @ggui-ai/create-agentic-app "$WORK/app-$sdk" \
    --name "gate-$sdk" --agent "$sdk" --ref main --no-git --install
done

echo "════════════════════════════════════════════════════════════"
echo "  SCAFFOLD-RESOLUTION PASSED — all ${#SDKS[@]} SDKs install from the published cohort"
echo "════════════════════════════════════════════════════════════"
