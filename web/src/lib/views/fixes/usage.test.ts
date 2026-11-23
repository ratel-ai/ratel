import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskReading } from "@/lib/readings/trace-signals/workflows/reading";
import { storedTaskUsage } from "@/lib/views/fixes/usage";

const WINDOW = {
  windowStart: new Date("2026-10-01T00:00:00Z"),
  windowEnd: new Date("2026-10-31T00:00:00Z"),
};

function reading(runs: number, usage?: TaskReading["usage"]): TaskReading {
  return {
    version: 1,
    runs,
    finishedRuns: runs,
    errorRuns: 0,
    recoveredRuns: 0,
    calls: runs * 2,
    steps: [],
    corrections: { runs: 0, events: 0, byKind: {} as TaskReading["corrections"]["byKind"] },
    cost: null,
    ...(usage ? { usage } : {}),
  };
}

test("stored totals become task usage over the run's window, with no read at request time", () => {
  const usage = storedTaskUsage(
    {
      items: [
        { id: "t1", reading: reading(4, { tokens: 9_000, waitMs: 40_000 }) },
        { id: "t2", reading: reading(0, { tokens: null, waitMs: 0 }) },
      ],
    } as never,
    WINDOW,
  );
  assert.deepEqual(
    [...usage!.entries()],
    [["t1", { tokens: 9_000, usd: null, ms: 40_000, windowDays: 30 }]],
  );
});

test("a reading stored before the totals sends the caller back to the live read", () => {
  const items = [
    { id: "t1", reading: reading(4, { tokens: 1, waitMs: 1 }) },
    { id: "t2", reading: reading(3) },
  ];
  assert.equal(storedTaskUsage({ items } as never, WINDOW), null);
  assert.equal(storedTaskUsage({ items: [] } as never, WINDOW), null);
  assert.equal(storedTaskUsage(null, WINDOW), null);
});
