import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLD_MIN_INTERVAL_MS } from "@/lib/ingest/trace-events/fold-schedule";
import { enqueueDueIntentEngineRuns } from "@/lib/readings/intent-engine/jobs";
import { enqueueDueIntentGraphFolds } from "@/lib/readings/intent-graph/fold-job";

test("runs are batched five minutes apart", () => {
  assert.equal(FOLD_MIN_INTERVAL_MS, 5 * 60_000);
});

test("the cron safety nets pace their enqueues like ingest does", async () => {
  const folds: unknown[] = [];
  await enqueueDueIntentGraphFolds({
    listProjectsWithUnfoldedEvents: async () => [{ id: "p1" }, { id: "p2" }],
    enqueueFoldIntentGraphJob: async (_projectId, _db, options) => {
      folds.push(options);
      return null;
    },
  });
  assert.deepEqual(folds, [
    { minIntervalMs: FOLD_MIN_INTERVAL_MS },
    { minIntervalMs: FOLD_MIN_INTERVAL_MS },
  ]);

  const runs: unknown[] = [];
  await enqueueDueIntentEngineRuns({
    listProjectsWithUnclusteredEvents: async () => [{ id: "p1" }],
    enqueueClusterIntentsJob: async (_projectId, _db, options) => {
      runs.push(options);
      return { id: "job" };
    },
  });
  assert.deepEqual(runs, [{ minIntervalMs: FOLD_MIN_INTERVAL_MS }]);
});
