import assert from "node:assert/strict";
import { test } from "node:test";
import { readProcessStats } from "@/lib/platform/process-stats";

test("a reading is in MB with one decimal, and the loop delay p99 in ms", () => {
  const memory = {
    heapUsed: 300 * 1024 * 1024,
    heapTotal: 400 * 1024 * 1024,
    rss: 812.34 * 1024 * 1024,
    external: 10 * 1024 * 1024,
    arrayBuffers: 0,
  };
  const loop = { percentile: (p: number) => (p === 99 ? 42_500_000 : 0) };
  assert.deepEqual(readProcessStats(memory, loop, "worker"), {
    role: "worker",
    heap_used_mb: 300,
    heap_total_mb: 400,
    rss_mb: 812.3,
    external_mb: 10,
    event_loop_p99_ms: 42.5,
  });
  assert.equal(readProcessStats(memory, null, "api").event_loop_p99_ms, 0);
});
