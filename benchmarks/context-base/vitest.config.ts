import { defineConfig } from "vitest/config";

const isBenchmark = process.argv.some((a) => a.includes("benchmark.test.ts"));

export default defineConfig({
  test: {
    testTimeout: 300_000,
    include: ["**/*.test.ts"],
    ...(isBenchmark && { globalSetup: "./vitest.globalSetup.ts" }),
  },
});
