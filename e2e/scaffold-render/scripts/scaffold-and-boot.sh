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

# Each SDK's agent backend binds a different port (dev.mjs AGENT_PORT, per shell).
# The web SPA reaches it via VITE_AGENT_ENDPOINT_URL, so that must match the SDK.
case "$SDK" in
  claude-agent-sdk) AGENT_PORT=6790 ;;
  openai-agents-sdk) AGENT_PORT=6791 ;;
  google-adk) AGENT_PORT=6792 ;;
  *) echo "scaffold-and-boot: unknown SDK '$SDK'" >&2; exit 1 ;;
esac

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
} > "$APP_DIR/.env.local"

echo "[boot] pnpm install ($SDK, Verdaccio-pinned)"
( cd "$APP_DIR" && pnpm install )

echo "[boot] pnpm dev ($SDK) — 4 servers, foreground (harness owns teardown)"
cd "$APP_DIR"
exec pnpm dev --verbose
