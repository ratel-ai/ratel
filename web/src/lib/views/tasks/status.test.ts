import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FLOORS } from "@/lib/readings/trace-signals/signals/catalog";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import { taskStatus, WATCH } from "@/lib/views/tasks/status";

const calm = {
  issueKinds: new Set<string>(),
  finishRate: 0.98,
  weakest: null,
  correctionsPer100: 4,
};

test("an issue on the task decides first: failing before slow", () => {
  assert.deepEqual(
    taskStatus({ ...calm, issueKinds: new Set(["workflow_slow", "workflow_failing"]) }),
    { status: "failing", reason: null },
  );
  assert.deepEqual(taskStatus({ ...calm, issueKinds: new Set(["workflow_slow"]) }), {
    status: "slow",
    reason: null,
  });
  assert.deepEqual(
    taskStatus({ ...calm, issueKinds: new Set(["workflow_fixed_chain"]) }),
    { status: "healthy", reason: null },
    "an opportunity is no trouble",
  );
});

test("without an issue, a task is watched when it finishes too few runs, a step fails, or the agent corrects itself a lot", () => {
  assert.deepEqual(taskStatus({ ...calm, finishRate: WATCH.finishRate - 0.01 }), {
    status: "watch",
    reason: "finish",
  });
  assert.deepEqual(taskStatus({ ...calm, weakest: { failureShare: 0.12, calls: 40 } }), {
    status: "watch",
    reason: "step",
  });
  assert.deepEqual(
    taskStatus({ ...calm, weakest: { failureShare: 0.5, calls: 4 } }),
    { status: "healthy", reason: null },
    "too few calls to say",
  );
  assert.deepEqual(taskStatus({ ...calm, correctionsPer100: WATCH.correctionsPer100 }), {
    status: "watch",
    reason: "corrections",
  });
  assert.deepEqual(
    taskStatus({ ...calm, correctionsPer100: WATCH.correctionsPer100 - 0.1 }),
    { status: "healthy", reason: null },
    "just under the line",
  );
  assert.deepEqual(taskStatus(calm), { status: "healthy", reason: null });
  assert.deepEqual(taskStatus({ ...calm, finishRate: null, correctionsPer100: null }), {
    status: "healthy",
    reason: null,
  });
});

test("the corrections line is per 100 turns, where the self_correcting issue first fires", () => {
  // The issue needs minN turns, minK of them with a self-correction, and the
  // Wilson low bound of that share at minLow. At minN turns the smallest share
  // that fires is minK / minN; a turn with one carries at least one event, so
  // that share of turns is at least that many self-corrections per 100 turns.
  const { minN, minK, minLow } = DEFAULT_FLOORS.self_correcting;
  assert.equal(WATCH.correctionsPer100, (100 * minK) / minN);
  assert.ok(wilsonLow(minK, minN) >= minLow, "minK of minN fires");
});
