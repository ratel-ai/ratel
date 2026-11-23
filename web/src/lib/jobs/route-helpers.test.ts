import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackgroundObservabilityDeps } from "./observability";
import { scheduleProjectDrain } from "./route-helpers";

test("an after-response drain failure logs and captures the exception", async () => {
  const thrown = new Error("drain unavailable");
  const logs: unknown[][] = [];
  const captures: Array<{
    error: unknown;
    distinctId: string;
    properties: Record<string, unknown>;
  }> = [];
  let callback: (() => void | Promise<void>) | undefined;
  const observability: BackgroundObservabilityDeps = {
    trackServerEvent: async () => {},
    reportServerException: (error, distinctId, properties) => {
      captures.push({ error, distinctId, properties });
    },
    now: Date.now,
    logError: (...args) => logs.push(args),
  };

  scheduleProjectDrain("project-1", {
    after: (scheduled) => {
      callback = scheduled;
    },
    drainProjectJobs: async () => {
      throw thrown;
    },
    observability,
  });
  assert.ok(callback);
  await callback();

  const properties = { operation: "after_drain", project_id: "project-1" };
  assert.deepEqual(logs, [["after response drain failed", thrown, properties]]);
  assert.deepEqual(captures, [{ error: thrown, distinctId: "project:project-1", properties }]);
});
