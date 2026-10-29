import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOrFallback, type ResilientReadDeps } from "@/lib/platform/resilient-read";

function recordingDeps() {
  const logCalls: {
    message: string;
    err: unknown;
    fields?: Record<string, unknown>;
  }[] = [];
  const reportCalls: {
    err: unknown;
    distinctId: string;
    props: Record<string, unknown>;
  }[] = [];
  const spanEvents: { name: string; attributes: Record<string, unknown> }[] = [];
  const deps: ResilientReadDeps = {
    logError: (message, err, fields) =>
      logCalls.push({
        message,
        err,
        fields: fields as Record<string, unknown>,
      }),
    reportServerException: (err, distinctId, props) => reportCalls.push({ err, distinctId, props }),
    addSpanEvent: (name, attributes) => spanEvents.push({ name, attributes }),
  };
  return { deps, logCalls, reportCalls, spanEvents };
}

test("loadOrFallback returns the loaded value and stays silent on success", async () => {
  const { deps, logCalls, reportCalls } = recordingDeps();

  const result = await loadOrFallback(
    {
      operation: "trace_kpis",
      distinctId: "project:p1",
      fallback: "fallback",
      load: async () => "loaded",
    },
    deps,
  );

  assert.equal(result, "loaded");
  assert.equal(logCalls.length, 0);
  assert.equal(reportCalls.length, 0);
});

test("loadOrFallback degrades to the fallback, logs, and reports on failure", async () => {
  const { deps, logCalls, reportCalls, spanEvents } = recordingDeps();
  const boom = new Error("canceling statement due to statement timeout");

  const result = await loadOrFallback(
    {
      operation: "experiments",
      distinctId: "project:p1",
      fallback: [] as string[],
      load: async () => {
        throw boom;
      },
    },
    deps,
  );

  assert.deepEqual(result, []);
  // Logs the original error first, with the operation as structured context.
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].err, boom);
  assert.equal(logCalls[0].fields?.operation, "experiments");
  // Then reports it against the project distinct id, tagged as a degradation.
  assert.equal(reportCalls.length, 1);
  assert.equal(reportCalls[0].err, boom);
  assert.equal(reportCalls[0].distinctId, "project:p1");
  assert.equal(reportCalls[0].props.operation, "experiments");
  assert.equal(reportCalls[0].props.degraded, true);
  assert.deepEqual(spanEvents, [
    {
      name: "read_degraded",
      attributes: { operation: "experiments" },
    },
  ]);
});
