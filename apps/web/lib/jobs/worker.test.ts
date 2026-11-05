import assert from "node:assert/strict";
import { test } from "node:test";
import { drainCron } from "@/lib/jobs/drain";
import { appRole, runsJobsAfterResponse } from "@/lib/jobs/role";
import { type ScheduleProjectDrainDeps, scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { IDLE_POLL_MS, SWEEP_EVERY_MS, startWorker, type WorkerDeps } from "@/lib/jobs/worker";

test("APP_ROLE picks the role; anything unknown keeps today's all-in-one behaviour", () => {
  assert.equal(appRole({}), "all");
  assert.equal(appRole({ APP_ROLE: "API" }), "api");
  assert.equal(appRole({ APP_ROLE: " worker " }), "worker");
  assert.equal(appRole({ APP_ROLE: "both" }), "all");
  assert.equal(runsJobsAfterResponse({}), true);
  assert.equal(runsJobsAfterResponse({ APP_ROLE: "api" }), false);
  assert.equal(runsJobsAfterResponse({ APP_ROLE: "worker" }), false);
});

/** A worker driven by a fake clock: records steps, stops after `steps` of them. */
async function run(steps: number, drained: number[]) {
  const log: string[] = [];
  let clock = 0;
  const ref: { handle?: { stop: () => Promise<void> } } = {};
  let stopped: Promise<void> | undefined;
  const stopAfter = () => {
    if (log.length >= steps && !stopped) stopped = ref.handle!.stop();
  };
  const deps: WorkerDeps = {
    now: () => clock,
    sleep: async (ms) => {
      log.push(`sleep ${ms}`);
      clock += ms;
      stopAfter();
    },
    sweep: async () => {
      log.push("sweep");
      stopAfter();
    },
    drain: async () => {
      const done = drained.shift() ?? 0;
      log.push(`drain ${done}`);
      stopAfter();
      return { done, failed: 0 };
    },
  };
  ref.handle = startWorker(deps);
  // Wait for the steps, not a fixed time: the full suite runs under load.
  for (let i = 0; i < 1000 && !stopped; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await (stopped ?? ref.handle.stop());
  return log;
}

test("the worker sweeps first, works through a backlog without pausing, then waits when idle", async () => {
  const log = await run(6, [3, 2, 0]);
  assert.deepEqual(log.slice(0, 6), [
    "sweep",
    "drain 3",
    "drain 2",
    "drain 0",
    `sleep ${IDLE_POLL_MS}`,
    "drain 0",
  ]);
});

test("the worker sweeps again once the sweep interval has passed", async () => {
  const idle = Array.from({ length: Math.ceil(SWEEP_EVERY_MS / IDLE_POLL_MS) + 2 }, () => 0);
  const log = await run(2 * idle.length + 4, idle);
  assert.equal(log.filter((step) => step === "sweep").length, 2);
});

test("a failing step is logged and the loop keeps going", async () => {
  let calls = 0;
  const ref: { handle?: { stop: () => Promise<void> } } = {};
  const deps: WorkerDeps = {
    now: () => 0,
    sleep: async () => {},
    sweep: async () => {
      throw new Error("database gone");
    },
    drain: async () => {
      calls += 1;
      if (calls === 2) void ref.handle!.stop();
      return { done: 0, failed: 0 };
    },
  };
  ref.handle = startWorker({
    ...deps,
    now: (() => {
      let t = 0;
      return () => (t += SWEEP_EVERY_MS / 2);
    })(),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await ref.handle.stop();
  assert.ok(calls >= 2, "drains kept running after the sweep failed");
});

function scheduleDeps(runsJobs: boolean, scheduled: unknown[]): ScheduleProjectDrainDeps {
  return {
    after: (callback) => scheduled.push(callback),
    drainProjectJobs: async () => ({ done: 0, failed: 0 }),
    observability: {} as never,
    runsJobs: () => runsJobs,
  };
}

test("an API-only process queues but does not run jobs after its response", () => {
  const scheduled: unknown[] = [];
  scheduleProjectDrain("p1", scheduleDeps(false, scheduled));
  assert.equal(scheduled.length, 0);
  scheduleProjectDrain("p1", scheduleDeps(true, scheduled));
  assert.equal(scheduled.length, 1);
});

test("on an API-only task the cron tick leaves the work to the worker", async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "s3cret";
  let drains = 0;
  try {
    const response = await drainCron(
      new Request("http://localhost/api/cron/drain", {
        headers: { authorization: "Bearer s3cret" },
      }),
      {
        steps: [],
        drainProjectJobs: async () => {
          drains += 1;
          return { done: 0, failed: 0 };
        },
      },
      "api",
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, skipped: "worker" });
    assert.equal(drains, 0);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("a long import in its own lane does not hold up analysis or the sweeps", async () => {
  let releaseImport: () => void = () => {};
  const importRunning = new Promise<void>((resolve) => (releaseImport = resolve));
  let analysisSteps = 0;
  let importsStarted = 0;
  const ref: { handle?: { stop: () => Promise<void> } } = {};
  ref.handle = startWorker({
    now: () => 0,
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    sweep: async () => {},
    drain: async () => {
      analysisSteps += 1;
      return { done: 1, failed: 0 };
    },
    drainImports: async () => {
      importsStarted += 1;
      if (importsStarted === 1) await importRunning; // a 40-minute import, still going
      return { done: 1, failed: 0 };
    },
  });
  for (let i = 0; i < 1000 && analysisSteps <= 5; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(importsStarted, 1, "the import is still running");
  assert.ok(analysisSteps > 5, `analysis kept going while it ran (${analysisSteps} steps)`);
  releaseImport();
  const stopping = ref.handle.stop();
  await stopping;
});

test("imports go to the worker only when IMPORTS_RUN_IN_WORKER=1", async () => {
  const { importsRunInWorker } = await import("@/lib/jobs/role");
  assert.equal(importsRunInWorker({}), false);
  assert.equal(importsRunInWorker({ IMPORTS_RUN_IN_WORKER: "true" }), false);
  assert.equal(importsRunInWorker({ IMPORTS_RUN_IN_WORKER: "1" }), true);
});
