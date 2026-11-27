import path from "node:path";
import type { NextConfig } from "next";

// The Cloud adapters are reached through one build-time alias (ADR-0003). It resolves to the
// private composition only when the Cloud edition is built; the open-source build never sees ee/.
const eeCompositionTarget =
  process.env.RATEL_COMPOSITION === "cloud"
    ? "../ee/src/src/composition.ts"
    : "./src/lib/composition/ee-absent.ts";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `next dev` would write web/AGENTS.md (Next 16.3+); the repo's AGENTS.md is the source.
  agentRules: false,
  // `next dev` would print each server action's arguments, secrets (a webhook URL) included.
  // It would also print the query of each request, and Slack's callback carries a one-time code.
  logging: {
    serverFunctions: false,
    incomingRequests: { ignore: [/^\/api\/integrations\/slack\//] },
  },
  // Telemetry paths end in a slash (/ingest/flags/); without this Next answers them with a 308
  // before the Cloud proxy sees them.
  skipTrailingSlashRedirect: true,
  // RC-526: version skew. The image build sets NEXT_DEPLOYMENT_ID to the image tag (the
  // deploy workflow), so a tab from an older deploy does a hard reload on its next navigation
  // instead of calling server actions the new server does not know (lib/console/stale-build.ts
  // covers calls made before that). Unset in local dev and plain local builds.
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,
  // Browser source maps, for an edition's error tracking only: the image's cloud build sets
  // BROWSER_SOURCEMAPS=1, and its last builder step hands the maps to the edition and then deletes
  // them (web/Dockerfile), so they are never served. Plain builds emit none.
  productionBrowserSourceMaps: process.env.BROWSER_SOURCEMAPS === "1",
  transpilePackages: ["@ratel/brand", "@ratel/design-system"],
  // Next 16.3 type-checks the whole tsconfig project with `tsc`, tests included; the image has no
  // repo scripts/ for them. Keep the compiler-API checker; `pnpm typecheck` covers the tests.
  experimental: { useTypeScriptCli: false },
  // A self-contained server bundle for the image: `node web/server.js`, no pnpm at runtime.
  // The tracing root is the monorepo root so the workspace packages and the native
  // `@ratel-ai/sdk` addon are copied into .next/standalone.
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), ".."),
  // The MCP Apps views (the @ratel/mcp-apps package, built before Next) are read from disk by
  // lib/mcp/apps/load.ts through the package's VIEWS_PATH. Turbopack copies that file into
  // .next/server/assets (it is a `new URL(..., import.meta.url)`); the include keeps it in the
  // standalone output for a build that does not bundle the package.
  outputFileTracingIncludes: {
    "/api/mcp": ["../mcp-apps/dist/views.json"],
  },
  turbopack: {
    resolveAlias: {
      "#ee-composition": eeCompositionTarget,
      // The settings (src/config.ts) read files: a browser bundle gets the defaults instead
      // (src/config-defaults.ts), as it read an empty environment before.
      "@/config": { browser: "./src/config-defaults.ts" },
    },
  },
  // The public SDK paths (ADR-0007): the SDK posts traces and lifecycle logs, pulls the
  // catalog, and syncs the intent graph under /v1 and /v2; the handlers live under /api.
  async rewrites() {
    return [
      { source: "/v1/traces", destination: "/api/v1/traces" },
      { source: "/v1/logs", destination: "/api/v1/logs" },
      { source: "/v1/catalog", destination: "/api/v1/catalog" },
      { source: "/v1/runtime-catalog/overrides", destination: "/api/v1/runtime-catalog/overrides" },
      { source: "/v1/intent-graph", destination: "/api/v1/intent-graph" },
      { source: "/v2/catalog", destination: "/api/v2/catalog" },
    ];
  },
  // Shared Agent health pages are bearer links: keep them out of indexes, referers, caches and frames.
  async headers() {
    return [
      {
        source: "/share/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  // `@ratel-ai/sdk` loads a native addon through a platform-specific optional dependency, and the
  // OpenTelemetry instrumentations patch pg and pino through Node's module loader: neither can be
  // bundled into the server chunks. The OTel API packages stay bundleable so their globals are
  // shared with Next's own spans.
  serverExternalPackages: [
    "@ratel-ai/sdk",
    "@ratel-ai/sdk-darwin-arm64",
    "@ratel-ai/sdk-darwin-x64",
    "@ratel-ai/sdk-linux-arm64-gnu",
    "@ratel-ai/sdk-linux-x64-gnu",
    "@ratel-ai/sdk-win32-x64-msvc",
    "aws-msk-iam-sasl-signer-js",
    "kafkajs",
    "@opentelemetry/context-async-hooks",
    "@opentelemetry/core",
    "@opentelemetry/exporter-logs-otlp-http",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/instrumentation",
    "@opentelemetry/instrumentation-pg",
    "@opentelemetry/instrumentation-pino",
    "@opentelemetry/instrumentation-undici",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-logs",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/semantic-conventions",
    "pino",
  ],
};

export default nextConfig;
