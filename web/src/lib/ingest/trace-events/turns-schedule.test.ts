import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleTraceTurnBuild, type TraceTurnsIngestDeps } from "./turns-schedule";

function deps(job: { id: string } | null = { id: "job-1" }) {
  const calls = { enqueued: [] as string[], drained: [] as string[] };
  const d: TraceTurnsIngestDeps = {
    enqueueBuild: async (projectId) => {
      calls.enqueued.push(projectId);
      return job;
    },
    scheduleProjectDrain: (projectId) => {
      calls.drained.push(projectId);
    },
  };
  return { d, calls };
}

const input = { projectId: "p1", organization: null, eventTypes: ["search"], accepted: 1 };

test("a batch with a turn event enqueues one build and drains it, with no gate", async () => {
  const { d, calls } = deps();
  await scheduleTraceTurnBuild(d, input);
  assert.deepEqual(calls, { enqueued: ["p1"], drained: ["p1"] });
});

test("nothing is enqueued without deps, without accepted events or without a turn event", async () => {
  const { d, calls } = deps();
  await scheduleTraceTurnBuild(undefined, input);
  await scheduleTraceTurnBuild(d, { ...input, accepted: 0 });
  await scheduleTraceTurnBuild(d, { ...input, eventTypes: ["usage_boost"] });
  assert.deepEqual(calls, { enqueued: [], drained: [] });
});

test("a coalesced enqueue that returns no job does not drain", async () => {
  const { d, calls } = deps(null);
  await scheduleTraceTurnBuild(d, input);
  assert.deepEqual(calls, { enqueued: ["p1"], drained: [] });
});

test("an enqueue failure is reported, never thrown", async () => {
  const reported: unknown[] = [];
  const d: TraceTurnsIngestDeps = {
    enqueueBuild: async () => {
      throw new Error("down");
    },
    scheduleProjectDrain: () => {},
  };
  await scheduleTraceTurnBuild(d, {
    ...input,
    logError: () => {},
    reportServerException: (error) => {
      reported.push(error);
    },
  });
  assert.equal(reported.length, 1);
});
