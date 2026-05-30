#!/usr/bin/env bash
#
# In-cell orchestrator for the scaffold-render e2e. Verdaccio is a SIBLING
# compose service (no docker-in-docker): REGISTRY points at it and
# SKIP_VERDACCIO_BOOT=1 tells setup.sh not to boot its own. The browser AND the
# scaffolded app both run INSIDE this container, so every iframe runtime-bundle
# / WS fetch is localhost — no --public-base-url gymnastics.
#
# The monorepo is bind-mounted at /repo (read-write). In CI that is a fresh
# checkout (clean install); locally it reuses your worktree's node_modules/dist
# (both gitignored, regenerable). See README "Container caveats".
set -euo pipefail
cd /repo

echo "[cell] pnpm install (repo workspace — needed to build + publish the cohort)"
# CI is a fresh checkout → enforce a frozen lockfile (hermetic, catches drift).
# Local runs reuse a possibly-dirty worktree → allow lockfile updates.
if [ -n "${CI:-}" ]; then FROZEN=--frozen-lockfile; else FROZEN=--frozen-lockfile=false; fi
pnpm install "$FROZEN"

echo "[cell] match the Playwright browser to the installed test runner"
# Fail loudly if the browser install breaks — a missing/mismatched Chromium is a
# cryptic test failure otherwise. (The baked image browser is just a warm cache.)
pnpm --filter @ggui-ai/e2e-scaffold-render exec playwright install chromium

echo "[cell] run scaffold-render scenarios (REGISTRY=${REGISTRY:-unset}, SDK=${SDK:-claude-agent-sdk})"
# The harness's ensureSetup runs setup.sh (build → publish → assemble) on first
# spawn, inheriting REGISTRY + SKIP_VERDACCIO_BOOT from this cell's environment.
exec pnpm --filter @ggui-ai/e2e-scaffold-render exec playwright test --project=scaffold-render
