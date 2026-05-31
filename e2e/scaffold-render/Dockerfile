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
# mutates the host's node_modules (whose native-module ABI may differ from this
# image's Node). The image carries only the toolchain; source arrives at run time.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# Install pnpm DIRECTLY via npm (not corepack): the corepack bundled in the
# Playwright image has stale signing keys and fails pnpm's signature check
# ("Cannot find matching keyid"). Pin to the monorepo root's packageManager.
# curl: Verdaccio /-/ping wait. git: create-agentic-app clones the assembled
# template repo + setup.sh git-inits it. rsync: copy the RO repo into /work.
# verdaccio: the local registry — a PROCESS, not a sibling container / DinD.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git rsync \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@11.2.2 verdaccio@5

# verdaccio.yaml points storage + htpasswd at /verdaccio (its docker-image
# convention); create it writable so the SAME config works in process mode.
# /work is the writable copy of the RO-mounted repo.
RUN mkdir -p /verdaccio /work && chmod 1777 /verdaccio /work

WORKDIR /work
# The monorepo is bind-mounted READ-ONLY at /repo at run time
# (see `make test-scaffold-render`). This entrypoint assumes that mount.
ENTRYPOINT ["bash", "/repo/oss/e2e/scaffold-render/scripts/cell-entry.sh"]
