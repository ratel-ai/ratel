import assert from "node:assert/strict";
import { test } from "node:test";
import { taskFinish } from "@/lib/readings/trace-signals/workflows/finish";

const item = (
  completedRuns: number,
  runs: number,
  reading?: { runs: number; finishedRuns: number },
) => ({
  health: { completedRuns, failedRuns: runs - completedRuns },
  ...(reading ? { reading } : {}),
});

test("a task's finish rate: runs that ended without a failed call, of every run that asked for it", () => {
  assert.deepEqual(taskFinish(item(18, 20, { runs: 20, finishedRuns: 18 }), null), {
    finished: 18,
    of: 20,
    askedNoTool: 0,
    rate: 0.9,
  });
  // 18 more runs asked for it (judged from their request) and called no tool: unfinished.
  const placed = { turns: 136, outside: 22, outsideWithErrors: 4 };
  assert.deepEqual(taskFinish(item(20, 20, { runs: 20, finishedRuns: 20 }), placed), {
    finished: 20,
    of: 38,
    askedNoTool: 18,
    rate: 20 / 38,
  });
});

test("a run stored before tasks were read step by step falls back to its health", () => {
  assert.deepEqual(taskFinish(item(9, 10), null), {
    finished: 9,
    of: 10,
    askedNoTool: 0,
    rate: 0.9,
  });
  assert.equal(taskFinish(item(0, 0), null).rate, null);
});
