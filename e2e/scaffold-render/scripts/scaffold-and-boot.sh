#!/usr/bin/env bash
#
# Per-SDK: scaffold the published app from Verdaccio + the local assembled
# template tree, install it (Verdaccio-pinned), write `.env.local`, then run
# `pnpm dev` in the FOREGROUND. The harness backgrounds this whole script as a
# process group and tears it down on teardown (see scaffold-app-harness.ts).
#
# Mirrors sub-tier A's scaffold flow (run.sh step 5) exactly — scaffold WITHOUT
# --install, write a project `.npmrc` pinning the registry, then install — which
# is the only reliable way to keep pnpm's nested resolution on Verdaccio.
#
# Inputs (env):
#   SDK                (required) claude-agent-sdk | openai-agents-sdk | google-adk
#   APP_DIR            (required) where to scaffold the app
#   TEMPLATES_SRC      (required) the assembled + git-inited template repo (setup.sh)
#   REGISTRY           (default http://localhost:4874) the Verdaccio base URL
#   ANTHROPIC_API_KEY  (required) drives ggui's UI generation AND the claude agent
#   OPENAI_API_KEY / GOOGLE_API_KEY  (optional) forwarded for the non-claude agents
set -euo pipefail
: "${SDK:?}" "${APP_DIR:?}" "${TEMPLATES_SRC:?}"
REGISTRY="${REGISTRY:-http://localhost:4874}"
# ggui's own UI generation uses Claude by default (ggui.json#generation), so the
# Anthropic key is required regardless of which agent SDK is under test.
: "${ANTHROPIC_API_KEY:?scaffold-and-boot needs ANTHROPIC_API_KEY (ggui generation + claude agent)}"

REGISTRY_HOST_PORT="${REGISTRY#http://}"; REGISTRY_HOST_PORT="${REGISTRY_HOST_PORT%/}"
APP_PARENT="$(dirname "$APP_DIR")"

# The agent backend is unified to port 6790 across all SDK shells (dev.mjs).
# The web SPA reaches it via VITE_AGENT_ENDPOINT_URL / the render scenario's
# ?agent= param.
AGENT_PORT=6790

# npx fetches create-agentic-app itself from Verdaccio (npx honors these);
# pnpm's own isolation is the project .npmrc below (env-var cache-dir is
# silently ignored by pnpm 11 — proven in sub-tier A).
export npm_config_registry="$REGISTRY/"
export npm_config_cache="$APP_PARENT/npm-cache"
# Redirect the template clone at the locally-assembled git repo (a `main`
# branch + per-SDK subdirs) so we scaffold what we just built, not GitHub.
export GGUI_TEMPLATES_REPO_URL="$TEMPLATES_SRC"

rm -rf "$APP_DIR"
echo "[boot] scaffolding $SDK → $APP_DIR (from $TEMPLATES_SRC)"
npx -y @ggui-ai/create-agentic-app "$APP_DIR" \
  --name "rendercell-$SDK" --agent "$SDK" --ref main --no-git

# Project-level .npmrc pins the install to Verdaccio. A project .npmrc beats env
# vars and is honored by the workspace pnpm install across every nested package.
# Per-run cache/store dirs keep it hermetic: each run republishes @ggui-ai/* at
# the SAME 0.2.0 version, and a shared cache keyed by the registry host would
# reject the new tarball with ERR_PNPM_TARBALL_INTEGRITY.
cat > "$APP_DIR/.npmrc" <<EOF
registry=$REGISTRY/
//$REGISTRY_HOST_PORT/:_authToken=scaffold-render-token
cache-dir=$APP_PARENT/pnpm-cache
store-dir=$APP_PARENT/pnpm-store
EOF

# .env.local is REQUIRED: `pnpm dev:ggui` + `pnpm dev:agent` source it via
# dotenv-cli (a missing file errors), and it carries the LLM key that drives
# BOTH the agent and ggui's UI generation, plus the todo-MCP wiring the render
# scenario needs (the agent registers GGUI_TODO_MCP_URL's tools).
# ANTHROPIC_API_KEY always (ggui generation + claude agent). The agent's own key
# is whichever the chosen SDK reads: OPENAI (openai), GEMINI/GOOGLE (google-adk).
{
  echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  if [ -n "${OPENAI_API_KEY:-}" ]; then echo "OPENAI_API_KEY=$OPENAI_API_KEY"; fi
  if [ -n "${GEMINI_API_KEY:-}" ]; then echo "GEMINI_API_KEY=$GEMINI_API_KEY"; fi
  if [ -n "${GOOGLE_API_KEY:-}" ]; then echo "GOOGLE_API_KEY=$GOOGLE_API_KEY"; fi
  echo "GGUI_TODO_MCP_URL=http://localhost:6782/mcp"
  echo "VITE_AGENT_ENDPOINT_URL=http://localhost:$AGENT_PORT"
  # Register the stderr blueprint-cache trace sink in the booted `ggui serve`
  # so every matchBlueprint decision (and the reason it landed there) prints
  # as a `[ggui:cache-trace]` JSON line — the diagnostic the cache-hit spec
  # dumps via app.stdout() to see WHY a semantic match did/didn't propose.
  echo "GGUI_CACHE_TRACE_STDERR=1"
  # Cross-deployment cloud-render capstone (env-gated; unset → local ggui). When
  # GGUI_MCP_URL is a remote pod URL the template dev.mjs's `isRemoteGguiUrl`
  # SKIPS the local ggui service and the agent (which reads GGUI_MCP_BEARER from
  # this file via dotenv) authenticates to the deployed `mcp.ggui.ai/apps/<id>`.
  # The todo MCP (6782) stays local — only UI generation moves to the cloud pod.
  if [ -n "${GGUI_MCP_URL:-}" ]; then
    echo "GGUI_MCP_URL=$GGUI_MCP_URL"
    if [ -n "${GGUI_MCP_BEARER:-}" ]; then echo "GGUI_MCP_BEARER=$GGUI_MCP_BEARER"; fi
  fi
} > "$APP_DIR/.env.local"

# ── Cross-deployment seed-pool e2e wiring (env-gated) ─────────────────────────
# Both blocks are no-ops unless the harness set the env var, so the existing
# render.spec / cache-hit.spec scaffolds are byte-for-byte unaffected. Edits are
# applied to the SCAFFOLDED COPY only — never committed to the template.
GGUI_DIR="$APP_DIR/servers/ggui"

# (1) Persistent sqlite vectors store (Phase A: export-pool reads it back).
# Merge storage.vectors into ggui.json AND add better-sqlite3 to the ggui
# server's deps so `pnpm install` pulls the native binding the sqlite driver
# dynamically imports. Done via `node -e` so existing JSON fields are preserved.
if [ -n "${GGUI_STORAGE_SQLITE:-}" ]; then
  echo "[boot] GGUI_STORAGE_SQLITE=1 — sqlite vectors store + better-sqlite3 ($GGUI_DIR)"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const cfgPath = process.argv[1];
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.storage = { ...(cfg.storage ?? {}), vectors: { driver: "sqlite", path: "./ggui-vectors.sqlite" } };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  ' "$GGUI_DIR/ggui.json"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const pkgPath = process.argv[1];
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies = { ...(pkg.dependencies ?? {}), "better-sqlite3": "^12.9.0" };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  ' "$GGUI_DIR/package.json"
  # pnpm 11 will NOT run better-sqlite3's prebuild-install/node-gyp postinstall
  # (so the native .node binding never lands → `ggui serve` crashes loading the
  # sqlite vectors driver) unless the dep is in the workspace `allowBuilds`
  # allowlist. `strictDepBuilds:false` only downgrades the error to a warning;
  # it does NOT approve the build. Mirror the monorepo root's allowlist form.
  # Idempotent: only append if not already present.
  WS_YAML="$APP_DIR/pnpm-workspace.yaml"
  if ! grep -q "better-sqlite3: true" "$WS_YAML" 2>/dev/null; then
    printf '\nallowBuilds:\n  better-sqlite3: true\n' >> "$WS_YAML"
  fi
fi

# (2) Shared seed pool (Phase B: reuse a blueprint from another deployment).
# Append `--seed-pool <dir>` to the ggui `start` script ONLY when the env var is
# present at boot (the `${GGUI_SEED_POOL:+…}` guard means an unset var leaves the
# script unchanged). Also export it into .env.local so it reaches `ggui serve`
# whether the start runs under dotenv or plain env inheritance.
if [ -n "${GGUI_SEED_POOL:-}" ]; then
  echo "[boot] GGUI_SEED_POOL set — appending --seed-pool to ggui start ($GGUI_SEED_POOL)"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const pkgPath = process.argv[1];
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const start = pkg.scripts && pkg.scripts.start;
    if (typeof start !== "string") {
      throw new Error("ggui server package.json has no string scripts.start to extend");
    }
    if (!start.includes("--seed-pool")) {
      pkg.scripts.start = start + " ${GGUI_SEED_POOL:+--seed-pool \"$GGUI_SEED_POOL\"}";
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
  ' "$GGUI_DIR/package.json"
  echo "GGUI_SEED_POOL=$GGUI_SEED_POOL" >> "$APP_DIR/.env.local"
fi

echo "[boot] pnpm install ($SDK, Verdaccio-pinned)"
( cd "$APP_DIR" && pnpm install )

echo "[boot] pnpm dev ($SDK) — 4 servers, foreground (harness owns teardown)"
cd "$APP_DIR"
exec pnpm dev --verbose
