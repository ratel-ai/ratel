import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyChange } from "@/lib/views/eval-gate/change";
import type { TaskEvalCaseRow, TaskEvalRunRow } from "@/lib/views/task-evals/schema";
import { simulationInputKey, taskReplayRuns, taskSimulationState } from "./simulation-view";

test("draft and test edits make a run stale even when it finishes after the edit", () => {
  const change = { ...emptyChange(), patches: { search: "Find an invoice." } };
  const cases: TaskEvalCaseRow[] = [
    {
      id: "case-a",
      turnId: "turn-a",
      projectId: "project",
      taskId: "task",
      fixId: "fix",
      origin: "fix",
      pinned: false,
      excludedAt: null,
      testName: null,
      testAsk: null,
      expected: { tool: "search" },
      criteria: "Return its total.",
      selectionReason: "Added for this fix.",
    },
  ];
  const key = simulationInputKey(change, cases, [{ kind: "expected_tool", tool: "search" }]);
  const run: TaskEvalRunRow = {
    id: "run",
    projectId: "project",
    taskId: "task",
    fixId: "fix",
    kind: "simulation",
    shipmentId: null,
    scorerVersion: 1,
    status: "completed",
    trigger: "manual",
    before: null,
    after: null,
    results: null,
    breakdown: null,
    methods: null,
    spend: null,
    judge: null,
    change: { ...change, inputKey: key },
    verdict: "better",
    error: null,
    caseCount: 1,
    fixCaseCount: 1,
    createdBy: "user",
    createdAt: new Date("2026-11-01T10:00:00Z"),
    startedAt: null,
    finishedAt: new Date("2026-11-01T10:10:00Z"),
  };
  assert.deepEqual(taskSimulationState(run, key), { state: "better", stale: false });
  for (const edited of [
    simulationInputKey({ ...change, patches: { search: "Find an invoice by number." } }, cases, [
      { kind: "expected_tool", tool: "search" },
    ]),
    simulationInputKey(
      change,
      [{ ...cases[0]!, criteria: "Return its currency." }],
      [{ kind: "expected_tool", tool: "search" }],
    ),
    simulationInputKey(
      change,
      [{ ...cases[0]!, expected: { tool: "lookup" } }],
      [{ kind: "expected_tool", tool: "search" }],
    ),
    simulationInputKey(change, [], [{ kind: "expected_tool", tool: "search" }]),
    simulationInputKey(change, cases, [{ kind: "expected_tool", tool: "lookup" }]),
  ]) {
    assert.deepEqual(taskSimulationState(run, edited), { state: "better", stale: true });
    assert.deepEqual(
      taskSimulationState(
        { ...run, status: "running" },
        edited,
        new Date("2026-11-01T10:01:00Z").getTime(),
      ),
      { state: "running", stale: true },
    );
  }
  assert.deepEqual(taskSimulationState(null, key), { state: "none", stale: false });
  assert.deepEqual(taskSimulationState({ ...run, status: "failed" }, key), {
    state: "unreliable",
    stale: false,
  });
  assert.deepEqual(taskSimulationState({ ...run, verdict: "too-few" }, key), {
    state: "unreliable",
    stale: false,
  });
});

test("input keys ignore object key ordering", () => {
  const change = { ...emptyChange(), patches: { a: "A", b: "B" } };
  assert.equal(
    simulationInputKey(change, [], []),
    simulationInputKey({ ...change, patches: { b: "B", a: "A" } }, [], []),
  );
});

test("RC-76: the task page lists what the replay did for each replayed run of the latest simulation", () => {
  const facts = {
    model: "claude-sonnet-4-6",
    recordedModel: null,
    steps: { before: 3, after: 2 },
    standIns: { before: 0, after: 1 },
    controlMatchesRecording: true,
    paths: {
      recorded: ["get_seat_map", "select_seat"],
      before: ["get_seat_map", "select_seat"],
      after: ["seat_map_then_select"],
      intended: ["seat_map_then_select"],
    },
    capped: false,
    stops: { before: "answered", after: "answered" },
  };
  const work = {
    kind: "does_the_work",
    pass: false,
    score: 0,
    detail: "asks the merged tool for what the run never did; the replay can't vouch it worked",
    group: "outcome",
    measured: true,
  };
  const results = [
    {
      caseId: "a",
      turnId: "turn-a",
      role: "holdout",
      simulated: true,
      skipped: null,
      method: "replay",
      replay: facts,
      before: null,
      after: { pass: false, score: 0, checks: [work] },
    },
    {
      caseId: "b",
      turnId: "turn-b",
      role: "evidence",
      simulated: false,
      skipped: "cant-simulate",
      method: "none",
      replay: null,
    },
  ];
  const rows = taskReplayRuns({ results } as unknown as TaskEvalRunRow, "project 1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "a");
  assert.equal(rows[0]!.label, "Task set");
  assert.equal(rows[0]!.runHref, "/project/project%201/traces/turns/turn-a");
  assert.equal(rows[0]!.paths.baseline, true);
  assert.equal(rows[0]!.paths.doesTheWork, false);
  assert.deepEqual(rows[0]!.paths.after, ["seat_map_then_select"]);
  assert.deepEqual(taskReplayRuns(null, "project"), []);
});
