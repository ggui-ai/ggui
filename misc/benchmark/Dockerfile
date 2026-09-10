# @ggui-ai/benchmark — daily-bench runner image
#
# Multi-stage build:
#   1. `prep` stage: copies the full `deploy/` (output of pnpm deploy run
#      OUTSIDE Docker via the bench-deploy Make target) and strips
#      transitively-pulled giants that bench doesn't load at runtime.
#      Each strip RUN is in this stage so the final image's COPY only
#      sees the SLIM result — no orphan giants in committed layers.
#   2. `runtime` stage: debian-slim base + Chromium, COPY --from=prep of the slim tree.
#      Final image is the only one tagged + pushed.
#
# Build (from workspace root):
#   make bench-image                   # local: builds deploy/ + tags ggui-benchmark:dev
#   make bench-push                    # sandbox: also pushes to ECR
#
# Runs daily on Fargate (apps/benchmarks/amplify/ — EventBridge rule).
# Same image runs locally for OSS users — there is no published image;
# build it from source, then run:
#   docker build -t ggui-benchmark .
#   docker run --env-file .env -e S3_BUCKET=… ggui-benchmark
#
# Required env at runtime:
#   S3_BUCKET                 — destination bucket name
#   S3_PREFIX                 — key prefix (e.g. "data/"), include trailing slash
#   ANTHROPIC_API_KEY         — for claude provider
#   OPENAI_API_KEY            — for openai provider
#   GEMINI_API_KEY            — for google provider
# Optional:
#   BENCH_PROVIDERS           — default: "claude,openai,google"
#   BENCH_COMMITS             — default: 8-prompt v0 corpus
#   BENCH_THRESHOLD           — default: 70
#   BENCH_DATE                — override target date (YYYY-MM-DD, default: today UTC)

# ─── Prep stage: strip the giants in transient layers ─────────────────
FROM node:24-bookworm-slim AS prep
WORKDIR /prep

COPY deploy/ ./

# Strip giants that ui-gen pulls transitively but bench doesn't load at
# runtime. ~700MB savings vs unstripped:
#   onnxruntime-node          ~520MB — local embedding (cloud uses Bedrock)
#   onnxruntime-web           ~69MB  — browser embedding shim
#   @huggingface/transformers ~48MB  — local embedding pipeline
#   @img/sharp-libvips-*      ~33MB  — image processing
#   turbo-linux-64            ~35MB  — build tool, not runtime
#   vitest                    devDep — present via workspace hoist
#
# happy-dom retained (~19MB) — required at runtime by @ggui-ai/ui-gen's
# runtime-render-check probe (render-check.ts does `await import("happy-dom")`);
# stripping it silently degrades that eval tier to "skipped" while the cell
# still reports PASS, so the runtime-render probe never actually runs.
#
# typescript STAYS — @ggui-ai/ui-gen/dist/adapters imports it at runtime
# (despite ~23MB cost). Stripping breaks the bench at first generation.
#
# If a future bench surface brings any of the above back into the
# runtime path, remove the corresponding line below — the runner fails
# loud at import time rather than silently shipping stripped deps.
RUN find node_modules/.pnpm \
      -maxdepth 1 -type d \
      \( -name "onnxruntime-node@*" \
       -o -name "onnxruntime-web@*" \
       -o -name "@huggingface+transformers@*" \
       -o -name "@img+sharp-libvips-*" \
       -o -name "turbo-linux-64@*" \
       -o -name "vitest@*" \
      \) \
      -exec rm -rf {} + \
 && find node_modules \
      \( -name "*.map" -o -name "*.test.ts" -o -name "*.test.js" \) \
      -delete 2>/dev/null || true

# ─── Runtime stage: clean alpine, COPY only the slim tree ─────────────
# Debian, not alpine (ggui#973): the runner now carries a Chromium binary at
# /usr/bin/chromium. TODAY only `validateContractBehavior` (playwright-core,
# via bench.mjs's adapter) uses it; ui-gen's visual judge (puppeteer-core)
# still launches @sparticuz/chromium's own glibc-built binary and ignores
# PUPPETEER_EXECUTABLE_PATH until rnd's evaluator change lands — the env var
# is exported now so that change needs no image rebuild. No package ever
# downloads a browser at install or run time.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    BENCH_PLAYWRIGHT=1

ARG GIT_SHA=dev
# Hash of the triad/runner SOURCE the image measures (git tree hashes of
# ui-gen/src, benchmark/src, benchmark/scripts + the triad packages'
# package.json — see `make bench-image`). The publish gate compares this,
# not GIT_SHA, to decide whether an update exists: the image also
# rebuilds on unrelated pnpm-lock churn, which is not an update (ggui#766).
ARG BENCH_SOURCE_HASH=dev
LABEL org.opencontainers.image.revision=$GIT_SHA
LABEL ai.ggui.bench.source-hash=$BENCH_SOURCE_HASH
LABEL org.opencontainers.image.source="https://github.com/ggui-ai/ggui"
LABEL org.opencontainers.image.licenses="Apache-2.0"
ENV GIT_SHA=$GIT_SHA
ENV BENCH_SOURCE_HASH=$BENCH_SOURCE_HASH

COPY --from=prep --chown=node:node /prep ./
# COPY --chown sets ownership on copied FILES but not on the WORKDIR
# itself. /app stays root:root, so `mkdir /app/benchmark-results` (which
# bench.mjs does to write the report JSON) hits EACCES under USER node.
# Explicit chown of the directory itself lets node create new entries.
RUN chown node:node /app

USER node
# The image runs the public benchmark by default. A task definition that
# reuses it for another script (the experiment eval leg, scripts/eval-cell.mjs)
# MUST override `entryPoint`, not `command`: ECS appends `command` to this
# ENTRYPOINT as arguments, so a `command` override runs run-and-publish with
# junk args instead. Bought 2026-09-10 (first Exp 008 eval task).
ENTRYPOINT ["node", "--import", "tsx", "scripts/run-and-publish.mjs"]
