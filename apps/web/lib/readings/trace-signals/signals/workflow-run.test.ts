import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import {
  carryWorkflowIds,
  compactTurn,
  createWorkflowCollector,
  WORKFLOW_SIGNAL_KINDS,
} from "@/lib/readings/trace-signals/signals/workflow-run";
import { workflowDisplayName } from "@/lib/readings/trace-signals/workflows/name";
import { workflowFingerprint } from "@/lib/readings/trace-signals/workflows/order";
import { type Call, many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";

/** 30 runs of a-b-c-d where the last step fails in 12, plus 30 clean runs of x-y. */
function failingWorld(): SignalTurn[] {
  return [
    ...many(30, (i) => wfTurn(["a", "b", "c", i < 12 ? { tool: "d", outcome: "error" } : "d"])),
    ...many(30, () => wfTurn(["x", "y"])),
  ];
}

function collect(turns: readonly SignalTurn[], maxTurns?: number) {
  const collector = createWorkflowCollector(maxTurns);
  for (const turn of turns) collector.collect(turn);
  return collector;
}

test("the compact copy keeps tool calls only, with only the fields mining and the task reading read", () => {
  const turn = wfTurn(
    ["a", { tool: "skill_one", targetType: "skill" }, { tool: "b", outcome: "error", tookMs: 900 }],
    { durationMs: 3_000 },
  );
  const compact = compactTurn(turn)!;
  assert.deepEqual(Object.keys(compact).sort(), [
    "corrections",
    "endedAt",
    "id",
    "startedAt",
    "steps",
    "turnSource",
  ]);
  assert.deepEqual(
    compact.steps.map((s) => s.targetId),
    ["a", "b"],
  );
  assert.deepEqual(Object.keys(compact.steps[0]!).sort(), [
    "handoffMs",
    "kind",
    "outcome",
    "targetId",
    "targetType",
    "tookMs",
    "traceEventId",
  ]);
  assert.deepEqual(compact.steps[1], {
    kind: "invoke",
    targetType: "tool",
    targetId: "b",
    outcome: "error",
    tookMs: 900,
    traceEventId: turn.steps[2]!.traceEventId,
    handoffMs: null,
  });
  // Calls 1 s apart, 100 ms each: the agent waited 900 ms before the skill, which counts as the next call.
  assert.equal(compact.steps[0]!.handoffMs, 900);
  assert.deepEqual(
    compact.corrections,
    [{ kind: "gave_up_after_error", tool: "b", recovered: false }],
    "read from the full steps",
  );
  assert.equal(
    Object.hasOwn(compactTurn(wfTurn(["a", "b"]))!, "corrections"),
    false,
    "a clean run carries none",
  );
  assert.equal(
    compactTurn(wfTurn([{ tool: "s", targetType: "skill" }])),
    null,
    "a turn without a tool call is not kept",
  );
});

test("collection stops at the cap and the stored result says so", () => {
  const turns = many(8, () => wfTurn(["a", "b"]));
  const capped = collect(turns, 5).finish([]).stored;
  assert.equal(capped.turnsWithTools, 5);
  assert.equal(capped.truncated, true);
  const exact = collect(turns.slice(0, 5), 5).finish([]).stored;
  assert.equal(exact.turnsWithTools, 5);
  assert.equal(exact.truncated, false, "reaching the cap exactly is not truncation");
});

test("a failing workflow is stored and detected, with evidence at the failing step", () => {
  const { stored, signals, measured } = collect(failingWorld()).finish([]);
  const abcd = stored.items.find((item) => item.coreTools.includes("d"));
  assert.ok(abcd);
  assert.equal(stored.items.length, 2);
  assert.deepEqual(abcd.coreTools, ["a", "b", "c", "d"]);
  assert.equal(abcd.id, abcd.fingerprint);
  assert.equal(abcd.health.failedRuns, 12);
  assert.deepEqual(abcd.health.failingStep, { toolId: "d", count: 12, share: 1 });
  assert.equal(abcd.examples.failed.length, 5);
  const failing = signals.find((s) => s.kind === "workflow_failing");
  assert.ok(failing);
  assert.equal(failing.subjectKind, "workflow");
  assert.equal(failing.subjectKey, abcd.id);
  assert.deepEqual(failing.subjectDetail, {
    coreTools: ["a", "b", "c", "d"],
    typicalOrder: ["a", "b", "c", "d"],
  });
  assert.equal(failing.metrics.failingStep, "d");
  assert.ok(
    failing.evidence.traceEventIds.every((id) => id !== null && id.endsWith("-e3")),
    "points at the failed call",
  );
  assert.deepEqual([...measured].sort(), [...WORKFLOW_SIGNAL_KINDS].sort());
});

test("a workflow keeps last run's id when its core drifts by a tool, signal keys included", () => {
  const previous = [{ id: "wf-kept", coreTools: ["a", "b", "c"] }];
  const { stored, signals } = collect(failingWorld()).finish(previous);
  const abcd = stored.items.find((item) => item.coreTools.includes("d"))!;
  assert.equal(abcd.id, "wf-kept");
  assert.equal(abcd.fingerprint, workflowFingerprint(["a", "b", "c", "d"]));
  assert.ok(
    signals.filter((s) => s.subjectKey !== "wf-kept").every((s) => !s.subjectIds.includes("d")),
  );
  assert.equal(signals.find((s) => s.kind === "workflow_failing")?.subjectKey, "wf-kept");
});

test("a fresh fingerprint never collides with an id carried over to another workflow", () => {
  const old = workflowFingerprint(["a", "b", "c"]);
  const current = [
    { id: workflowFingerprint(["a", "b", "c", "d"]), coreTools: ["a", "b", "c", "d"] },
    { id: old, coreTools: ["a", "b", "c"] },
  ];
  // Last run's workflow kept its first id after growing a fourth tool.
  const ids = carryWorkflowIds(current, [{ id: old, coreTools: ["a", "b", "c", "d"] }]);
  assert.equal(ids.get(current[0]!.id), old);
  assert.equal(ids.get(old), `${old}-2`);
  assert.equal(new Set(ids.values()).size, 2);
});

test("the stored shape holds no member turn ids and stays small for twelve wide workflows, readings included", () => {
  const tool = (g: number, t: number) =>
    `workflow_group_${g}_step_${t}_with_a_long_descriptive_name`;
  const groups = Array.from({ length: 12 }, (_, g) =>
    Array.from({ length: 8 }, (_, t): Call => tool(g, t)),
  );
  const turns = groups.flatMap((calls, g) =>
    many(40, (i) =>
      wfTurn(i % 3 === 0 ? [...calls.slice(0, 7), { tool: tool(g, 7), outcome: "error" }] : calls),
    ),
  );
  const { stored } = collect(turns).finish([]);
  assert.equal(stored.items.length, 12);
  const json = JSON.stringify(stored);
  assert.ok(!json.includes("memberTurnIds"));
  const turnIds = new Set(turns.map((t) => t.id));
  for (const item of stored.items) {
    const named = new Set(
      [...item.examples.failed, ...item.examples.slow, ...item.examples.recent].map(
        (e) => e.turnId,
      ),
    );
    assert.ok(named.size <= 15);
    const mentioned = [...turnIds].filter((id) => JSON.stringify(item).includes(`"${id}"`));
    assert.deepEqual(mentioned.sort(), [...named].sort(), "only example turns are named");
  }
  // The step-by-step readings take about as much again as the rest; 8 long-named steps a task is the worst case.
  assert.ok(json.length < 80_000, `${json.length} bytes`);
});

test("without a multi-tool turn the workflow kinds are not measured", () => {
  const single = collect(many(30, () => wfTurn(["a"]))).finish([]);
  assert.equal(single.measured.size, 0);
  assert.equal(single.stored.singleStepTurns, 30);
  assert.deepEqual(single.signals, []);
  assert.equal(collect([]).finish([]).stored.turnsWithTools, 0);
});

test("the display name is the typical order, by display name where one is known", () => {
  const stored = { typicalOrder: ["find_task", "assign_task", "notify"] };
  assert.equal(workflowDisplayName(stored), "find_task > assign_task > notify");
  assert.equal(
    workflowDisplayName(stored, new Map([["find_task", "Find task"]])),
    "Find task > assign_task > notify",
  );
  assert.equal(
    workflowDisplayName(stored, (id) => (id === "notify" ? "" : id.toUpperCase())),
    "FIND_TASK > ASSIGN_TASK > notify",
  );
});

test("guessed runs that never went quiet hide workflows, and the stored basis says why", () => {
  const mixed = many(40, () => ({ ...wfTurn(["a", "b", "c"]), endedBy: "cap" as const }));
  const { stored, signals, measured } = collect(mixed).finish([]);
  assert.equal(stored.items.length, 0);
  assert.equal(stored.basis?.blocked, "mixed_runs");
  assert.equal(stored.basis?.excludedRuns, 40);
  assert.deepEqual(signals, []);
  assert.equal(
    measured.size,
    0,
    "a hidden reading measures nothing, so no open signal resolves on it",
  );
});

test("with enough runs carrying turn ids, only those are mined", () => {
  const guessed = many(60, () => wfTurn(["x", "y"]));
  const exact = many(30, () => wfTurn(["a", "b", "c"], { turnSource: "declared" }));
  const { stored } = collect([...guessed, ...exact]).finish([]);
  assert.equal(stored.basis?.basis, "exact");
  assert.equal(stored.basis?.excludedRuns, 60);
  assert.deepEqual(
    stored.items.map((item) => item.coreTools),
    [["a", "b", "c"]],
    "x-y lived only in guessed runs",
  );
});

test("runs that only search store a blocked basis instead of nothing", () => {
  const searchOnly = many(10, () => ({ ...wfTurn([]), invokeCount: 0 }));
  const { stored } = collect(searchOnly).finish([]);
  assert.equal(stored.turnsWithTools, 0);
  assert.equal(stored.basis?.blocked, "no_tool_calls");
});

test("every collected run is placed in one task or none, and each task counts exactly its placed runs", () => {
  const turns = [...failingWorld(), ...many(10, () => wfTurn(["solo"]))];
  const { stored, placement } = collect(turns).finish([
    { id: "wf-kept", coreTools: ["a", "b", "c", "d"] },
  ]);
  assert.equal(placement.size, 70, "every run that called a tool");
  assert.equal(
    [...placement.values()].filter((id) => id === null).length,
    10,
    "a single tool is no task",
  );
  const abcd = stored.items.find((item) => item.coreTools.includes("d"))!;
  assert.equal(abcd.id, "wf-kept");
  assert.equal(
    [...placement.values()].filter((id) => id === "wf-kept").length,
    abcd.runs,
    "placed under the carried id",
  );
  assert.equal(stored.assignedTurns, 60);
  assert.equal(abcd.reading?.runs, abcd.runs);
  assert.equal(abcd.reading?.finishedRuns, abcd.health.completedRuns);
  assert.deepEqual(
    abcd.reading?.steps.map((step) => step.toolId),
    ["a", "b", "c", "d"],
  );
  assert.equal(abcd.reading?.steps[3]?.failures, 12);
  assert.equal(abcd.reading?.steps[3]?.gaveUp, 12);
  assert.equal(abcd.reading?.corrections.byKind.gave_up_after_error, 12);
});
