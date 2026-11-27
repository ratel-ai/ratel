import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDrainGate,
  drainIngestBatches,
  type IngestQueueStore,
  retryBackoffMs,
} from "./drain";
import type { PersistOutcome } from "./persist";
import type { ClaimedIngestBatch, ClaimOptions } from "./queries";

/** RTL-314: the drain loop over a fake store, and the gate an all-in-one process drains through. */

function claimed(id: string, projectId: string, attempts = 1): ClaimedIngestBatch {
  return {
    id,
    projectId,
    signal: "traces",
    contentType: "application/json",
    contentEncoding: null,
    body: new Uint8Array(0),
    context: {},
    attempts,
    receivedAt: new Date(1_000),
  };
}

/** A queue that hands batches out by the claim's rule: unserved projects first, then round robin. */
function fakeStore(queue: ClaimedIngestBatch[]) {
  const claims: ClaimOptions[] = [];
  const outcomes: Array<[string, string, string?]> = [];
  const store: IngestQueueStore = {
    claim: async (options) => {
      claims.push({ ...options, avoidProjects: [...(options.avoidProjects ?? [])] });
      const served = options.avoidProjects ?? [];
      const rank = (b: ClaimedIngestBatch) => {
        const at = served.indexOf(b.projectId);
        return at < 0 ? -1 : at;
      };
      const next = [...queue].sort((a, b) => rank(a) - rank(b))[0];
      if (!next) return null;
      queue.splice(queue.indexOf(next), 1);
      return next;
    },
    done: async (id, _attempt) => {
      outcomes.push([id, "done"]);
    },
    fail: async (id, _attempt, error) => {
      outcomes.push([id, "failed", error]);
    },
    retry: async (id, _attempt, error, options) => {
      outcomes.push([id, `retry<=${options.maxAttempts}@${options.backoffMs}`, error]);
      return "queued";
    },
  };
  return { store, claims, outcomes };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

test("a drain takes turns across projects, round robin", async () => {
  const f = fakeStore([
    claimed("a1", "A"),
    claimed("a2", "A"),
    claimed("a3", "A"),
    claimed("b1", "B"),
    claimed("b2", "B"),
  ]);
  const order: string[] = [];
  const summary = await drainIngestBatches(
    f.store,
    async (batch) => {
      order.push(batch.id);
      return { kind: "done", result: {} };
    },
    { perProject: 1, maxAttempts: 5, log: silent },
  );
  assert.deepEqual(order, ["a1", "b1", "a2", "b2", "a3"]);
  assert.deepEqual(summary, { done: 5, failed: 0, retried: 0 });
  assert.deepEqual(f.claims[1], { perProject: 1, avoidProjects: ["A"] });
});

test("each outcome lands in the store: done, failed at once, or retried with a backoff", async () => {
  const f = fakeStore([
    claimed("ok", "A"),
    claimed("bad", "A"),
    claimed("flaky", "A", 3),
    claimed("boom", "A"),
  ]);
  const outcomes: Record<string, PersistOutcome | Error> = {
    ok: { kind: "done", result: { accepted: 1 } },
    bad: { kind: "failed", error: "malformed: x" },
    flaky: { kind: "retry", error: "storage: y" },
    boom: new Error("kaput"),
  };
  const summary = await drainIngestBatches(
    f.store,
    async (batch) => {
      const outcome = outcomes[batch.id];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    { perProject: 1, maxAttempts: 5, log: silent },
  );
  assert.deepEqual(f.outcomes, [
    ["ok", "done"],
    ["bad", "failed", "malformed: x"],
    ["flaky", `retry<=5@${retryBackoffMs(3)}`, "storage: y"],
    ["boom", `retry<=5@${retryBackoffMs(1)}`, "kaput"],
  ]);
  assert.deepEqual(summary, { done: 1, failed: 1, retried: 2 });
});

test("the backoff doubles from five seconds and stops at five minutes", () => {
  assert.equal(retryBackoffMs(1), 5_000);
  assert.equal(retryBackoffMs(2), 10_000);
  assert.equal(retryBackoffMs(4), 40_000);
  assert.equal(retryBackoffMs(20), 300_000);
});

test("a drain stops at its batch cap and at its deadline", async () => {
  const many = () => Array.from({ length: 10 }, (_, i) => claimed(`b${i}`, "A"));
  const capped = await drainIngestBatches(
    fakeStore(many()).store,
    async () => ({ kind: "done", result: {} }),
    {
      perProject: 1,
      maxAttempts: 5,
      max: 3,
      log: silent,
    },
  );
  assert.equal(capped.done, 3);
  let clock = 0;
  const timed = await drainIngestBatches(
    fakeStore(many()).store,
    async () => {
      clock += 400;
      return { kind: "done", result: {} };
    },
    { perProject: 1, maxAttempts: 5, deadline: 1_000, now: () => clock, log: silent },
  );
  assert.equal(timed.done, 3, "stops once the deadline has passed");
});

test("every persisted batch logs its wait and its time, and a failed one says why", async () => {
  const lines: Array<[string, Record<string, unknown>]> = [];
  const log = {
    info: (fields: Record<string, unknown>, msg: string) => lines.push([msg, fields]),
    warn: (fields: Record<string, unknown>, msg: string) => lines.push([msg, fields]),
    error: (fields: Record<string, unknown>, msg: string) => lines.push([msg, fields]),
  };
  let clock = 6_000;
  await drainIngestBatches(
    fakeStore([claimed("ok", "A"), claimed("bad", "B")]).store,
    async (batch) => {
      clock += 250;
      return batch.id === "ok"
        ? { kind: "done", result: { accepted: 2 } }
        : { kind: "failed", error: "malformed: nope" };
    },
    { perProject: 1, maxAttempts: 5, now: () => clock, log },
  );
  assert.deepEqual(lines, [
    [
      "ingest_batch_persisted",
      {
        project_id: "A",
        batch_id: "ok",
        signal: "traces",
        attempt: 1,
        outcome: "done",
        wait_ms: 5_000,
        duration_ms: 250,
        accepted: 2,
      },
    ],
    [
      "ingest_batch_failed",
      {
        project_id: "B",
        batch_id: "bad",
        signal: "traces",
        attempt: 1,
        outcome: "failed",
        wait_ms: 5_250,
        duration_ms: 250,
        error: "malformed: nope",
      },
    ],
  ]);
});

test("the gate runs at most its concurrency, and a kick it turned away is not lost", async () => {
  let running = 0;
  let peak = 0;
  let runs = 0;
  const releases: Array<() => void> = [];
  const gate = createDrainGate(
    () => 2,
    async () => {
      runs++;
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
    },
    () => assert.fail("no error expected"),
  );
  const first = gate.kick();
  const second = gate.kick();
  const third = gate.kick();
  assert.equal(runs, 2);
  assert.equal(third, undefined, "turned away: two drains are running");
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 3, "a running drain goes again for the kick it turned away");
  for (const release of releases.splice(0)) release();
  await new Promise((resolve) => setImmediate(resolve));
  for (const release of releases.splice(0)) release();
  await Promise.all([first, second]);
  assert.equal(peak, 2);
  assert.equal(runs, 3);
});

test("a drain that throws is reported and frees its slot", async () => {
  const errors: unknown[] = [];
  const gate = createDrainGate(
    () => 1,
    async () => {
      throw new Error("db down");
    },
    (error) => errors.push(error),
  );
  await gate.kick();
  await gate.kick();
  assert.equal(errors.length, 2);
});
