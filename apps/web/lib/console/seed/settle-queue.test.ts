import assert from "node:assert/strict";
import { test } from "node:test";
import { type SettleQueueDeps, settleProjectQueue } from "@/lib/console/seed/settle-queue";

type Job = { status: string };

/** A project's queue as a script of answers, a fake clock, and a record of what the seed did. */
function harness(answers: Job[][], overrides: Partial<SettleQueueDeps> = {}) {
  let now = 0;
  const did: string[] = [];
  const deps: SettleQueueDeps = {
    inFlight: async (projectId) => {
      assert.equal(projectId, "p1");
      return answers.shift() ?? [];
    },
    drain: async (projectId) => {
      did.push(`drain ${projectId}`);
      return { done: 1, failed: 0 };
    },
    now: () => now,
    sleep: async (ms) => {
      did.push(`sleep ${ms}`);
      now += ms;
    },
    pollMs: 250,
    ...overrides,
  };
  return { deps, did };
}

test("a project with nothing queued or running is settled at once", async () => {
  const h = harness([[]]);
  assert.equal(await settleProjectQueue("p1", h.deps), true);
  assert.deepEqual(h.did, []);
});

test("jobs left queued are drained here, until none is left", async () => {
  // A drain claims only jobs queued before it started: what a job queues waits for the next.
  const h = harness([[{ status: "queued" }], [{ status: "queued" }], []]);
  assert.equal(await settleProjectQueue("p1", h.deps), true);
  assert.deepEqual(h.did, ["drain p1", "drain p1"]);
});

test("a job another process (the worker) is running is waited for, not raced", async () => {
  const h = harness([
    [{ status: "running" }],
    [{ status: "queued" }, { status: "running" }],
    [{ status: "queued" }],
    [],
  ]);
  assert.equal(await settleProjectQueue("p1", h.deps), true);
  assert.deepEqual(h.did, ["sleep 250", "sleep 250", "drain p1"]);
});

test("gives up after the timeout instead of hanging the seed", async () => {
  const running = Array.from({ length: 10 }, () => [{ status: "running" }]);
  const h = harness(running, { pollMs: 1_000, timeoutMs: 3_000 });
  assert.equal(await settleProjectQueue("p1", h.deps), false);
  assert.deepEqual(h.did, ["sleep 1000", "sleep 1000", "sleep 1000"]);
});
