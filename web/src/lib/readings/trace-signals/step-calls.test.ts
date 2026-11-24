import assert from "node:assert/strict";
import { test } from "node:test";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { stepCalls, stepEventIds } from "@/lib/readings/trace-signals/step-calls";

test("a turn's calls are its invoke steps, in order, with their node ids; their facts are on both events", () => {
  const steps = signalTurns([fresh().search(["a"]).invoke("get_task").invoke("update_task")])[0]!
    .steps;
  const calls = stepCalls(steps);
  assert.deepEqual(
    calls.map(({ node }) => node),
    ["get_task", "update_task"],
  );
  const [first] = calls;
  assert.deepEqual(
    stepEventIds(first!.step),
    first!.step.endTraceEventId
      ? [first!.step.traceEventId, first!.step.endTraceEventId]
      : [first!.step.traceEventId],
  );
  assert.deepEqual(stepEventIds({ traceEventId: "s", endTraceEventId: null }), ["s"]);
  assert.deepEqual(stepEventIds({ traceEventId: "s", endTraceEventId: "e" }), ["s", "e"]);
});
