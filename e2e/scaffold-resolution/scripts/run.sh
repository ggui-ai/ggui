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
# Export npm_config_registry so npx fetches create-agentic-app itself from
# Verdaccio (npx honors npm_config_registry). NOTE: this env var alone does NOT
# reliably reach the nested `pnpm install` that create-agentic-app's --install
# would spawn — verified empirically, that path leaks to npmjs and resolves
# `^0.2.0-alpha.1` to the npmjs prerelease instead of our local base. So we
# scaffold WITHOUT --install and run install ourselves below, gated by a
# project-level .npmrc (the strongest registry signal pnpm honors).
export npm_config_registry="$REGISTRY/"
# Isolates npx's (npm) package cache to $WORK so npx fetches create-agentic-app
# FRESH from Verdaccio, not a stale npmjs-cached copy. This one IS honored (npx
# is npm); pnpm ignores it — pnpm's isolation is the project .npmrc below.
export npm_config_cache="$WORK/npm-cache"
# NOTE: pnpm's store/cache isolation is done via the per-app project .npmrc
# below (store-dir/cache-dir), NOT env vars — env-var cache-dir was found to be
# silently ignored by pnpm 11 here, letting installs read a stale global cache.
REGISTRY_HOST_PORT="${REGISTRY#http://}"
REGISTRY_HOST_PORT="${REGISTRY_HOST_PORT%/}"
EXPECT_PROTO="$(node -p "require('$REPO_ROOT/oss/packages/protocol/package.json').version")"

for sdk in "${SDKS[@]}"; do
  echo "  → scaffolding $sdk"
  rm -rf "$WORK/app-$sdk"
  # Scaffold only (no --install) so we control the registry of the install.
  npx -y @ggui-ai/create-agentic-app "$WORK/app-$sdk" \
    --name "gate-$sdk" --agent "$sdk" --ref main --no-git

  # Project-level .npmrc pins everything for THIS tree. A project .npmrc beats
  # env vars and is honored by the workspace-level pnpm install across every
  # nested package, so the isolation is reliable (env-var cache-dir was NOT —
  # pnpm silently fell back to the global ~/.cache/pnpm).
  #   - registry/_authToken  → @ggui-ai/* provably resolves from Verdaccio.
  #   - cache-dir/store-dir  → per-run, hermetic. Each gate run REBUILDS
  #     @ggui-ai/* and republishes at the SAME 0.2.0 version; a shared cache
  #     keyed by localhost:4874 would carry a PRIOR run's integrity and reject
  #     the new tarball with ERR_PNPM_TARBALL_INTEGRITY. Per-run dirs make the
  #     gate pass on the 2nd+ run and in CI.
  cat > "$WORK/app-$sdk/.npmrc" <<EOF
registry=$REGISTRY/
//$REGISTRY_HOST_PORT/:_authToken=scaffold-gate-token
cache-dir=$WORK/pnpm-cache
store-dir=$WORK/pnpm-store
EOF

  echo "    installing $sdk (Verdaccio-pinned .npmrc)"
  ( cd "$WORK/app-$sdk" && pnpm install )

  # Resolution proof: publish-all.sh publishes @ggui-ai/protocol at its committed
  # STABLE base (e.g. 0.2.0) — a version npmjs does NOT have (npmjs only has the
  # -alpha.N prereleases). The template range `^0.2.0-alpha.1` is satisfied by
  # BOTH the local 0.2.0 (Verdaccio) and the npmjs prereleases, so a leak to
  # npmjs would still install successfully and silently. We discriminate by the
  # installed version: Verdaccio ⇒ the stable base; npmjs ⇒ a prerelease.
  #
  # Read the version from pnpm's canonical virtual store. Every dependency lives
  # exactly once at node_modules/.pnpm/<name>@<version>[_<peerhash>]/ — the dir
  # name carries the EXACT installed version regardless of how it's symlinked
  # into each workspace package. We grep the protocol entry and strip to the
  # version (the segment after `@ggui-ai+protocol@`, before any `_` peer hash).
  PNPM_VIRT="$WORK/app-$sdk/node_modules/.pnpm"
  PROTO_DIR="$(find "$PNPM_VIRT" -maxdepth 1 -type d -name '@ggui-ai+protocol@*' 2>/dev/null | head -1)"
  if [[ -z "$PROTO_DIR" ]]; then
    echo "  ✗ $sdk: @ggui-ai/protocol absent from pnpm virtual store — install incomplete." >&2
    exit 1
  fi
  GOT_PROTO="$(basename "$PROTO_DIR")"
  GOT_PROTO="${GOT_PROTO#@ggui-ai+protocol@}"   # strip name prefix
  GOT_PROTO="${GOT_PROTO%%_*}"                   # strip peer-deps hash suffix
  if [[ "$GOT_PROTO" != "$EXPECT_PROTO" ]]; then
    echo "  ✗ RESOLUTION LEAK: $sdk installed @ggui-ai/protocol@$GOT_PROTO (expected local $EXPECT_PROTO)." >&2
    echo "    The scaffold install hit npmjs, not Verdaccio — the gate is not testing the cohort." >&2
    exit 1
  fi
  echo "    ✓ $sdk resolved @ggui-ai/protocol@$GOT_PROTO from Verdaccio (local cohort)"
done

echo "════════════════════════════════════════════════════════════"
echo "  SCAFFOLD-RESOLUTION PASSED — all ${#SDKS[@]} SDKs install from the published cohort"
echo "════════════════════════════════════════════════════════════"
