# syntax=docker/dockerfile:1
#
# The sandbox runner gateway (packages/gateway): one esbuild bundle on a slim Node
# runtime. The bundle includes the shared sandbox code it imports from
# src/lib/views/sandboxes and the Drizzle schema fragments, so the runtime image
# needs no node_modules.
# Build context = repo ROOT:  docker build -f packages/gateway/Dockerfile .
# Owned (ADR-0030): upstream's apps/gateway/Dockerfile with this repository's paths.

FROM --platform=linux/amd64 node:22-trixie-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---- builder: install the workspace (frozen), bundle the gateway ----
FROM base AS builder
# Every workspace manifest and the lockfile first, so the install layer is
# reused until the dependency graph changes (same rule as src/Dockerfile).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# @ratel-ai/sandbox until its first rc is on npm (RC-1091): src depends on file:../vendor/.
COPY vendor vendor
COPY src/package.json src/package.json
COPY ee/package.json ee/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/brand/package.json packages/brand/package.json
COPY packages/design-system/package.json packages/design-system/package.json
RUN pnpm install --frozen-lockfile --filter @ratel/gateway... --filter @ratel/platform...
COPY packages/gateway packages/gateway
COPY src src
RUN pnpm --filter @ratel/gateway build && node -e 'require("fs").statSync("packages/gateway/dist/gateway.cjs")'

# ---- runner: the bundle and the sandbox/v1 schemas, non-root ----
FROM --platform=linux/amd64 node:22-trixie-slim AS runner
ENV NODE_ENV=production \
    PORT=8787 \
    SANDBOX_PROTOCOL_DIR=/app/protocol/schema
WORKDIR /app
COPY --from=builder --chown=node:node /app/packages/gateway/dist/gateway.cjs ./gateway.cjs
COPY --from=builder --chown=node:node /app/packages/gateway/protocol/schema ./protocol/schema
USER node
EXPOSE 8787
# Node is the direct container process, so ECS's SIGTERM reaches the drain handler.
CMD ["node", "gateway.cjs"]
