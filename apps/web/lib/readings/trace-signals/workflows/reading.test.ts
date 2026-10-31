import assert from "node:assert/strict";
import { test } from "node:test";
import { readTask, type TaskStepReading } from "@/lib/readings/trace-signals/workflows/reading";
import type {
  TurnCorrection,
  WorkflowStep,
  WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";

const T0 = Date.parse("2026-10-01T10:00:00Z");
let serial = 0;

interface CallSpec {
  tool: string;
  error?: boolean;
  tookMs?: number;
  handoffMs?: number | null;
}

function run(
  calls: readonly (string | CallSpec)[],
  corrections: TurnCorrection[] = [],
  extra: Partial<WorkflowTurn> = {},
): WorkflowTurn {
  serial += 1;
  const steps: WorkflowStep[] = calls.map((call, i) => {
    const spec = typeof call === "string" ? { tool: call } : call;
    return {
      kind: "invoke",
      targetType: "tool",
      targetId: spec.tool,
      outcome: spec.error ? "error" : "ok",
      tookMs: spec.tookMs ?? 100,
      traceEventId: `e-${serial}-${i}`,
      handoffMs:
        spec.handoffMs === undefined ? (i < calls.length - 1 ? 400 : null) : spec.handoffMs,
    };
  });
  return {
    id: `run-${serial}`,
    startedAt: new Date(T0 + serial * 60_000),
    endedAt: new Date(T0 + serial * 60_000 + 3_000),
    turnSource: "declared",
    steps,
    ...(corrections.length > 0 ? { corrections } : {}),
    ...extra,
  };
}

const retry = (tool: string): TurnCorrection => ({
  kind: "retry_after_error",
  tool,
  recovered: true,
});
const gaveUp = (tool: string): TurnCorrection => ({
  kind: "gave_up_after_error",
  tool,
  recovered: false,
});
const switched = (tool: string, recovered = true): TurnCorrection => ({
  kind: "switch_after_error",
  tool,
  recovered,
});

const TASK = {
  typicalOrder: ["find", "assign", "notify"],
  optionalTools: ["lookup"],
  helperTools: ["auth"],
};

function world(): WorkflowTurn[] {
  return [
    // 4 clean runs, one of them with the optional lookup and one with the helper.
    run(["find", "assign", "notify"]),
    run(["find", "assign", "notify"]),
    run(["find", "lookup", "assign", "notify"]),
    run(["auth", "find", "assign", "notify"]),
    // 3 runs retry assign after it fails, and finish.
    ...[0, 1, 2].map(() =>
      run(
        ["find", { tool: "assign", error: true }, { tool: "assign", tookMs: 300 }, "notify"],
        [retry("assign")],
      ),
    ),
    // 1 run switches away from a failed assign and finishes.
    run(["find", { tool: "assign", error: true }, "lookup", "notify"], [switched("assign")]),
    // 2 runs end on a failed notify.
    ...[0, 1].map(() =>
      run(["find", "assign", { tool: "notify", error: true, handoffMs: null }], [gaveUp("notify")]),
    ),
  ];
}

const step = (steps: readonly TaskStepReading[], id: string) => steps.find((s) => s.toolId === id)!;

test("a task's runs: finished, failed somewhere, recovered", () => {
  const reading = readTask(TASK, world());
  assert.equal(reading.version, 1);
  assert.equal(reading.runs, 10);
  assert.equal(reading.finishedRuns, 8, "two ended on a failed call");
  assert.equal(reading.errorRuns, 6);
  assert.equal(reading.recoveredRuns, 4, "the retries and the switch got past their failure");
  assert.equal(reading.calls, 4 * 3 + 2 + 3 * 4 + 4 + 2 * 3);
});

test("steps come in the task's order, then optional tools, then helpers", () => {
  const { steps } = readTask(TASK, world());
  assert.deepEqual(
    steps.map((s) => [s.toolId, s.role]),
    [
      ["find", "core"],
      ["assign", "core"],
      ["notify", "core"],
      ["lookup", "optional"],
      ["auth", "helper"],
    ],
  );
  assert.equal(step(steps, "lookup").runs, 2);
  assert.equal(step(steps, "auth").runs, 1);
});

test("each step: calls, failures, retries, switches and give-ups from the self-corrections", () => {
  const { steps } = readTask(TASK, world());
  const assign = step(steps, "assign");
  assert.equal(assign.runs, 10);
  assert.equal(assign.calls, 13);
  assert.equal(assign.failures, 4);
  assert.equal(assign.retries, 3);
  assert.equal(assign.switches, 1);
  assert.equal(assign.gaveUp, 0);
  const notify = step(steps, "notify");
  assert.equal(notify.failures, 2);
  assert.equal(notify.gaveUp, 2);
  assert.equal(step(steps, "find").failures, 0);
});

test("what comes next after a step, repeats collapsed, the end of the run included", () => {
  const { steps } = readTask(TASK, world());
  assert.deepEqual(step(steps, "find").next, [
    { toolId: "assign", n: 9, share: 0.9 },
    { toolId: "lookup", n: 1, share: 0.1 },
  ]);
  const assign = step(steps, "assign");
  assert.equal(assign.nextOf, 10, "a retry of the same tool is one visit to the step");
  assert.deepEqual(assign.next, [
    { toolId: "notify", n: 9, share: 0.9 },
    { toolId: "lookup", n: 1, share: 0.1 },
  ]);
  assert.deepEqual(step(steps, "notify").next, [{ toolId: null, n: 10, share: 1 }]);
  assert.equal(step(steps, "auth").next[0]?.toolId, "find");
});

test("each step's typical time and the wait before the next call", () => {
  const { steps } = readTask(TASK, world());
  assert.equal(step(steps, "find").medianMs, 100);
  assert.equal(step(steps, "assign").medianMs, 100, "10 calls at 100 ms, 3 at 300 ms");
  assert.equal(step(steps, "find").handoffMs, 400);
  assert.equal(step(steps, "notify").handoffMs, null, "nothing runs after the last step");
});

test("self-corrections over the task's runs, by kind", () => {
  const { corrections } = readTask(TASK, world());
  assert.equal(corrections.runs, 6);
  assert.equal(corrections.events, 6);
  assert.deepEqual(corrections.byKind, {
    retry_after_error: 3,
    switch_after_error: 1,
    gave_up_after_error: 2,
    searched_again: 0,
    asked_again: 0,
  });
});

test("a run with no tool call is not finished", () => {
  const reading = readTask(TASK, [run([]), run(["find", "assign"])]);
  assert.equal(reading.runs, 2);
  assert.equal(reading.finishedRuns, 1);
});

test("a run whose last call (a skill) failed is not finished even when its last tool call worked", () => {
  const reading = readTask(TASK, [run(["find", "assign"], [gaveUp("skill:summarize")])]);
  assert.equal(reading.finishedRuns, 0);
  assert.equal(reading.errorRuns, 1);
});

test("cost: summed and typical over the runs linked to priced model calls", () => {
  const linked = (costUsd: number | null) => ({
    model: { calls: 4, costUsd, modelMs: 1_000, runMs: 3_000 },
  });
  const runs = [
    run(["find", "assign"], [], linked(0.02)),
    run(["find", "assign"], [], linked(0.04)),
    run(["find", "assign"], [], linked(null)),
    run(["find", "assign"]),
  ];
  assert.deepEqual(readTask(TASK, runs).cost, {
    linkedRuns: 3,
    pricedRuns: 2,
    totalUsd: 0.06,
    medianUsd: 0.02,
    medianModelCalls: 4,
  });
  assert.equal(
    readTask(TASK, [run(["find", "assign"])]).cost,
    null,
    "nothing linked, nothing said",
  );
});

test("an empty task reads as zeros, not as a division by zero", () => {
  const reading = readTask(TASK, []);
  assert.equal(reading.runs, 0);
  assert.deepEqual(
    reading.steps.map((s) => [s.toolId, s.calls]),
    [
      ["find", 0],
      ["assign", 0],
      ["notify", 0],
      ["lookup", 0],
      ["auth", 0],
    ],
  );
  assert.equal(reading.steps[0]!.medianMs, null);
});
