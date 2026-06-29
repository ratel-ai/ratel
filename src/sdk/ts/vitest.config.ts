import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Retrieval is hybrid (ADR-0013): the first `register`/`search` in a worker
    // loads the bge-small and ms-marco-MiniLM models (and downloads them on the
    // very first run), then every search runs BERT inference on CPU. That is far
    // slower than the old BM25 path, so the 5s default is too tight.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
