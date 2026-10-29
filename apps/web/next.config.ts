import path from "node:path";
import type { NextConfig } from "next";

// The Cloud adapters are reached through one build-time alias (ADR-0029). It resolves to the
// private composition only when the Cloud edition is built; the open-source build never sees ee/.
const eeCompositionTarget =
  process.env.RATEL_COMPOSITION === "cloud"
    ? "../../ee/src/composition.ts"
    : "./lib/composition/ee-absent.ts";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ratel/brand", "@ratel/design-system"],
  // A self-contained server bundle for the image: `node apps/web/server.js`, no pnpm at runtime.
  // The tracing root is the monorepo root so the workspace packages and the native
  // `@ratel-ai/sdk` addon are copied into .next/standalone.
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "..", ".."),
  turbopack: {
    resolveAlias: {
      "#ee-composition": eeCompositionTarget,
    },
  },
  // The public SDK paths (ADR-0003, ADR-0007): the SDK posts traces and lifecycle logs, pulls the
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
