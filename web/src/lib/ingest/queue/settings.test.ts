import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { bootPlan } from "@/lib/jobs/boot-plan";
import { persistsIngestAfterResponse, runsIngestLane } from "@/lib/jobs/role";
import { ingestQueueEnabled, ingestQueueSettings } from "./settings";

const config = (env: Record<string, string> = {}) => resolveConfig({ env });
const DB = { DATABASE_URL: "postgres://localhost/ratel" };

test("the ingest queue is off by default and on only with EXPERIMENTAL_INGEST_QUEUE=1", () => {
  assert.equal(ingestQueueEnabled(config()), false);
  assert.equal(ingestQueueEnabled(config({ EXPERIMENTAL_INGEST_QUEUE: "1" })), true);
  assert.equal(ingestQueueEnabled(config({ EXPERIMENTAL_INGEST_QUEUE: "0" })), false);
});

test("the queue's settings have defaults and read their env", () => {
  assert.deepEqual(ingestQueueSettings(config()), {
    persistPerProject: 1,
    persistConcurrency: 2,
    maxAttempts: 5,
  });
  assert.deepEqual(
    ingestQueueSettings(
      config({
        INGEST_PERSIST_PER_PROJECT: "3",
        INGEST_PERSIST_CONCURRENCY: "8",
        INGEST_BATCH_MAX_ATTEMPTS: "2",
      }),
    ),
    { persistPerProject: 3, persistConcurrency: 8, maxAttempts: 2 },
  );
  assert.throws(() => config({ INGEST_PERSIST_CONCURRENCY: "0" }), /INGEST_PERSIST_CONCURRENCY/);
});

test("an all-in-one process persists after its responses; no other role does", () => {
  assert.equal(persistsIngestAfterResponse(config()), true);
  for (const role of ["api", "ingest", "worker", "persist"]) {
    assert.equal(persistsIngestAfterResponse(config({ APP_ROLE: role })), false, role);
  }
});

test("the worker and the persist role run the ingest lane; serving roles do not", () => {
  assert.equal(runsIngestLane(config({ APP_ROLE: "worker" })), true);
  assert.equal(runsIngestLane(config({ APP_ROLE: "persist" })), true);
  for (const role of ["all", "api", "ingest"]) {
    assert.equal(runsIngestLane(config({ APP_ROLE: role })), false, role);
  }
});

test("an ingest-only process only queues: it never migrates and runs no tick", () => {
  assert.deepEqual(bootPlan(config({ ...DB, APP_ROLE: "ingest" })), {
    role: "ingest",
    migrate: false,
    tick: "none",
  });
});

test("a persist-only process runs the ingest lane alone and never migrates", () => {
  assert.deepEqual(bootPlan(config({ ...DB, APP_ROLE: "persist" })), {
    role: "persist",
    migrate: false,
    tick: "persist",
  });
});
