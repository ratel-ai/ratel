/**
 * Test fixture standing in for the @ratel-ai/telemetry-otlp peer. Its top-level `await` makes
 * module evaluation asynchronous, so a synchronous `require()` of it throws
 * ERR_REQUIRE_ASYNC_MODULE on every Node version — the graph-shape sibling of the old-Node
 * ERR_REQUIRE_ESM. This lets `requireOtlpPeer`'s "can't load synchronously, steer to
 * configureTelemetry" branch be exercised end-to-end on any runtime, no old Node required.
 */
await Promise.resolve();
export const startTelemetry = () => ({ forceFlush: async () => {}, shutdown: async () => {} });
