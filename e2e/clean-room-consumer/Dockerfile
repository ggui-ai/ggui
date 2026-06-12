# Clean-room-consumer runner image.
#
# Builds every publishable @ggui-ai/* package from source. At runtime
# `run-gate.sh` publishes them to Verdaccio, then installs them into a
# clean-room consumer that has zero workspace linkage.
#
# Build context is the `oss/` workspace root — see docker-compose.yml.
# The gate scripts + consumer template are bind-mounted at /gate so the
# gate logic iterates without an image rebuild.
FROM node:22-bookworm-slim

# pnpm via corepack, pinned to the monorepo's version.
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

# curl — run-gate.sh polls Verdaccio's /-/ping endpoint.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . /build/

# Fresh install + build inside the image. node_modules / dist from the
# host are excluded by oss/.dockerignore, so this is hermetic.
#
# Default is --frozen-lockfile: a publish should never happen off a
# lockfile that drifted from the package.jsons. During active
# refactoring, override with:
#   PNPM_INSTALL_FLAGS=--no-frozen-lockfile make test-clean-room-consumer
ARG PNPM_INSTALL_FLAGS=--frozen-lockfile
RUN pnpm install ${PNPM_INSTALL_FLAGS}
# @ggui-ai/ui-gen's tsup DTS build runs in a worker thread that OOMs at
# the default heap on hosted runners (ERR_WORKER_OUT_OF_MEMORY). Same
# bump as ci.yml — workers inherit --max-old-space-size as their default
# heap limit.
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN pnpm -r --filter "./packages/*" build

WORKDIR /gate
ENTRYPOINT ["bash", "/gate/scripts/run-gate.sh"]
