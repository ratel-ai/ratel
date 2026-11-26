import assert from "node:assert/strict";
import { test } from "node:test";
import nextConfig from "../../../../../next.config";

/** The default of Next.js: the proxy buffers at most this much of each request body in memory. */
const NEXT_DEFAULT_PROXY_BODY_BYTES = 10 * 1024 * 1024;

// With a proxy (an edition's web/src/proxy.ts), Next buffers the body of each request that the proxy
// matches, up to `proxyClientMaxBodySize`, before any route checks a key. A large limit lets a caller
// with no key make the server hold that much memory for each request, on each route. The bundle
// upload goes to object storage, or skips the proxy (the matcher of the edition), so the limit stays
// at the default.
test("the proxy body limit stays at the default of Next.js", () => {
  const limit = nextConfig.experimental?.proxyClientMaxBodySize;
  assert.ok(
    limit === undefined || Number(limit) <= NEXT_DEFAULT_PROXY_BODY_BYTES,
    `proxyClientMaxBodySize is ${String(limit)}: each request through the proxy can hold that much memory`,
  );
});
