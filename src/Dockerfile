# syntax=docker/dockerfile:1
# Build context: repository root.
#   docker build -f src/Dockerfile --target oss -t ratel-oss:spike .
#   docker build -f src/Dockerfile --target cloud -t ratel-cloud:spike .

# Debian 13 (trixie, glibc 2.41): the @ratel-ai/sdk linux prebuild needs glibc 2.39+, which
# bookworm (2.36) does not have.
FROM node:24-trixie-slim AS base
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

# --- deps: workspace manifests only, then filtered install -----------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# @ratel-ai/sandbox until its first rc is on npm (RC-1091): src depends on file:../vendor/.
COPY vendor vendor
COPY src/package.json src/
COPY packages/brand/package.json packages/brand/
COPY packages/design-system/package.json packages/design-system/
COPY packages/gateway/package.json packages/gateway/
COPY ee/package.json ee/

# Hoisted node_modules, in the image only: `next build` with `output: "standalone"` traces real
# files and does not recreate pnpm's symlinks for serverExternalPackages, so with the workspace's
# isolated linker the native @ratel-ai/sdk addon would land only under .pnpm and fail to load at
# runtime. The lockfile is linker-independent, so the workspace itself stays isolated.
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted --filter @ratel/platform... --filter @ratel/ee...
# Fail on native-addon or base-image ABI drift before the slower Next build.
RUN cd src && node -e 'import("@ratel-ai/sdk")'

# --- source: app + shared packages only (ee/ stays out until build-cloud) ---
FROM deps AS source
COPY src src
COPY packages/brand packages/brand
COPY packages/design-system packages/design-system
COPY scripts/link-ee.mjs scripts/
# Next deploymentId (next.config.ts): CI passes the image tag, so each deploy has its own id and
# tabs from an older deploy reload. Empty = unset (local). Both editions build from here.
ARG NEXT_DEPLOYMENT_ID=
ENV NEXT_DEPLOYMENT_ID=$NEXT_DEPLOYMENT_ID

# --- build-oss: strip commercial routes, never had ee/ source -------------
FROM source AS build-oss
ARG RATEL_COMPOSITION=oss
ENV RATEL_COMPOSITION=${RATEL_COMPOSITION}
RUN rm -rf "src/app/(ee)"
# NODE_OPTIONS raises the heap to 4 GB, as upstream's image does: the Next type-check worker
# needs more than the default.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @ratel/platform build
# The MCP Apps views are read from disk at runtime (lib/mcp/apps/load.ts) and reach
# the standalone output only through outputFileTracingIncludes in next.config.ts.
# Without the file the server runs and serves no views, with only a warning in the
# log: fail the build instead.
RUN test -s src/.next/standalone/src/mcp-apps/dist/views.json

# --- build-cloud: bring in commercial modules -----------------------------
FROM source AS build-cloud
ARG RATEL_COMPOSITION=cloud
ENV RATEL_COMPOSITION=${RATEL_COMPOSITION}
# node_modules is dockerignored, so this merges the source in beside the links
# the deps stage already created for @ratel/ee.
COPY ee ee
# BROWSER_SOURCEMAPS=1 emits browser source maps (next.config.ts); the last step below hands them
# to the edition and deletes them before anything reaches the runtime image.
RUN BROWSER_SOURCEMAPS=1 NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @ratel/platform build
# As in build-oss: the MCP Apps views must be in the standalone output.
RUN test -s src/.next/standalone/src/mcp-apps/dist/views.json
# The deploy step: bundled runners and their SQL, because the runtime image has no tsx or source.
RUN node ee/src/src/db/bundle-migrator.mjs /app/migrator
# The edition's source-map step (ee/src/scripts/browser-sourcemaps.sh): it uploads the maps for its
# error tracking when its key is present, then deletes every .map either way, so none is served or
# shipped. Last on purpose: SOURCEMAP_UPLOAD_RUN is unique per CI run attempt, so only this cheap
# step reruns on a cached build (the secret is not part of the cache key). The key arrives as a
# BuildKit secret, never an ARG, ENV or layer; without it the upload is skipped.
ARG SOURCE_COMMIT=local
ARG SOURCEMAP_UPLOAD_RUN=local
ARG SOURCEMAP_PROJECT_IDS=
RUN --mount=type=secret,id=sourcemap_upload_key,env=SOURCEMAP_UPLOAD_KEY \
  echo "browser sourcemaps for commit ${SOURCE_COMMIT} run ${SOURCEMAP_UPLOAD_RUN}" \
  && bash ee/src/scripts/browser-sourcemaps.sh src/.next/static src/.next/standalone

# --- runtime base: minimal Node, no toolchain -----------------------------
FROM node:24-trixie-slim AS runtime
WORKDIR /app
# The app runs `node` only. The bundled npm and corepack carry their own copies of undici and
# brace-expansion, so the image drops them (base/deps/demo keep them to build and seed).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
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
COPY --from=build-oss --chown=ratel:ratel /app/src/.next/standalone ./
COPY --from=build-oss --chown=ratel:ratel /app/src/.next/static ./src/.next/static
COPY --from=build-oss --chown=ratel:ratel /app/src/public ./src/public
ENV RATEL_COMPOSITION=oss
USER ratel
CMD ["node", "src/server.js"]

FROM runtime AS cloud
COPY --from=build-cloud --chown=ratel:ratel /app/src/.next/standalone ./
COPY --from=build-cloud --chown=ratel:ratel /app/src/.next/static ./src/.next/static
COPY --from=build-cloud --chown=ratel:ratel /app/src/public ./src/public
COPY --from=build-cloud --chown=ratel:ratel /app/migrator ./migrator
ENV RATEL_COMPOSITION=cloud
USER ratel
CMD ["node", "src/server.js"]

# One-shot demo data: the source tree with its dev tools, so the runtime targets stay without them.
FROM source AS demo
ENV NODE_ENV=production
ENV RATEL_COMPOSITION=oss
WORKDIR /app/src
USER node
