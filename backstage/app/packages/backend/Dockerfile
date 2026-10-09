# Multi-stage build of the platform-lab Backstage image, from source:
#   docker build -f packages/backend/Dockerfile .   (context: backstage/app)
# Based on https://backstage.io/docs/deployment/docker#multi-stage-build
#
# Node comes from Amazon ECR Public's mirror of Docker official images: same digests as
# docker.io/library/node, without Docker Hub's auth service and rate limits.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-trixie-slim

# Stage 1: only the package.json files, so the dependency install below stays cached
# until dependencies actually change (not on every source edit).
FROM ${NODE_IMAGE} AS packages
WORKDIR /app
COPY backstage.json package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY packages packages
COPY plugins plugins
RUN find packages plugins -mindepth 2 -maxdepth 2 \! -name "package.json" -exec rm -rf {} \+

# Toolchain for native modules (better-sqlite3, ...) when no prebuilt binary matches.
FROM ${NODE_IMAGE} AS toolchain
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 g++ build-essential libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*
ENV PYTHON=/usr/bin/python3

# Stage 2: install all dependencies, type-check and build the frontend + backend bundles.
FROM toolchain AS build
USER node
WORKDIR /app
COPY --from=packages --chown=node:node /app .
RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn install --immutable
COPY --chown=node:node . .
RUN yarn tsc
RUN yarn --cwd packages/backend build
RUN mkdir packages/backend/dist/skeleton packages/backend/dist/bundle && \
    tar xzf packages/backend/dist/skeleton.tar.gz -C packages/backend/dist/skeleton && \
    tar xzf packages/backend/dist/bundle.tar.gz -C packages/backend/dist/bundle

# Stage 3: production dependencies only (still with the toolchain, for native modules).
FROM toolchain AS deps
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app/.yarn ./.yarn
COPY --from=build --chown=node:node /app/.yarnrc.yml /app/backstage.json /app/yarn.lock /app/package.json ./
COPY --from=build --chown=node:node /app/packages/backend/dist/skeleton/ ./
RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

# Stage 4: runtime. No compiler, no dev dependencies, no sources: production
# node_modules + the backend bundle (which serves the built frontend) + config.
FROM ${NODE_IMAGE} AS runtime
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends libsqlite3-0 && \
    rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app ./
COPY --from=build --chown=node:node /app/packages/backend/dist/bundle/ ./
COPY --chown=node:node app-config.yaml app-config.production.yaml ./
CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
