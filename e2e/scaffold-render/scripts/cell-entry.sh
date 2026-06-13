#!/usr/bin/env bash
#
# In-cell orchestrator for the scaffold-render e2e. ONE ephemeral container
# (`docker run --rm`, attached): copy the READ-ONLY-mounted monorepo into a
# writable /work (so the host's node_modules are never touched), start Verdaccio
# as a LOCAL PROCESS (no DinD / sibling), then build → publish → scaffold → boot
# → Playwright — all on the container's own localhost (browser-in-cell). Logs
# stream to the host; the container is removed on exit; the exit code is the
# test result.
#
# Each phase prints a `⏱` lap line so the run log carries a per-step time
# breakdown (the cohort build + scenarios are timed by turbo + Playwright; the
# setup sub-phases are timed inside setup.sh).
set -euo pipefail

_lap=$SECONDS
lap() { echo "[cell] ⏱ $1: $((SECONDS - _lap))s"; _lap=$SECONDS; }

echo "[cell] copy /repo → /work (source only — node_modules/.git/dist/.turbo excluded)"
rsync -a \
  --exclude='node_modules/' --exclude='.git/' --exclude='dist/' \
  --exclude='dist-server/' --exclude='.next/' --exclude='.turbo/' \
  --exclude='e2e-results/' --exclude='*.log' \
  /repo/ /work/
cd /work
lap "copy /repo→/work"

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
lap "verdaccio start"

echo "[cell] pnpm install (workspace, fresh in /work)"
# CI is hermetic (frozen); local allows lockfile updates.
if [ -n "${CI:-}" ]; then FROZEN=--frozen-lockfile; else FROZEN=--frozen-lockfile=false; fi
pnpm install "$FROZEN"
lap "pnpm install (workspace)"

echo "[cell] install the Playwright browser + OS deps (matches the resolved runner)"
# --with-deps apt-installs Chromium's shared libs (the node:24 base has none);
# needs root (the container's default user).
pnpm --filter @ggui-ai/e2e-scaffold-render exec playwright install --with-deps chromium
lap "playwright install --with-deps"

# Surface the matcher's cache-trace decision to stderr in the scaffolded
# `ggui serve`, so a missed semantic match is diagnosable from the captured
# logs. Exported at PROCESS level (not just the scaffolded .env.local) so it
# reaches the serve subprocess via env inheritance through the playwright
# harness → dev.mjs → ggui serve, independent of which servers load .env.local.
# (The env-gated stderr emit lives inside emitCacheTraceEvent itself, so it
# fires even though a bundled CLI's setCacheTraceSink targets a different
# module instance than the matcher.)
export GGUI_CACHE_TRACE_STDERR=1

# Pin the local-embedding model cache to a writable dir the scaffolded serve
# inherits + reuses (the serve logs `[ggui:embedding] local … (cache: …)`).
# When the host mounts a persistent cache (make test-scaffold-render mounts
# one at /models and exports GGUI_EMBEDDING_CACHE_DIR), respect it — that is
# how CI persists the model across runs (actions/cache) so HF is never hit
# on the steady-state path.
export GGUI_EMBEDDING_CACHE_DIR="${GGUI_EMBEDDING_CACHE_DIR:-/work/.ggui-embedding-cache}"

echo "[cell] prefetch the local-embedding model into $GGUI_EMBEDDING_CACHE_DIR"
# One download per CONTAINER (instead of one per scaffolded-app boot), retried
# with backoff: huggingface.co 429s hosted-CI egress IPs, and a missing model
# silently downgrades every cache-hit scenario to mock embeddings / RAG
# failures (2026-06-12 nightly). With a warm mounted cache this is a ~1s
# disk-load no-op. Loud failure after the retries — better than the silent
# downgrade.
pnpm --filter @ggui-ai/embedding-local build
for attempt in 1 2 3 4 5; do
  if node oss/e2e/scaffold-render/scripts/prefetch-embedding-model.mjs; then
    break
  fi
  if [ "$attempt" = 5 ]; then
    echo "[cell] embedding-model prefetch failed after $attempt attempts — aborting (scenarios would silently lose semantic cache matching)" >&2
    exit 1
  fi
  backoff=$((attempt * 30))
  echo "[cell] prefetch attempt $attempt failed — retrying in ${backoff}s"
  sleep "$backoff"
done
lap "embedding-model prefetch"

echo "[cell] run scaffold-render scenarios (Verdaccio process → SKIP_VERDACCIO_BOOT=1)"
# The harness's setup.sh inherits these: REGISTRY points at our process, and
# SKIP_VERDACCIO_BOOT=1 stops it from trying to `docker run` its own Verdaccio.
export REGISTRY=http://localhost:4873 SKIP_VERDACCIO_BOOT=1
exec pnpm --filter @ggui-ai/e2e-scaffold-render exec playwright test --project=scaffold-render
