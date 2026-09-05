#!/usr/bin/env bash
#
# Per-SDK: compose the app DIRECTLY from oss/samples/* (compose-app.mjs),
# install it (Verdaccio-pinned @ggui-ai/* cohort), write `.env.local`, then run
# `pnpm dev` in the FOREGROUND. The harness backgrounds this whole script as a
# process group and tears it down on teardown (see composed-app-harness.ts).
#
# Compose WITHOUT install, write a project `.npmrc` pinning the registry, then
# install — the only reliable way to keep pnpm's nested resolution on Verdaccio
# (proven in the scaffolder-era sub-tier A; env-var registry/cache settings are
# silently ignored by pnpm 11).
#
# The `with-guuey` SDK key takes its own branch below: guuey's layout (agent
# half at the app root), standalone per-dir npm installs (scoped Verdaccio
# registry), and a 3-process boot (ggui serve :6781 → `guuey dev --serve`
# :6790 → web :6890) instead of the app-shell's `pnpm dev`.
#
# Inputs (env):
#   SDK                (required) claude-agent-sdk | openai-agents-sdk | google-adk | with-guuey
#   APP_DIR            (required) where to compose the app
#   REGISTRY           (default http://localhost:4874) the Verdaccio base URL
#   ANTHROPIC_API_KEY  (required) drives ggui's UI generation AND the claude/guuey agents
#   OPENAI_API_KEY / GOOGLE_API_KEY  (optional) forwarded for the non-claude agents
set -euo pipefail
: "${SDK:?}" "${APP_DIR:?}"
REGISTRY="${REGISTRY:-http://localhost:4874}"
# The claude-sdk lanes (cache-hit, seed-pool) always generate with Claude, so
# the Anthropic key is required regardless of which agent SDK is under test.
: "${ANTHROPIC_API_KEY:?compose-and-boot needs ANTHROPIC_API_KEY (ggui generation + claude agent)}"

COMPOSER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/compose-app.mjs"
REGISTRY_HOST_PORT="${REGISTRY#http://}"; REGISTRY_HOST_PORT="${REGISTRY_HOST_PORT%/}"
APP_PARENT="$(dirname "$APP_DIR")"

# The agent backend is unified to port 6790 across all SDK variants — the
# app-shell's dev.mjs for the framework lanes, and `guuey dev --serve`'s own
# default for the with-guuey lane. The web SPA reaches it via
# VITE_AGENT_ENDPOINT_URL / the render scenario's ?agent= param (framework
# lanes) or its built-in localhost:6790 default (with-guuey).
AGENT_PORT=6790

rm -rf "$APP_DIR"
echo "[boot] composing $SDK → $APP_DIR (from oss/samples/*)"
node "$COMPOSER" --sdk="$SDK" --out="$APP_DIR"

if [ "$SDK" = "with-guuey" ]; then
  # ────────────────────────────────────────────────────────────────────────────
  # CELL-AS-JAIL — a WRITTEN decision (spec §2 of the composed golden path),
  # not an accident someone discovers:
  #   guuey's dev path is UNJAILED on every platform, and the CLI forwards its
  #   entire process env to the agent worker ({...process.env,
  #   GUUEY_AGENT_SNAPSHOT}); @guuey/host auto-allows Bash + file tools
  #   whenever FS layers are bound, assuming an EXTERNAL jail. Decision: the
  #   throwaway docker cell IS the isolation boundary — one ephemeral
  #   container per run, no secrets beyond the one API key, torn down after
  #   the journey. That is why `guuey dev` below runs under `env -i` with ONLY
  #   HOME/PATH/ANTHROPIC_API_KEY — never a developer-shaped environment. A
  #   host-side run of this branch gets the same minimal-env posture but no
  #   container wall: treat it as standard dev-server trust.
  # ────────────────────────────────────────────────────────────────────────────

  # Per-dir installs for the standalone halves — this composed tree is NOT a
  # pnpm workspace. The .npmrc scopes ONLY @ggui-ai:registry to Verdaccio:
  # the default registry stays real npm so the exact-pinned @guuey/* leaves
  # resolve from the real registry rather than through the Verdaccio proxy.
  # (The framework lanes' global `registry=` pin below is a pnpm-workspace
  # idiom — deliberately NOT copied here.) compose-app.mjs already stripped
  # the samples' committed package-lock.json from the copy: their `resolved`
  # URLs point @ggui-ai/* at registry.npmjs.org, which would silently bypass
  # THIS run's Verdaccio cohort — the exact false-green the gate exists to
  # prevent. The per-run npm cache mirrors the pnpm cache-dir rationale:
  # each run republishes @ggui-ai/* at the SAME cohort version, and a shared
  # cache would serve a stale tarball or fail integrity.
  for dir in . apps/web servers/ggui servers/mcps/todo; do
    cat > "$APP_DIR/$dir/.npmrc" <<EOF
@ggui-ai:registry=$REGISTRY/
//$REGISTRY_HOST_PORT/:_authToken=samples-render-token
cache=$APP_PARENT/npm-cache
audit=false
fund=false
EOF
    echo "[boot] npm install ($dir)"
    ( cd "$APP_DIR/$dir" && npm install --no-progress --loglevel=error )
  done

  # Kill this branch's background boot legs before a failing exit so a broken
  # boot never orphans servers holding 6781/6790 for the next run.
  # `kill $(jobs -p)` reached only each leg's subshell/npm — never the
  # `node … serve` grandchild — so a failed boot left ggui serve holding
  # :6781 and the retry's preflight refused (ggui#873 / #866's real
  # mechanism). Walk each job's tree instead. The legs stay in THIS script's
  # process group on purpose: the harness's normal teardown SIGTERMs that
  # group, and that path is unchanged.
  kill_tree() {
    local p="$1" c
    for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
    kill -TERM "$p" 2>/dev/null || true
  }
  die_boot() {
    echo "[boot] $1" >&2
    for j in $(jobs -p); do kill_tree "$j"; done
    sleep 1
    for j in $(jobs -p); do
      for c in $(pgrep -P "$j" 2>/dev/null); do kill -KILL "$c" 2>/dev/null || true; done
      kill -KILL "$j" 2>/dev/null || true
    done
    exit 1
  }

  # guuey dev --serve >=0.17.0 answers readiness on /readyz (0.16.x: /healthz —
  # a probe rename in a 0.x minor, ggui#873); the cells pin 0.17.0 exact.
  # Boot order (spec §1): ggui serve FIRST on 6781 — exactly where the guuey
  # CLI's injected `ggui` mcpServer default points (the composed guuey.json
  # declares no `ggui` entry on purpose; `guuey dev` injects
  # http://localhost:6781/mcp when absent). It inherits this script's full
  # env: ANTHROPIC_API_KEY for UI generation plus the harness's
  # GGUI_CACHE_TRACE_STDERR / GGUI_EMBEDDING_CACHE_DIR diagnostics.
  # PORT pinned explicitly (the sample's start script defaults to 6781, but a
  # stray PORT env var — common on CI runners — would re-bind it).
  echo "[boot] ggui serve --mcp-only on :6781 (servers/ggui, with-guuey)"
  ( cd "$APP_DIR/servers/ggui" && exec env PORT=6781 npm run start ) &

  # `guuey dev` treats the injection as config, not a health check — waiting
  # here attributes a broken ggui boot to THIS step instead of a downstream
  # invoke timeout. Any HTTP answer counts (the MCP mount 405s plain GETs).
  for _ in $(seq 1 120); do
    curl -s -o /dev/null "http://localhost:6781/mcp" && break
    sleep 1
  done
  curl -s -o /dev/null "http://localhost:6781/mcp" \
    || die_boot "ggui serve did not answer on :6781"

  # MINIMAL ENV (see the jail note): the CLI forwards process.env wholesale
  # to the agent worker, so it gets ONLY the one key + PATH/HOME hygiene.
  # `guuey dev` spawns the colocated todo MCP itself (`pnpm run dev` in the
  # rewritten guuey.json's source dir with PORT=6740) and reads the key from
  # env first — no .env.local is written on this branch, so the key never
  # lands on disk. --port pins the published default (6790) explicitly.
  echo "[boot] guuey dev --serve on :$AGENT_PORT (minimal env — cell-as-jail)"
  ( cd "$APP_DIR" \
      && exec env -i HOME="$HOME" PATH="$PATH" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        npx guuey dev --serve --port "$AGENT_PORT" ) &

  for _ in $(seq 1 120); do
    curl -sf "http://localhost:$AGENT_PORT/readyz" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "http://localhost:$AGENT_PORT/readyz" >/dev/null 2>&1 \
    || die_boot "guuey dev --serve did not answer /readyz on :$AGENT_PORT (@guuey/cli >=0.17.0 probe; 0.16.x served /healthz)"

  # Web half in the FOREGROUND on the harness's web port (6890 — also the
  # vite config's own default; pinned explicitly so a stray PORT/CI env var
  # can never re-bind it). The app's endpoint default is localhost:6790 and
  # its vite config self-boots the second-origin sandbox proxy on 7890. The
  # harness owns teardown of this whole process group; both background legs
  # above are in it.
  echo "[boot] web SPA (vite) on :6890, foreground (harness owns teardown)"
  cd "$APP_DIR/apps/web"
  exec env VITE_SERVER_PORT=6890 npm run dev
fi

# Project-level .npmrc pins the install to Verdaccio. A project .npmrc beats env
# vars and is honored by the workspace pnpm install across every nested package.
# Per-run cache/store dirs keep it hermetic: each run republishes @ggui-ai/* at
# the SAME cohort version, and a shared cache keyed by the registry host would
# reject the new tarball with ERR_PNPM_TARBALL_INTEGRITY.
cat > "$APP_DIR/.npmrc" <<EOF
registry=$REGISTRY/
//$REGISTRY_HOST_PORT/:_authToken=samples-render-token
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
  # GGUI_MCP_URL is a remote pod URL the shell dev.mjs's `isRemoteGguiUrl` SKIPS
  # the local ggui service and the agent (which reads GGUI_MCP_BEARER from this
  # file via dotenv) authenticates to the deployed `mcp.ggui.ai/apps/<id>`. The
  # todo MCP (6782) stays local — only UI generation moves to the cloud pod.
  if [ -n "${GGUI_MCP_URL:-}" ]; then
    echo "GGUI_MCP_URL=$GGUI_MCP_URL"
    if [ -n "${GGUI_MCP_BEARER:-}" ]; then echo "GGUI_MCP_BEARER=$GGUI_MCP_BEARER"; fi
  fi
} > "$APP_DIR/.env.local"

# ── Cross-deployment seed-pool e2e wiring (env-gated) ─────────────────────────
# Both blocks are no-ops unless the harness set the env var, so the existing
# render.spec / cache-hit.spec compositions are byte-for-byte unaffected. Edits
# are applied to the COMPOSED COPY only — never to oss/samples/*.
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
