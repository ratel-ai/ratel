import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsToWaitFor } from "@/lib/readings/intent-graph/batching";

const NOW = Date.parse("2026-11-04T10:00:00Z");
const at = (minutesAgo: number) => ({ receivedAt: new Date(NOW - minutesAgo * 60_000) });
const policy = { minBatch: 4, maxWaitMs: 15 * 60_000 };

test("a few fresh events wait; none, a full batch, an old one or batching off run now", () => {
  assert.equal(eventsToWaitFor([at(2), at(1)], policy, NOW), 2);
  assert.equal(eventsToWaitFor([], policy, NOW), 0, "nothing to read: the run is cheap anyway");
  assert.equal(eventsToWaitFor([at(3), at(2), at(1), at(0)], policy, NOW), 0, "a full batch");
  assert.equal(
    eventsToWaitFor([at(16), at(1)], policy, NOW),
    0,
    "the oldest has waited long enough",
  );
  assert.equal(eventsToWaitFor([at(1)], { ...policy, minBatch: 0 }, NOW), 0);
});
