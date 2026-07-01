import { defineConfig } from "vitest/config";

// The dense-search embedder downloads its model from HuggingFace on first use
// (ADR-0013). On a cold cache the first test to run a search pays that one-time
// ~130 MB fetch, which exceeds vitest's 5s default and — with the parallel forks
// pool — makes several workers contend for it at once. The core embedder already
// serializes that race (retry-on-lock-contention); this just gives the fetch the
// wall-clock headroom it needs so a cold CI cache isn't a timeout. Warm-cache
// runs finish in milliseconds and are unaffected.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
