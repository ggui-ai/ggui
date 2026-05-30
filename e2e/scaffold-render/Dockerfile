# Cell image for the scaffold-render e2e. The browser AND the scaffolded app
# both run inside this container, so every iframe runtime-bundle / WS fetch is
# localhost (no --public-base-url). Only Playwright + Chromium (the heavy
# download) are baked so cell start is fast; the monorepo is bind-mounted at
# /repo (read-write) — see docker-compose.yml — so the cell tests CURRENT source.
#
# NOTE: the @playwright/test runner version is resolved from the workspace
# (^1.40.0). cell-entry.sh runs `playwright install chromium` after `pnpm
# install` so the browser matches the resolved runner even if it differs from
# this image's baked version.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# pnpm pinned to the monorepo root's packageManager so the in-cell build matches.
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

# curl: setup.sh polls Verdaccio's /-/ping. git: create-agentic-app clones the
# assembled template repo and setup.sh git-inits it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
# The monorepo is bind-mounted at /repo at run time (see docker-compose.yml);
# this entrypoint assumes that mount is present.
ENTRYPOINT ["bash", "/repo/oss/e2e/scaffold-render/scripts/cell-entry.sh"]
