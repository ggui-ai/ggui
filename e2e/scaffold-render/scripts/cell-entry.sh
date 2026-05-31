#!/usr/bin/env bash
#
# In-cell orchestrator for the scaffold-render e2e. ONE ephemeral container
# (`docker run --rm`, attached): copy the READ-ONLY-mounted monorepo into a
# writable /work (so the host's node_modules are never touched), start Verdaccio
# as a LOCAL PROCESS (no DinD / sibling), then build → publish → scaffold → boot
# → Playwright — all on the container's own localhost (browser-in-cell). Logs
# stream to the host; the container is removed on exit; the exit code is the
# test result.
set -euo pipefail

echo "[cell] copy /repo → /work (source only — node_modules/.git/dist/.turbo excluded)"
rsync -a \
  --exclude='node_modules/' --exclude='.git/' --exclude='dist/' \
  --exclude='dist-server/' --exclude='.next/' --exclude='.turbo/' \
  --exclude='e2e-results/' --exclude='*.log' \
  /repo/ /work/
cd /work

echo "[cell] start Verdaccio (process) on :4873"
# Same verdaccio.yaml as the host path (@ggui-ai/* proxy-free, 50mb body); it
# listens on 0.0.0.0:4873 and stores under /verdaccio (created in the image).
verdaccio --config /work/oss/e2e/scaffold-resolution/verdaccio.yaml >/tmp/verdaccio.log 2>&1 &
for _ in $(seq 1 60); do curl -sf http://localhost:4873/-/ping >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://localhost:4873/-/ping >/dev/null 2>&1 || {
  echo "[cell] Verdaccio failed to start:" >&2
  cat /tmp/verdaccio.log >&2
  exit 1
}
echo "[cell] Verdaccio is up"

echo "[cell] pnpm install (workspace, fresh in /work)"
# CI is hermetic (frozen); local allows lockfile updates.
if [ -n "${CI:-}" ]; then FROZEN=--frozen-lockfile; else FROZEN=--frozen-lockfile=false; fi
pnpm install "$FROZEN"

echo "[cell] install the Playwright browser + OS deps (matches the resolved runner)"
# --with-deps apt-installs Chromium's shared libs (the node:24 base has none);
# needs root (the container's default user).
pnpm --filter @ggui-ai/e2e-scaffold-render exec playwright install --with-deps chromium

echo "[cell] run scaffold-render scenarios (Verdaccio process → SKIP_VERDACCIO_BOOT=1)"
# The harness's setup.sh inherits these: REGISTRY points at our process, and
# SKIP_VERDACCIO_BOOT=1 stops it from trying to `docker run` its own Verdaccio.
export REGISTRY=http://localhost:4873 SKIP_VERDACCIO_BOOT=1
exec pnpm --filter @ggui-ai/e2e-scaffold-render exec playwright test --project=scaffold-render
