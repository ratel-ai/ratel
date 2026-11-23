import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowHealth } from "@/lib/readings/trace-signals/workflows/health";
import { byIdMap, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";

/**
 * A hand-computed example, four runs of find > assign > notify:
 *
 * | run | calls (outcome, tookMs)                                  | ms   | ends in error at |
 * | t1  | find ok 100, assign ok 300, notify ok 100                | 1000 | no               |
 * | t2  | find ok 100, assign error 500                            | 2000 | assign           |
 * | t3  | find ok 100, find ok 100, assign ok 300, notify error 50 | 3000 | notify (retry)   |
 * | t4  | find error 100, find ok 100, assign ok 300, notify ok -  | 4000 | no (retry)       |
 */
function example() {
  const t1 = wfTurn(
    [
      { tool: "find", tookMs: 100 },
      { tool: "assign", tookMs: 300 },
      { tool: "notify", tookMs: 100 },
    ],
    { id: "t1", startMs: 0, durationMs: 1_000 },
  );
  const t2 = wfTurn(
    [
      { tool: "find", tookMs: 100 },
      { tool: "assign", outcome: "error", tookMs: 500 },
    ],
    {
      id: "t2",
      startMs: 10_000,
      durationMs: 2_000,
    },
  );
  const t3 = wfTurn(
    [
      { tool: "find", tookMs: 100 },
      { tool: "find", tookMs: 100 },
      { tool: "assign", tookMs: 300 },
      { tool: "notify", outcome: "error", tookMs: 50 },
    ],
    { id: "t3", startMs: 20_000, durationMs: 3_000, turnSource: "otlp" },
  );
  const t4 = wfTurn(
    [
      { tool: "find", outcome: "error", tookMs: 100 },
      { tool: "find", tookMs: 100 },
      { tool: "assign", tookMs: 300 },
      { tool: "notify", tookMs: null },
    ],
    { id: "t4", startMs: 30_000, durationMs: 4_000 },
  );
  return [t1, t2, t3, t4];
}

test("health numbers on a hand-computed example", () => {
  const turns = example();
  const health = workflowHealth(
    { id: "wf", memberTurnIds: ["t1", "t2", "t3", "t4", "missing"] },
    byIdMap(turns),
  );
  assert.equal(health.workflowId, "wf");
  assert.equal(health.runs, 4, "a member not in the map is skipped");
  assert.equal(health.failedRuns, 2);
  assert.equal(health.completedRuns, 2);
  assert.equal(health.completion, 0.5);
  assert.deepEqual(
    health.failingStep,
    { toolId: "assign", count: 1, share: 0.5 },
    "a tie goes to the lower id",
  );
  assert.equal(health.errorRuns, 3, "t4 erred mid-run and still finished");
  assert.equal(health.retryRuns, 2);
  assert.equal(health.meanToolCalls, 13 / 4);
  assert.equal(health.medianMs, 2_000);
  assert.equal(health.p95Ms, 4_000);
  // tookMs summed: find 600, assign 1400, notify 150 (t4's notify has none).
  assert.deepEqual(health.slowestStep, {
    toolId: "assign",
    count: 1_400,
    share: 1_400 / 2_150,
    medianMs: 300,
  });
  assert.deepEqual(health.turnSourceMix, { declared: 0, inferred: 3, otlp: 1 });
  assert.deepEqual(health.failedExamples, [
    { turnId: "t3", traceEventId: "t3-e3" },
    { turnId: "t2", traceEventId: "t2-e1" },
  ]);
  assert.deepEqual(
    health.slowExamples.map((e) => e.turnId),
    ["t4", "t3", "t2", "t1"],
  );
  assert.deepEqual(
    health.recentExamples.map((e) => e.turnId),
    ["t4", "t3", "t2", "t1"],
  );
});

test("examples are capped, and skills do not count as calls", () => {
  const turns = example();
  const withSkill = wfTurn(["find", { tool: "plan", targetType: "skill", outcome: "error" }], {
    id: "t5",
    startMs: 40_000,
  });
  const health = workflowHealth(
    { id: "wf", memberTurnIds: [...turns.map((t) => t.id), "t5"] },
    byIdMap([...turns, withSkill]),
    2,
  );
  assert.equal(health.failedRuns, 2, "the skill's error is not a tool failure");
  assert.equal(health.slowExamples.length, 2);
  assert.equal(health.recentExamples[0]!.turnId, "t5");
});

test("an empty workflow has zeros and nulls, not NaN", () => {
  const health = workflowHealth({ id: "wf", memberTurnIds: [] }, new Map());
  assert.equal(health.runs, 0);
  assert.equal(health.completion, 0);
  assert.equal(health.meanToolCalls, 0);
  assert.equal(health.medianMs, null);
  assert.equal(health.failingStep, null);
  assert.equal(health.slowestStep, null);
});
