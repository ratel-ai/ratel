import assert from "node:assert/strict";
import { test } from "node:test";
import { type DrainObserverDeps, JOB_QUEUE_LAG_MS, observeDrain } from "./drain-observer";

/** An observer whose log and reports are recordings; the queue lag is what the test says. */
function harness(lag: () => Promise<number | null> = async () => 0) {
  const logs: { level: string; code: string; fields: Record<string, unknown> }[] = [];
  const reports: { error: unknown; properties: Record<string, unknown> }[] = [];
  const deps: DrainObserverDeps = {
    oldestQueuedJobAgeMs: lag,
    log: (level, fields, code) => logs.push({ level, code, fields: { ...fields } }),
    reportException: (error, properties) => reports.push({ error, properties }),
  };
  return { deps, logs, reports, codes: () => logs.map((entry) => entry.code) };
}

test("a drain that finishes logs the heartbeat with its duration and the queue lag", async () => {
  const { deps, logs, codes } = harness(async () => 4_000);
  await observeDrain(async () => ({ ok: true }), deps);
  assert.deepEqual(codes(), ["drain_started", "drain_completed"]);
  const completed = logs[1];
  assert.equal(completed?.level, "info");
  assert.equal(completed?.fields.ok, true);
  assert.equal(completed?.fields.oldest_queued_age_ms, 4_000);
  assert.equal(typeof completed?.fields.duration_ms, "number");
});

test("nothing queued reads as no lag", async () => {
  const { deps, logs } = harness(async () => null);
  await observeDrain(async () => ({ ok: true }), deps);
  assert.equal(logs[1]?.fields.oldest_queued_age_ms, 0);
});

test("a queue older than the threshold also logs job_queue_lagging", async () => {
  const { deps, logs, codes } = harness(async () => JOB_QUEUE_LAG_MS);
  await observeDrain(async () => ({ ok: true }), deps);
  assert.deepEqual(codes(), ["drain_started", "drain_completed", "job_queue_lagging"]);
  assert.equal(logs[2]?.level, "warn");
  assert.equal(logs[2]?.fields.threshold_ms, JOB_QUEUE_LAG_MS);
});

test("a tick that reports failure is drain_failed, with its reason, and no heartbeat", async () => {
  const { deps, logs, codes, reports } = harness();
  await observeDrain(async () => ({ ok: false, error: "database is down" }), deps);
  assert.deepEqual(codes(), ["drain_started", "drain_failed"]);
  assert.equal(logs[1]?.level, "error");
  assert.equal(logs[1]?.fields.error, "database is down");
  assert.deepEqual(reports, []);
});

test("a tick that throws is drain_failed and reported, and the observer never throws", async () => {
  const { deps, codes, reports } = harness();
  const boom = new Error("connection reset");
  await observeDrain(async () => {
    throw boom;
  }, deps);
  assert.deepEqual(codes(), ["drain_started", "drain_failed"]);
  assert.deepEqual(reports, [{ error: boom, properties: { operation: "background_drain" } }]);
});

test("a failed queue-lag read only drops the field: the heartbeat still goes out", async () => {
  const { deps, logs, codes } = harness(async () => {
    throw new Error("statement timeout");
  });
  await observeDrain(async () => ({ ok: true }), deps);
  assert.deepEqual(codes(), ["drain_started", "drain_queue_lag_read_failed", "drain_completed"]);
  assert.equal("oldest_queued_age_ms" in (logs[2]?.fields ?? {}), false);
});
