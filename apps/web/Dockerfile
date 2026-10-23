# Build context: repository root.
#   docker build -f apps/web/Dockerfile --target oss -t ratel-oss:spike .
#   docker build -f apps/web/Dockerfile --target cloud -t ratel-cloud:spike .

FROM node:24-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

# --- deps: workspace manifests only, then filtered install -----------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/brand/package.json packages/brand/
COPY ee/package.json ee/

COPY examples/adaptive-ranking-ts/package.json examples/adaptive-ranking-ts/
COPY examples/ai-sdk/package.json examples/ai-sdk/
COPY examples/configurable-adaptive-ranking-ts/package.json examples/configurable-adaptive-ranking-ts/
COPY examples/jev-retriever-ts/package.json examples/jev-retriever-ts/
COPY examples/mastra/package.json examples/mastra/
COPY examples/mcp-chat/package.json examples/mcp-chat/
COPY examples/openai-decision-retriever-ts/package.json examples/openai-decision-retriever-ts/
COPY examples/s3-support-adaptive-ranking/package.json examples/s3-support-adaptive-ranking/
COPY examples/telemetry-ts/package.json examples/telemetry-ts/

COPY src/adapters/ts-mastra/package.json src/adapters/ts-mastra/
COPY src/adapters/ts-vercel-ai-sdk/package.json src/adapters/ts-vercel-ai-sdk/
COPY src/rankers/ts/package.json src/rankers/ts/
COPY src/rankers/ts/npm/darwin-arm64/package.json src/rankers/ts/npm/darwin-arm64/
COPY src/rankers/ts/npm/darwin-x64/package.json src/rankers/ts/npm/darwin-x64/
COPY src/rankers/ts/npm/linux-arm64-gnu/package.json src/rankers/ts/npm/linux-arm64-gnu/
COPY src/rankers/ts/npm/linux-x64-gnu/package.json src/rankers/ts/npm/linux-x64-gnu/
COPY src/rankers/ts/npm/win32-x64-msvc/package.json src/rankers/ts/npm/win32-x64-msvc/
COPY src/sdk/ts/package.json src/sdk/ts/
COPY src/sdk/ts/npm/darwin-arm64/package.json src/sdk/ts/npm/darwin-arm64/
COPY src/sdk/ts/npm/darwin-x64/package.json src/sdk/ts/npm/darwin-x64/
COPY src/sdk/ts/npm/linux-arm64-gnu/package.json src/sdk/ts/npm/linux-arm64-gnu/
COPY src/sdk/ts/npm/linux-x64-gnu/package.json src/sdk/ts/npm/linux-x64-gnu/
COPY src/sdk/ts/npm/win32-x64-msvc/package.json src/sdk/ts/npm/win32-x64-msvc/
COPY src/telemetry/ts/package.json src/telemetry/ts/

RUN pnpm install --frozen-lockfile --filter @ratel/platform... --filter @ratel/ee...

# --- source: app + brand only (ee/ stays out until build-cloud) ------------
FROM deps AS source
COPY apps/web apps/web
COPY packages/brand packages/brand
COPY scripts/link-ee.mjs scripts/

# --- build-oss: strip commercial routes, never had ee/ source -------------
FROM source AS build-oss
ARG RATEL_COMPOSITION=oss
ENV RATEL_COMPOSITION=${RATEL_COMPOSITION}
RUN rm -rf "apps/web/app/(ee)"
RUN pnpm --filter @ratel/platform build

# --- build-cloud: bring in commercial modules -----------------------------
FROM source AS build-cloud
ARG RATEL_COMPOSITION=cloud
ENV RATEL_COMPOSITION=${RATEL_COMPOSITION}
# node_modules is dockerignored, so this merges the source in beside the links
# the deps stage already created for @ratel/ee.
COPY ee ee
RUN pnpm --filter @ratel/platform build

# --- runtime base: minimal Node, no toolchain -----------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN groupadd --system --gid 1001 ratel \
  && useradd --system --uid 1001 --gid ratel ratel
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
# Readiness: GET /api/health answers 200 once the composition has booted.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# --- final targets --------------------------------------------------------
FROM runtime AS oss
COPY --from=build-oss --chown=ratel:ratel /app/apps/web/.next/standalone ./
COPY --from=build-oss --chown=ratel:ratel /app/apps/web/.next/static ./apps/web/.next/static
ENV RATEL_COMPOSITION=oss
USER ratel
CMD ["node", "apps/web/server.js"]

FROM runtime AS cloud
COPY --from=build-cloud --chown=ratel:ratel /app/apps/web/.next/standalone ./
COPY --from=build-cloud --chown=ratel:ratel /app/apps/web/.next/static ./apps/web/.next/static
ENV RATEL_COMPOSITION=cloud
USER ratel
CMD ["node", "apps/web/server.js"]
