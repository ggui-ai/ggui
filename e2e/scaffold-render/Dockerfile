# Single self-contained cell image for the scaffold-render e2e.
#
# ONE ephemeral container per run (`docker run --rm`, attached so logs stream to
# the host): it copies the READ-ONLY-mounted monorepo into its own writable
# /work, starts Verdaccio as a LOCAL PROCESS (no docker-in-docker, no sibling
# service), builds + publishes the @ggui-ai/* cohort, scaffolds the published
# app, boots it, and runs Playwright — all on the container's own localhost
# (browser-in-cell, so every iframe runtime-bundle / WS fetch is loopback).
#
# The RO mount + copy-to-/work means the container's fresh install/build never
# mutates the host's node_modules. The image carries only the toolchain.
#
# Node 24 (the monorepo's root engines require `node >=24`; Playwright base
# images bundle older Node (22.x) → pnpm install fails the engine check).
# Sourced from mcr.microsoft.com (NOT docker.io `node:24`): docker.io pulls trip
# this environment's credential helper, while mcr is anonymous + reliable.
# Chromium + its OS deps are installed at run time by `playwright install
# --with-deps chromium` (cell-entry), matching the resolved @playwright/test.
FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm

# Run as root so cell-entry's `playwright install --with-deps` (apt) works; the
# Chromium-as-root sandbox is disabled via --no-sandbox in playwright.config.ts.
USER root

# pnpm pinned to the monorepo root's packageManager; verdaccio = the local
# registry, run as a PROCESS (not a sibling container / DinD).
RUN npm install -g pnpm@11.2.2 verdaccio@5

# curl: Verdaccio /-/ping wait. git: create-agentic-app clones the assembled
# template repo + setup.sh git-inits it. rsync: copy the RO repo into /work.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git rsync \
  && rm -rf /var/lib/apt/lists/*

# verdaccio.yaml points storage + htpasswd at /verdaccio (its docker-image
# convention); create it writable so the SAME config works in process mode.
# /work is the writable copy of the RO-mounted repo.
RUN mkdir -p /verdaccio /work && chmod 1777 /verdaccio /work

WORKDIR /work
# The monorepo is bind-mounted READ-ONLY at /repo at run time
# (see `make test-scaffold-render`). This entrypoint assumes that mount.
ENTRYPOINT ["bash", "/repo/oss/e2e/scaffold-render/scripts/cell-entry.sh"]
