import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import {
  carryWorkflowIds,
  compactTurn,
  createWorkflowCollector,
  WORKFLOW_SIGNAL_KINDS,
} from "@/lib/readings/trace-signals/signals/workflow-run";
import { TOOL_RUN_MINING } from "@/lib/readings/trace-signals/tool-run-insights";
import { agentStepId } from "@/lib/readings/trace-signals/workflows/agent-tasks";
import { workflowDisplayName } from "@/lib/readings/trace-signals/workflows/name";
import { workflowFingerprint } from "@/lib/readings/trace-signals/workflows/order";
import {
  agentTurn,
  type Call,
  many,
  wfTurn,
} from "@/lib/readings/trace-signals/workflows/test-fixtures";

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

/* RC-747: tool-less agent runs, one task per agent, only with `cloud-tool-run-insights` on. */

function agentWorld(): SignalTurn[] {
  return [
    ...many(4, (i) => agentTurn("draft_fix", { outcome: i === 0 ? "error" : "ok" })),
    ...many(2, () => agentTurn("label_workflows")),
    agentTurn(null),
  ];
}

function collectWith(turns: readonly SignalTurn[], mining = TOOL_RUN_MINING) {
  const collector = createWorkflowCollector(undefined, undefined, undefined, mining);
  for (const turn of turns) collector.collect(turn);
  return collector;
}

test("flag on: tool-less agent runs form one task per agent at the mining floor, its runs placed in it", () => {
  const { stored, placement, signals } = collectWith(agentWorld()).finish([]);
  assert.equal(stored.basis?.blocked, null, "agent runs are enough to read tasks");
  assert.equal(stored.items.length, 1, "label_workflows has 2 runs, under the floor of 3");
  const task = stored.items[0]!;
  assert.deepEqual(task.coreTools, [agentStepId("draft_fix")]);
  assert.deepEqual(task.typicalOrder, ["agent:draft_fix"]);
  assert.equal(task.id, workflowFingerprint(["agent:draft_fix"]));
  assert.equal(task.runs, 4);
  assert.equal(task.health.failedRuns, 1);
  assert.equal(task.reading?.runs, 4);
  assert.deepEqual(
    task.reading?.steps.map((step) => step.toolId),
    ["agent:draft_fix"],
  );
  assert.equal([...placement.values()].filter((id) => id === task.id).length, 4);
  assert.equal(stored.assignedTurns, 4);
  assert.equal(stored.turnsWithTools, 0, "agent runs are not tool runs");
  assert.ok(
    signals.every((signal) => signal.kind !== "workflow_fixed_chain"),
    "one step is no chain",
  );
});

test("flag on: an agent task keeps last run's id, and tool tasks read as before beside it", () => {
  const tools = many(30, () => wfTurn(["x", "y"]));
  const off = collect(tools).finish([]).stored;
  const previous = [{ id: "wf-agent", coreTools: ["agent:draft_fix"] }];
  const on = collectWith([...tools, ...agentWorld()]).finish(previous).stored;
  assert.deepEqual(on.items.map((item) => item.id).sort(), [off.items[0]!.id, "wf-agent"].sort());
  const xy = on.items.find((item) => item.coreTools.includes("x"))!;
  assert.equal(xy.runs, off.items[0]!.runs);
  assert.equal(on.turnsWithTools, off.turnsWithTools);
});

test("flag on: an agent run that also called tools is a tool run, never an agent task", () => {
  const withTool = (): SignalTurn => {
    const agent = agentTurn("draft_fix");
    const tool = wfTurn(["search_docs"]);
    return {
      ...agent,
      invokeCount: 1,
      steps: [agent.steps[0]!, { ...tool.steps[0]!, ordinal: 1 }],
    };
  };
  const { stored } = collectWith(many(5, withTool)).finish([]);
  assert.deepEqual(stored.items, []);
  assert.equal(stored.singleStepTurns, 5);
});

test("flag off: agent runs form no task and the basis still reads no tool calls", () => {
  const { stored, placement } = collectWith(agentWorld(), {}).finish([]);
  assert.deepEqual(stored.items, []);
  assert.equal(stored.basis?.blocked, "no_tool_calls");
  assert.equal(placement.size, 0);
});

test("flag on: a basis decided before the reading as 'no tool calls' is lifted by agent runs", () => {
  const blocked = {
    basis: "none",
    blocked: "no_tool_calls",
    excludedRuns: 0,
    since: null,
    mixed: false,
  } as const;
  const collector = createWorkflowCollector(undefined, undefined, blocked, TOOL_RUN_MINING);
  for (const turn of agentWorld()) collector.collect(turn);
  const { stored } = collector.finish([]);
  assert.equal(stored.basis?.blocked, null);
  assert.equal(stored.items.length, 1);
});
