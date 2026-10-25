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
# The base is pinned by digest (its multi-arch index), not by tag: the Node.js patch release and the base OS
# packages are then part of the commit, and a bump is a reviewed change that moves the source hash instead of
# drift at build time. Both stages use the same digest.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS prep
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
# Debian, not alpine (ggui#973). Two browser users, two browsers, each a function of the LOCK (ggui#1853):
#   - ui-gen's visual JUDGE launches chrome-headless-shell at the build id the lock-resolved puppeteer-core names in
#     PUPPETEER_REVISIONS (PUPPETEER_EXECUTABLE_PATH; pinned by visual-evaluator.launch.test.ts — the
#     @sparticuz/chromium fallback is taken only when the env var is absent). The minting image derives the same
#     build the same way (ggui#1854), because #1076 needs the mint's captures and the judge's from one renderer.
#   - `validateContractBehavior` (playwright-core, via bench.mjs's adapter) launches the headless shell the
#     lock-resolved playwright-core names in its browsers.json. It checks behaviour, not pixels, so it is not the
#     judge's renderer and keeps its own library's supported build.
# Both are downloaded ONCE, here, at bake, by build id — never by a package at install time and never at run time —
# and a bake fails unless each resolves every shared library and renders a page. Until #1853 both launched an
# unpinned apt `chromium`, which moved 154 → 155 between two windows with no commit.
#
# Fonts (ggui#1180): the judge renders the VISITOR's font stack
# (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
# Arial, sans-serif`) on an image that ships only the Liberation faces. Left to
# fontconfig's defaults, body and heading text came out in Liberation MONO on
# every canvas — a face no visitor sees, scored as "technical rather than
# welcoming" on every cell — while <button>'s UA font resolved to Sans. The
# aliases below map each family of that stack and the generics to the
# Liberation face a visitor's sans/serif/mono would be, and the build ASSERTS
# the resolution: an image whose `sans-serif` is not Liberation Sans does not
# build. The design token itself is never touched — it is the visitor's stack.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app
ENV NODE_ENV=production

# The browsers' system libraries, recorded, not pinned (pixel-neutral: a headless shell carries its own Skia and
# FreeType): headless-shell's `ldd` closure on this base, the same 21-library set measured for the minting image (ggui#1854); the
# bake re-checks it below. fontconfig and unzip from apt too; unzip leaves once the browsers are installed.
# The fallback face, named rather than implied: fonts-dejavu-core is the FIRST alternative of fontconfig-config's
# `fonts-dejavu-core | … | fonts-liberation | …` dependency, so with Liberation now from the tarball apt would pull it
# anyway. Naming it makes the judge's fallback face for glyphs Liberation lacks a stated part of the image, identical
# to the minting image's (ggui#1854, #1076), instead of an outcome of alternation order.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core unzip \
       libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libdbus-1-3 libexpat1 libgbm1 libglib2.0-0 \
       libnspr4 libnss3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2

# The Liberation faces (OFL), pinned by CONTENT (ggui#1853; fonts change pixels): the upstream 2.1.5 release tarball,
# verified by sha256 before it is unpacked — the same artifact the minting image installs (ggui#1854). A changed artifact
# fails the build; it never installs. Then the ggui#1180 aliases, asserted.
ARG LIBERATION_URL=https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz
ARG LIBERATION_SHA256=7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0
RUN node -e "const {createHash}=require('node:crypto');const fs=require('node:fs');fetch(process.argv[1]).then(async r=>{if(!r.ok)throw new Error('liberation fetch '+r.status);const b=Buffer.from(await r.arrayBuffer());const h=createHash('sha256').update(b).digest('hex');if(h!==process.argv[2])throw new Error('liberation sha256 '+h+' != '+process.argv[2]);fs.writeFileSync('/tmp/liberation.tgz',b)}).catch(e=>{console.error(e.message);process.exit(1)})" "$LIBERATION_URL" "$LIBERATION_SHA256" \
  && mkdir -p /usr/share/fonts/truetype/liberation \
  && tar -xzf /tmp/liberation.tgz -C /usr/share/fonts/truetype/liberation --strip-components=1 --wildcards '*.ttf' \
  && rm /tmp/liberation.tgz \
  && printf '%s\n' \
       '<?xml version="1.0"?>' \
       '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' \
       '<fontconfig>' \
       '  <!-- ggui#1180: the visitor stack and the generics resolve to the Liberation faces. -->' \
       '  <alias binding="same"><family>-apple-system</family><prefer><family>Liberation Sans</family></prefer></alias>' \
       '  <alias binding="same"><family>BlinkMacSystemFont</family><prefer><family>Liberation Sans</family></prefer></alias>' \
       '  <alias binding="same"><family>Segoe UI</family><prefer><family>Liberation Sans</family></prefer></alias>' \
       '  <alias binding="same"><family>Roboto</family><prefer><family>Liberation Sans</family></prefer></alias>' \
       '  <alias binding="same"><family>Helvetica Neue</family><prefer><family>Liberation Sans</family></prefer></alias>' \
       '  <alias binding="same"><family>system-ui</family><prefer><family>Liberation Sans</family></prefer></alias>' \
       '  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family></prefer></alias>' \
       '  <alias><family>serif</family><prefer><family>Liberation Serif</family></prefer></alias>' \
       '  <alias><family>monospace</family><prefer><family>Liberation Mono</family></prefer></alias>' \
       '</fontconfig>' \
       > /etc/fonts/conf.d/60-ggui-judge-fonts.conf \
  && fc-cache -f \
  && fc-match sans-serif | grep -q 'Liberation Sans' \
  && fc-match Roboto | grep -q 'Liberation Sans' \
  && fc-match system-ui | grep -q 'Liberation Sans' \
  && fc-match monospace | grep -q 'Liberation Mono'
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    BENCH_PLAYWRIGHT=1

ARG GIT_SHA=dev
# Hash of the SOURCE the image measures: every tracked file (tests excluded)
# of the workspace packages the runner ships, plus the workspace and build
# configuration — see `make bench-source-hash` (ggui#766, #1310). The publish
# gate compares this, not GIT_SHA, to decide whether an update exists: the
# image also rebuilds on unrelated pnpm-lock churn, which is not an update.
ARG BENCH_SOURCE_HASH=dev
LABEL org.opencontainers.image.revision=$GIT_SHA
LABEL ai.ggui.bench.source-hash=$BENCH_SOURCE_HASH
LABEL org.opencontainers.image.source="https://github.com/ggui-ai/ggui"
LABEL org.opencontainers.image.licenses="Apache-2.0"
ENV GIT_SHA=$GIT_SHA
ENV BENCH_SOURCE_HASH=$BENCH_SOURCE_HASH

COPY --from=prep --chown=node:node /prep ./

# ggui#1853 — the browsers, each a function of the LOCK, installed from Chrome for Testing by build id:
#   judge:    chrome-headless-shell at puppeteer-core's PUPPETEER_REVISIONS, by the @puppeteer/browsers puppeteer-core
#             depends on, linked at a fixed path for PUPPETEER_EXECUTABLE_PATH (the minting image's recipe, ggui#1854);
#   contract: playwright-core's own `install chromium-headless-shell` (the build its browsers.json names) under
#             PLAYWRIGHT_BROWSERS_PATH, which the adapter launches with no executablePath.
# The bake fails unless every shared library resolves (`ldd`, no "not found") and each binary renders a page.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers/playwright
RUN set -eu; \
  rev=$(node --input-type=module -e "const m = await import('/app/node_modules/puppeteer-core/lib/puppeteer/revisions.js'); process.stdout.write(m.PUPPETEER_REVISIONS['chrome-headless-shell'])"); \
  test -n "$rev"; \
  cli=$(node -e "const p=require('node:path');process.stdout.write(p.join(p.dirname(require.resolve('@puppeteer/browsers/package.json',{paths:['/app/node_modules/puppeteer-core']})),'lib/main-cli.js'))"); \
  exe=$(node "$cli" install "chrome-headless-shell@$rev" --path /opt/browsers --format '{{path}}' | tail -1); \
  test -x "$exe"; \
  ln -s "$exe" /opt/browsers/chrome-headless-shell-current; \
  node /app/node_modules/playwright-core/cli.js install chromium-headless-shell; \
  pw=$(find /opt/browsers/playwright -type f -name chrome-headless-shell -perm -u+x | head -1); \
  test -x "$pw"; \
  for b in "$exe" "$pw"; do \
    if ldd "$b" | grep -q 'not found'; then ldd "$b" | grep 'not found'; exit 1; fi; \
    "$b" --headless --no-sandbox --disable-dev-shm-usage --disable-gpu --dump-dom 'data:text/html,<p>ggui-browser-ok</p>' 2>/dev/null | grep -q 'ggui-browser-ok'; \
  done; \
  printf '{"judge":{"browser":"chrome-headless-shell","build":"%s","from":"puppeteer-core@%s"},"contract":{"browser":"chromium-headless-shell","path":"%s","from":"playwright-core@%s"}}\n' \
    "$rev" "$(node -p "require('/app/node_modules/puppeteer-core/package.json').version")" \
    "$pw" "$(node -p "require('/app/node_modules/playwright-core/package.json').version")" > /app/browsers.json; \
  cat /app/browsers.json; \
  apt-get purge -y --auto-remove unzip >/dev/null; \
  rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/opt/browsers/chrome-headless-shell-current
# The image's IDENTITY (ggui#1310, ggui#1853): the node packages are the lock's, the browsers are named by them, and
# the system packages come from the base's apt, so the final tree records what it ships — every installed package's
# name, version and file hash, plus Node, the OS release and every dpkg package — after every strip and purge above,
# so it reads what runs. /app/browsers.json names both browser builds. `sha256sum /app/installed-set.json` reproduces the set hash in the `.sha256` file.
RUN node scripts/installed-set.mjs --root /app --out /app/installed-set.json
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
