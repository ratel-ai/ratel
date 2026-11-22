import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerSeams } from "@/lib/ledger/turns/build-job";
import { fillLedgerSeams, ledgerSeamFills, sweepStep, traceSignalsRegistration } from "./register";
import { IDLE_SIGNAL_SWEEP, type SignalSweepResult } from "./sweep";

interface Tracked {
  event: string;
  properties: Record<string, unknown>;
}

function step(result: SignalSweepResult, tracked: Tracked[]) {
  return sweepStep(
    async () => result,
    async (event, _distinctId, properties) => {
      tracked.push({ event, properties: properties ?? {} });
    },
  );
}

test("registers the signal run and the workflow labels as jobs, and the sweep as an after-step", () => {
  assert.deepEqual(Object.keys(traceSignalsRegistration.jobs ?? {}).sort(), [
    "compute_trace_signals",
    "label_workflows",
  ]);
  assert.deepEqual(
    traceSignalsRegistration.drainSteps?.map((s) => [s.name, s.phase, s.retentionOnly ?? false]),
    [["trace_signal_sweep", "after", false]],
  );
});

test("the sweep step reports under the heartbeat key and emits an event only when it enqueued runs", async () => {
  const tracked: Tracked[] = [];
  assert.deepEqual(await step(IDLE_SIGNAL_SWEEP, tracked).run(), { traceSignalRunsEnqueued: 0 });
  assert.deepEqual(tracked, [], "an idle tick is not an event");

  const busy = { projectsScanned: 3, runsEnqueued: 2, skipped: false };
  assert.deepEqual(await step(busy, tracked).run(), { traceSignalRunsEnqueued: 2 });
  assert.deepEqual(tracked, [
    {
      event: "trace_signal_runs_enqueued",
      properties: {
        object_action: "trace_signal_runs_enqueued",
        projects_scanned: 3,
        runs_enqueued: 2,
      },
    },
  ]);
});

test("loading the registration fills the ledger's seams with the signal-run enqueues", () => {
  assert.equal(ledgerSeams.enqueueReading, ledgerSeamFills.enqueueReading);
  assert.equal(ledgerSeams.onBacklogDrained, ledgerSeamFills.onBacklogDrained);
  const seams: Partial<typeof ledgerSeams> = {};
  fillLedgerSeams(seams);
  assert.deepEqual(seams, ledgerSeamFills);
});
