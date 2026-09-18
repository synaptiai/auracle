# syntax=docker/dockerfile:1
#
# One image, five processes. `docker run <image> consumer` picks one.
#
# Two stages, because a runtime image must not carry the toolchain. The
# repository's five entry points all ran `pnpm run build && node dist/...`,
# so a naive image would need TypeScript, the test runner and the dev
# dependencies to start a daemon. Here the build happens once, in a stage
# that is thrown away, and the runtime stage receives compiled JavaScript
# and production dependencies only.
#
# The console is a separate package (DEC-11 keeps the core free of a new
# interface). It reads the core through the `auracle` workspace link, whose
# `exports` map points into `dist/`, so both trees are copied and the link is
# recreated by a production install rather than carried across.

ARG NODE_VERSION=22
# Pinned by digest, not by tag alone. `node:22-bookworm-slim` moves, so two
# builds of one commit can carry different base layers and a re-pushed
# upstream tag enters the deployed image with no diff here. Move it
# deliberately: `docker buildx imagetools inspect node:22-bookworm-slim`
# prints the current digest, and the tag beside it says what it is.
ARG NODE_DIGEST=sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# ---------------------------------------------------------------- build ----
FROM node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST} AS build
WORKDIR /app

# The version is pinned here and in package.json's `packageManager` field.
# An install by another pnpm produces a tree no workflow validates.
ARG PNPM_VERSION=11.20.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Manifests first, so a source edit does not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY console/package.json ./console/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY console ./console
# The solution build: the core, then the console, which references it.
RUN pnpm run build

# -------------------------------------------------------------- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST} AS runtime
WORKDIR /app
ENV NODE_ENV=production

ARG PNPM_VERSION=11.20.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY console/package.json ./console/
# Production dependencies only: no TypeScript, no vitest, no testcontainers.
# This also recreates console/node_modules/auracle as a link to the root
# package, which is how the console resolves `auracle/ledger-read` at runtime.
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

COPY --from=build /app/dist ./dist
COPY --from=build /app/console/dist ./console/dist
# The ledger migration reads these, and the migrate process is one of the six
# commands below.
COPY db ./db
# The consumer resolves `../../fixtures/taxonomy.json` from its own location
# in `dist/` and refuses to start without it (section 4.11 step 4). Found by
# running the image, not by building it: the build is silent about a file
# read at runtime.
#
# `.dockerignore` holds back `fixtures/gold/`, which is 10MB of gold corpus
# that only the offline jobs read. No process this image starts opens it.
COPY fixtures ./fixtures

# The channel map the ingress processes read at startup (DEC-47).
# products.json sits at the working directory, which is where
# `productCatalogueFromEnv` looks when PRODUCTS_FILE names no other path.
# Found by running the image, not by building it: the build is silent about
# a file read at runtime, and a missing one refuses the process at startup.
COPY products.json ./products.json

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# node, not root. Every process here opens outbound connections and one binds
# a port; none needs to write to the image.
USER node

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# No default. A container started with no argument names no process, and
# guessing one would start a daemon nobody asked for.
CMD []
