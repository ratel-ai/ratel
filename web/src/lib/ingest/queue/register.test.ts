import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resetConfigForTests } from "@/config";
import {
  ingestQueueAcceptDeps,
  ingestQueueDrainSteps,
  reapIngestBatches,
  reportIngestQueueStats,
} from "./register";

/** RTL-314: the queue's depth lines, its reaper, its tick steps and the after-response drain. */

afterEach(() => {
  delete process.env.APP_ROLE;
  resetConfigForTests();
});

test("one ingest_queue_depth line per project, and the totals for the heartbeat", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const totals = await reportIngestQueueStats(
    async () => [
      { projectId: "A", queued: 4000, running: 1, oldestAgeMs: 900_000, failedLastHour: 2 },
      { projectId: "B", queued: 1, running: 1, oldestAgeMs: 400, failedLastHour: 0 },
    ],
    { info: (fields, msg) => lines.push({ msg, ...fields }) },
  );
  assert.deepEqual(lines, [
    {
      msg: "ingest_queue_depth",
      project_id: "A",
      queued: 4000,
      running: 1,
      oldest_age_ms: 900_000,
      failed_1h: 2,
    },
    {
      msg: "ingest_queue_depth",
      project_id: "B",
      queued: 1,
      running: 1,
      oldest_age_ms: 400,
      failed_1h: 0,
    },
  ]);
  assert.deepEqual(totals, {
    ingest_queued: 4001,
    ingest_running: 2,
    ingest_failed_1h: 2,
    ingest_oldest_age_ms: 900_000,
  });
});

test("the reaper takes batches running for five minutes and says so only when it took some", async () => {
  const warnings: Array<Record<string, unknown>> = [];
  let stale: number | undefined;
  const reaped = await reapIngestBatches(
    async (staleMs, maxAttempts) => {
      stale = staleMs;
      assert.equal(maxAttempts, 5);
      return { requeued: 2, failed: 1 };
    },
    { warn: (fields) => warnings.push(fields) },
  );
  assert.deepEqual(reaped, { requeued: 2, failed: 1 });
  assert.equal(stale, 300_000, "five minutes, on the database's clock");
  assert.deepEqual(warnings, [{ requeued: 2, failed: 1 }]);
  await reapIngestBatches(async () => ({ requeued: 0, failed: 0 }), {
    warn: () => assert.fail("nothing to say"),
  });
});

test("the tick reaps and reports before the job drain, drains and prunes after", () => {
  const steps = ingestQueueDrainSteps({ persistDeps: () => assert.fail("not run here") });
  assert.deepEqual(
    steps.map((s) => [s.name, s.phase, s.retentionOnly ?? false]),
    [
      ["ingest_batches_reap", "before", false],
      ["ingest_queue_depth", "before", false],
      ["ingest_batches_drain", "after", false],
      ["ingest_batches_prune", "after", false],
    ],
  );
});

test("the tick's safety-net drain runs only on an all-in-one process", async () => {
  process.env.APP_ROLE = "worker";
  resetConfigForTests();
  const drain = ingestQueueDrainSteps({
    persistDeps: () => assert.fail("a worker drains in its lane"),
  }).find((s) => s.name === "ingest_batches_drain");
  assert.deepEqual(await drain?.run(), { ingest_drained: 0 });
});

test("an all-in-one process drains after the response; any other role only queues", () => {
  const scheduled: unknown[] = [];
  const accept = ingestQueueAcceptDeps(
    { persistDeps: () => assert.fail("not run here") },
    (callback) => scheduled.push(callback),
  );
  accept.scheduleDrain();
  assert.equal(scheduled.length, 1);
  for (const role of ["api", "ingest", "worker", "persist"]) {
    process.env.APP_ROLE = role;
    resetConfigForTests();
    accept.scheduleDrain();
  }
  assert.equal(scheduled.length, 1);
});

test("the switch is read per request", () => {
  const accept = ingestQueueAcceptDeps(
    { persistDeps: () => assert.fail("not run here") },
    () => {},
  );
  assert.equal(accept.enabled(), false);
  process.env.EXPERIMENTAL_INGEST_QUEUE = "1";
  resetConfigForTests();
  try {
    assert.equal(accept.enabled(), true);
  } finally {
    delete process.env.EXPERIMENTAL_INGEST_QUEUE;
    resetConfigForTests();
  }
});
