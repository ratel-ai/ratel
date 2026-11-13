import assert from "node:assert/strict";
import { test } from "node:test";
import { type BackgroundObservabilityDeps, createBackgroundObservability } from "./observability";

test("the original failure log survives an exception capture outage", () => {
  const failure = new Error("job failed");
  const captureFailure = new Error("exporter unavailable");
  const logs: unknown[][] = [];
  const deps: BackgroundObservabilityDeps = {
    trackServerEvent: async () => {},
    reportServerException: () => {
      throw captureFailure;
    },
    now: Date.now,
    logError: (...args) => logs.push(args),
  };

  createBackgroundObservability(deps).reportException("operation_failed", failure, "system:jobs", {
    operation: "test",
  });

  assert.deepEqual(logs, [
    ["operation_failed", failure, { operation: "test" }],
    ["exception capture failed", captureFailure, { distinct_id: "system:jobs", operation: "test" }],
  ]);
});

test("a failing event tracker is logged, never thrown into the job", async () => {
  const trackerFailure = new Error("tracker down");
  const logs: unknown[][] = [];
  const deps: BackgroundObservabilityDeps = {
    trackServerEvent: async () => {
      throw trackerFailure;
    },
    reportServerException: () => {},
    now: Date.now,
    logError: (...args) => logs.push(args),
  };

  await createBackgroundObservability(deps).trackProjectEvent("job_completed", "project-1", {
    kind: "k",
  });

  assert.deepEqual(logs, [
    ["event tracking failed", trackerFailure, { kind: "k", event: "job_completed" }],
  ]);
});
