import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackgroundObservabilityDeps } from "./observability";
import { drainJobs, type JobHandler, type JobRecord, type JobStore } from "./runner";

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    projectId: "p",
    kind: "match_quality_run",
    status: "running",
    payload: null,
    ...over,
  };
}

/** A fake store backed by an in-memory queue, recording done/error calls. */
function fakeStore(queue: JobRecord[]) {
  const done: Array<{ id: string; result: unknown }> = [];
  const errors: Array<{ id: string; error: string }> = [];
  const store: JobStore = {
    claimNextQueued: async () => queue.shift() ?? null,
    markDone: async (id, result) => {
      done.push({ id, result });
    },
    markError: async (id, error) => {
      errors.push({ id, error });
    },
  };
  return { store, done, errors };
}

const noopHandlers: Partial<Record<string, JobHandler>> = {
  match_quality_run: async () => null,
  fold_intent_graph: async () => null,
};

function observability(overrides: Partial<BackgroundObservabilityDeps> = {}) {
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  const captured: Array<{
    error: unknown;
    distinctId: string;
    properties: Record<string, unknown>;
  }> = [];
  const deps: BackgroundObservabilityDeps = {
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties: properties ?? {} });
    },
    reportServerException: (error, distinctId, properties) => {
      captured.push({ error, distinctId, properties });
    },
    now: Date.now,
    logError: () => {},
    ...overrides,
  };
  return { deps, events, captured };
}

test("drains all queued jobs, marking each done with its handler's result", async () => {
  const { store, done } = fakeStore([
    job({ id: "a", kind: "match_quality_run" }),
    job({ id: "b", kind: "fold_intent_graph" }),
  ]);
  const res = await drainJobs(store, {
    match_quality_run: async () => ({ proposalsCreated: 3 }),
    fold_intent_graph: async () => ({ eventsFolded: 12 }),
  });
  assert.deepEqual(res, { done: 2, failed: 0 });
  assert.deepEqual(done, [
    { id: "a", result: { proposalsCreated: 3 } },
    { id: "b", result: { eventsFolded: 12 } },
  ]);
});

test("completed jobs emit duration per project", async () => {
  const { store } = fakeStore([
    job({ id: "a", projectId: "project-1" }),
    job({ id: "b", projectId: "project-1" }),
  ]);
  const times = [100, 125, 200, 240];
  const observed = observability({ now: () => times.shift() ?? 240 });

  await drainJobs(store, noopHandlers, { observability: observed.deps });

  assert.deepEqual(observed.events, [
    {
      event: "job_completed",
      context: { projectId: "project-1" },
      properties: { kind: "match_quality_run", job_id: "a", duration_ms: 25 },
    },
    {
      event: "job_completed",
      context: { projectId: "project-1" },
      properties: { kind: "match_quality_run", job_id: "b", duration_ms: 40 },
    },
  ]);
});

test("a throwing handler marks that job error and the drain continues", async () => {
  const { store, done, errors } = fakeStore([job({ id: "a" }), job({ id: "b" })]);
  let calls = 0;
  const res = await drainJobs(
    store,
    {
      match_quality_run: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { ok: true };
      },
    },
    { observability: observability().deps },
  );
  assert.equal(res.done, 1);
  assert.equal(res.failed, 1);
  assert.equal(errors[0].error, "boom");
  assert.equal(done[0].id, "b");
});

test("a throwing job logs, captures through the telemetry port, and emits a timed failure event", async () => {
  const thrown = new Error("boom");
  const { store, errors } = fakeStore([job({ id: "failed-job", projectId: "project-1" })]);
  const logs: unknown[][] = [];
  const times = [100, 132];
  const observed = observability({
    now: () => times.shift() ?? 132,
    logError: (...args) => logs.push(args),
  });

  const result = await drainJobs(
    store,
    {
      match_quality_run: async () => {
        throw thrown;
      },
    },
    { observability: observed.deps },
  );

  assert.deepEqual(result, { done: 0, failed: 1 });
  assert.equal(errors[0].error, "boom");
  const properties = {
    kind: "match_quality_run",
    project_id: "project-1",
    job_id: "failed-job",
    duration_ms: 32,
  };
  assert.deepEqual(logs, [["job_failed", thrown, properties]]);
  assert.deepEqual(observed.captured, [
    { error: thrown, distinctId: "project:project-1", properties },
  ]);
  assert.deepEqual(observed.events, [
    {
      event: "job_failed",
      context: { projectId: "project-1" },
      properties: { kind: "match_quality_run", job_id: "failed-job", duration_ms: 32 },
    },
  ]);
});

test("stops cleanly when the queue is empty", async () => {
  const { store } = fakeStore([]);
  const res = await drainJobs(store, noopHandlers);
  assert.deepEqual(res, { done: 0, failed: 0 });
});

test("an unknown job kind is marked error, never thrown out of the drain", async () => {
  const { store, errors } = fakeStore([job({ kind: "bogus" })]);
  const res = await drainJobs(store, noopHandlers, { observability: observability().deps });
  assert.equal(res.failed, 1);
  assert.match(errors[0].error, /no handler/);
});

test("respects the max-iterations safety cap against a runaway queue", async () => {
  const store: JobStore = {
    claimNextQueued: async () => job(), // endless supply
    markDone: async () => {},
    markError: async () => {},
  };
  const res = await drainJobs(store, noopHandlers, { max: 5 });
  assert.equal(res.done, 5);
});

test("null handler result is stored as null (not undefined)", async () => {
  const { store, done } = fakeStore([job({ id: "a" })]);
  await drainJobs(store, { match_quality_run: async () => undefined });
  assert.equal(done[0].result, null);
});

test("a job a handler queues mid-drain waits for the next drain instead of looping in this one", async () => {
  // A queue with a clock: rows carry the instant they were queued, and the claim honours the bound.
  let clock = 0;
  const queue: Array<JobRecord & { createdAt: number }> = [
    { ...job({ id: "j0", kind: "explore_tool_usage" }), createdAt: clock++ },
  ];
  const store: JobStore = {
    claimNextQueued: async (_projectId, createdBefore) => {
      const at = queue.findIndex(
        (row) => createdBefore === undefined || row.createdAt <= createdBefore.getTime(),
      );
      return at === -1 ? null : queue.splice(at, 1)[0];
    },
    markDone: async () => {},
    markError: async () => {},
    queueClock: async () => new Date(clock++),
  };
  let calls = 0;
  // Every run meets a live run and queues itself again, like the explorer and crafter do.
  const requeueing: Partial<Record<string, JobHandler>> = {
    explore_tool_usage: async () => {
      calls++;
      queue.push({ ...job({ id: `j${calls}`, kind: "explore_tool_usage" }), createdAt: clock++ });
      return { outcome: "busy" };
    },
  };

  assert.deepEqual(await drainJobs(store, requeueing), { done: 1, failed: 0 });
  assert.equal(calls, 1, "one handler run per drain");
  assert.equal(queue.length, 1, "the re-queued job is still waiting");

  assert.deepEqual(await drainJobs(store, requeueing), { done: 1, failed: 0 });
  assert.equal(calls, 2, "the next drain picks it up");
});

test("a store without a queue clock drains without a bound", async () => {
  const seen: Array<Date | undefined> = [];
  const store: JobStore = {
    claimNextQueued: async (_projectId, createdBefore) => {
      seen.push(createdBefore);
      return null;
    },
    markDone: async () => {},
    markError: async () => {},
  };
  await drainJobs(store, noopHandlers);
  assert.deepEqual(seen, [undefined]);
});
