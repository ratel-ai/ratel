import assert from "node:assert/strict";
import { test } from "node:test";
import { mineWorkflows } from "@/lib/readings/trace-signals/workflows/mine";
import { workflowFingerprint } from "@/lib/readings/trace-signals/workflows/order";
import { type Call, many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";
import type { Workflow, WorkflowMiningResult } from "@/lib/readings/trace-signals/workflows/types";

/** Multi-tool turns of tools that never repeat across turns: pure background. */
function noise(n: number, tag: string) {
  return many(n, (i) => wfTurn([`${tag}${i}a`, `${tag}${i}b`]));
}

const cores = (result: WorkflowMiningResult) =>
  result.workflows.map((w) => w.coreTools.join(",")).sort();
const find = (result: WorkflowMiningResult, tool: string): Workflow | undefined =>
  result.workflows.find((w) => w.coreTools.includes(tool));

test("support floor: 9 turns of a group are not a workflow, 10 are", () => {
  const below = mineWorkflows([...many(9, () => wfTurn(["a", "b", "c"])), ...noise(30, "n")]);
  assert.equal(below.workflows.length, 0);
  assert.equal(below.supportFloor, 10);
  const at = mineWorkflows([...many(10, () => wfTurn(["a", "b", "c"])), ...noise(30, "n")]);
  assert.deepEqual(cores(at), ["a,b,c"]);
  assert.equal(at.workflows[0]!.runs, 10);
});

test("support floor: the 1% share wins over 10 once there are enough multi-tool turns", () => {
  const result = mineWorkflows([...many(15, () => wfTurn(["a", "b", "c"])), ...noise(2_000, "n")]);
  assert.equal(result.supportFloor, 21, "1% of 2015 multi-tool turns, rounded up");
  assert.equal(result.workflows.length, 0);
  const tuned = mineWorkflows([...many(15, () => wfTurn(["a", "b", "c"])), ...noise(2_000, "n")], {
    minShare: 0.005,
  });
  assert.deepEqual(cores(tuned), ["a,b,c"]);
});

test("single-tool turns are counted as single steps and never mined; skills are left out", () => {
  const turns = [
    ...many(20, () => wfTurn(["a", "a"])),
    ...many(20, () => wfTurn(["a", { tool: "s1", targetType: "skill" }])),
    ...many(5, () => wfTurn([])),
    ...many(12, () => wfTurn(["a", "b"])),
  ];
  const result = mineWorkflows(turns);
  assert.equal(result.turnsWithTools, 52);
  assert.equal(result.singleStepTurns, 40);
  assert.equal(result.multiToolTurns, 12);
  assert.deepEqual(cores(result), ["a,b"]);
  assert.equal(result.workflows[0]!.share, 12 / 52);
});

test("IDF and the helper rule keep a tool in 80% of turns out of every core", () => {
  const helper = (i: number, calls: Call[]): Call[] =>
    i % 5 === 0 ? calls : ["get_user", ...calls];
  const turns = [
    ...many(100, (i) => wfTurn(helper(i, ["find", "assign", "notify"]))),
    ...many(100, (i) => wfTurn(helper(i, ["list", "backlog", "estimate"]))),
    ...many(50, (i) => wfTurn(["get_user", `n${i}`])),
  ];
  const result = mineWorkflows(turns);
  assert.deepEqual(result.ubiquitousTools, ["get_user"], "in 210 of 250 multi-tool turns");
  assert.deepEqual(cores(result), ["assign,find,notify", "backlog,estimate,list"]);
  for (const workflow of result.workflows) {
    assert.ok(!workflow.coreTools.includes("get_user"));
    assert.deepEqual(workflow.helperTools, ["get_user"]);
    assert.equal(workflow.runs, 100);
  }
  assert.ok(result.idf.get_user! < result.idf.find!, "the helper weighs less");
});

test("a helper that really belongs to a group joins its core", () => {
  const turns = [
    ...many(120, () => wfTurn(["get_user", "find", "assign"])),
    ...many(80, (i) => wfTurn(i % 2 === 0 ? ["list", "backlog"] : ["get_user", "list", "backlog"])),
  ];
  const result = mineWorkflows(turns);
  assert.deepEqual(cores(result), ["assign,find,get_user", "backlog,list"]);
});

test("closed sets: A,B,C wins over A,B when C nearly always comes along", () => {
  const always = mineWorkflows([
    ...many(90, () => wfTurn(["a", "b", "c"])),
    ...many(10, () => wfTurn(["a", "b"])),
    ...noise(60, "n"),
  ]);
  assert.deepEqual(cores(always), ["a,b,c"]);
  assert.equal(always.workflows[0]!.runs, 100, "the A,B turns join by Jaccard");
  const half = mineWorkflows([
    ...many(50, () => wfTurn(["a", "b", "c"])),
    ...many(50, () => wfTurn(["a", "b"])),
    ...noise(60, "n"),
  ]);
  assert.deepEqual(cores(half), ["a,b"]);
  assert.deepEqual(half.workflows[0]!.optionalTools, ["c"]);
});

test("two workflows that share tools are separated", () => {
  const turns = [
    ...many(60, () => wfTurn(["find", "assign", "notify", "log"])),
    ...many(60, () => wfTurn(["find", "assign", "close", "archive"])),
    ...noise(40, "n"),
  ];
  const result = mineWorkflows(turns);
  assert.deepEqual(cores(result), ["archive,assign,close,find", "assign,find,log,notify"]);
  const notify = find(result, "notify")!;
  const close = find(result, "close")!;
  assert.equal(notify.runs, 60);
  assert.equal(close.runs, 60);
  const overlap = notify.memberTurnIds.filter((id) => close.memberTurnIds.includes(id));
  assert.equal(overlap.length, 0);
  assert.equal(result.assignedTurns, 120);
});

test("the fingerprint is the sorted core's hash and survives an optional tool", () => {
  const base = [
    ...many(60, () => wfTurn(["a", "b", "c"])),
    ...many(60, () => wfTurn(["d", "e", "f"])),
    ...noise(40, "n"),
  ];
  const withOptional = [
    ...many(60, (i) => wfTurn(i % 4 === 0 ? ["a", "b", "extra", "c"] : ["a", "b", "c"])),
    ...many(60, () => wfTurn(["d", "e", "f"])),
    ...noise(40, "n"),
  ];
  const first = mineWorkflows(base);
  const second = mineWorkflows(withOptional);
  assert.deepEqual(
    second.workflows.map((w) => w.id).sort(),
    first.workflows.map((w) => w.id).sort(),
  );
  assert.equal(find(first, "a")!.id, workflowFingerprint(["c", "b", "a"]));
  assert.match(find(first, "a")!.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(find(second, "a")!.optionalTools, ["extra"]);
});

test("typical order, order stability and the entry tool", () => {
  const turns = [
    ...many(45, () => wfTurn(["find", "assign", "find", "notify"])),
    ...many(5, () => wfTurn(["assign", "find", "notify"])),
    ...noise(30, "n"),
  ];
  const workflow = mineWorkflows(turns).workflows[0]!;
  assert.deepEqual(workflow.typicalOrder, ["find", "assign", "notify"]);
  assert.equal(workflow.entryTool, "find");
  assert.equal(workflow.orderRuns, 50);
  assert.equal(workflow.orderStableRuns, 45);
  assert.equal(workflow.orderStability, 0.9);
});

test("runs that stopped early join by Jaccard and do not count against order stability", () => {
  const turns = [
    ...many(40, () => wfTurn(["a", "b", "c", "d"])),
    ...many(10, () => wfTurn(["a", "b", "c"])),
    ...noise(30, "n"),
  ];
  const workflow = mineWorkflows(turns).workflows[0]!;
  assert.deepEqual(workflow.coreTools, ["a", "b", "c", "d"]);
  assert.equal(workflow.runs, 50);
  assert.equal(workflow.orderRuns, 40);
  assert.equal(workflow.orderStability, 1);
});

test("maxWorkflows caps the list, and the output is deterministic", () => {
  const turns = Array.from({ length: 8 }, (_, k) =>
    many(20, () => wfTurn([`t${k}a`, `t${k}b`])),
  ).flat();
  assert.equal(mineWorkflows(turns, { maxWorkflows: 3 }).workflows.length, 3);
  assert.deepEqual(mineWorkflows(turns), mineWorkflows(turns));
  assert.equal(mineWorkflows([]).workflows.length, 0);
});

test("the candidate cap truncates a dense lattice without failing", () => {
  const dense = many(300, () =>
    wfTurn(["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9"]),
  );
  const result = mineWorkflows(dense, { maxCandidates: 50 });
  assert.equal(result.truncated, true);
  assert.ok(result.candidateCount <= 50);
  assert.equal(result.workflows.length, 1);
  assert.equal(
    result.workflows[0]!.coreTools.length,
    10,
    "tools in every turn of it are core, seed or not",
  );
});
