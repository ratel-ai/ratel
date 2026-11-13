import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackgroundObservabilityDeps } from "./observability";
import { drainProjectJobs } from "./store";

type Capture = { error: unknown; distinctId: string; properties: Record<string, unknown> };

function observability(logs: unknown[][] = [], captures: Capture[] = []) {
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  const deps: BackgroundObservabilityDeps = {
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties: properties ?? {} });
    },
    reportServerException: (error, distinctId, properties) => {
      captures.push({ error, distinctId, properties });
    },
    now: () => 1_000,
    logError: (...args) => logs.push(args),
  };
  return { deps, events };
}

test("zombie reaping emits a system-scoped count and continues to the drain", async () => {
  const { deps, events } = observability();
  let drained = false;

  const result = await drainProjectJobs(undefined, {
    reapStaleRunningJobs: async () => 3,
    drainJobs: async () => {
      drained = true;
      return { done: 2, failed: 1 };
    },
    jobStore: {} as never,
    jobHandlers: () => ({}),
    observability: deps,
  });

  assert.deepEqual(result, { done: 2, failed: 1 });
  assert.equal(drained, true);
  assert.deepEqual(events, [
    { event: "jobs_reaped", context: { distinctId: "system:jobs" }, properties: { count: 3 } },
  ]);
});

test("a reaper failure logs and captures without blocking the drain", async () => {
  const thrown = new Error("reaper database unavailable");
  const logs: unknown[][] = [];
  const captures: Capture[] = [];
  let drained = false;

  const result = await drainProjectJobs("project-1", {
    reapStaleRunningJobs: async () => {
      throw thrown;
    },
    drainJobs: async () => {
      drained = true;
      return { done: 0, failed: 0 };
    },
    jobStore: {} as never,
    jobHandlers: () => ({}),
    observability: observability(logs, captures).deps,
  });

  assert.deepEqual(result, { done: 0, failed: 0 });
  assert.equal(drained, true);
  assert.deepEqual(logs, [["stale job reaper failed", thrown, { operation: "reap_stale_jobs" }]]);
  assert.deepEqual(captures, [
    { error: thrown, distinctId: "system:jobs", properties: { operation: "reap_stale_jobs" } },
  ]);
});

test("the drain reads the queue clock and the registered handlers", async () => {
  const jobStore = {
    claimNextQueued: async () => null,
    markDone: async () => {},
    markError: async () => {},
    queueClock: async () => new Date(0),
  };
  const registered = { cluster_intents: async () => null };
  let seenClock: boolean | undefined;
  let seenHandlers: unknown;
  await drainProjectJobs(undefined, {
    reapStaleRunningJobs: async () => 0,
    drainJobs: async (store, handlers) => {
      seenClock = store.queueClock !== undefined;
      seenHandlers = handlers;
      return { done: 0, failed: 0 };
    },
    jobStore,
    jobHandlers: () => registered,
    observability: observability().deps,
  });
  assert.equal(seenClock, true, "the drain claims only jobs queued before it started");
  assert.equal(seenHandlers, registered, "handlers come from the registry, read at drain time");
});
