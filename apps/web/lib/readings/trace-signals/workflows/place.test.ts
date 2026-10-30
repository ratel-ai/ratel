import assert from "node:assert/strict";
import { test } from "node:test";
import { mineWorkflows } from "@/lib/readings/trace-signals/workflows/mine";
import { workflowFingerprint } from "@/lib/readings/trace-signals/workflows/order";
import {
  membersByTask,
  placeRuns,
  reshapeWorkflow,
} from "@/lib/readings/trace-signals/workflows/place";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";
import type { Workflow, WorkflowCore } from "@/lib/readings/trace-signals/workflows/types";
import { turnUnit } from "@/lib/readings/trace-signals/workflows/units";

const core = (id: string, ...tools: string[]): WorkflowCore => ({
  id,
  coreTools: [...tools].sort(),
});

test("every run gets a task or null: two or more distinct tools, read by the basis, matching a core", () => {
  const tasks = [core("plan", "list", "backlog", "estimate"), core("close", "find", "update")];
  const runs = [
    wfTurn(["list", "backlog", "estimate", "assign"], { id: "contained" }),
    wfTurn(["find", "update", "update"], { id: "repeats" }),
    wfTurn(["update"], { id: "one-tool" }),
    wfTurn([], { id: "no-call" }),
    wfTurn(["x", "y"], { id: "no-match" }),
    wfTurn(["find", "update"], { id: "otel", turnSource: "otlp" }),
  ];
  const all = placeRuns(runs, tasks, { weights: {}, basis: "all" });
  assert.deepEqual(Object.fromEntries(all), {
    contained: "plan",
    repeats: "close",
    "one-tool": null,
    "no-call": null,
    "no-match": null,
    otel: "close",
  });
  const exact = placeRuns(runs, tasks, { weights: {}, basis: "exact" });
  assert.equal(
    exact.get("contained"),
    null,
    "a guessed run is left out when exact runs carry the reading",
  );
  assert.equal(exact.get("otel"), "close");
  const none = placeRuns(runs, tasks, { weights: {}, basis: "none" });
  assert.ok(
    [...none.values()].every((id) => id === null),
    "runs mixed together belong to no task",
  );
});

test("a single tool never joins a task, even when its weight alone would match the core", () => {
  // The rare tool weighs enough that {rare} vs {rare, common} clears the weighted Jaccard floor.
  const weights = { rare: 5, common: 0.5 };
  const placed = placeRuns(
    [wfTurn(["rare"], { id: "alone" }), wfTurn(["rare", "common"], { id: "both" })],
    [core("t", "rare", "common")],
    {
      weights,
      basis: "all",
    },
  );
  assert.equal(placed.get("alone"), null);
  assert.equal(placed.get("both"), "t");
});

test("members by task keep the input order", () => {
  const members = membersByTask(
    new Map([
      ["a", "t1"],
      ["b", null],
      ["c", "t2"],
      ["d", "t1"],
    ]),
  );
  assert.deepEqual(Object.fromEntries(members), { t1: ["a", "d"], t2: ["c"] });
});

test("a task's shape is read again from the runs placed in it, its core unchanged", () => {
  const runs = [
    ...many(16, () => wfTurn(["b", "a", "c"])),
    ...many(4, () => wfTurn(["a", "b", "c", "opt"])),
    ...many(20, () => wfTurn(["a", "b", "helper"])),
  ];
  const mined: Workflow = {
    id: "kept-id",
    coreTools: ["a", "b"],
    optionalTools: [],
    helperTools: [],
    entryTool: "a",
    typicalOrder: ["a", "b"],
    orderStability: 1,
    orderRuns: 99,
    orderStableRuns: 99,
    memberTurnIds: ["stale"],
    runs: 99,
    share: 0.9,
    seedTools: ["a", "b"],
    seedSupport: 99,
  };
  const reshaped = reshapeWorkflow(mined, runs.map(turnUnit), {
    ubiquitous: new Set(["helper"]),
    turnsWithTools: 80,
  });
  assert.equal(reshaped.id, "kept-id");
  assert.deepEqual(reshaped.coreTools, ["a", "b"]);
  assert.equal(reshaped.runs, 40);
  assert.equal(reshaped.share, 0.5);
  assert.deepEqual(
    reshaped.memberTurnIds,
    runs.map((r) => r.id),
  );
  assert.deepEqual(reshaped.typicalOrder, ["a", "b"], "a before b in 24 of 40 runs");
  assert.equal(reshaped.orderRuns, 40);
  assert.equal(reshaped.orderStableRuns, 24);
  assert.equal(reshaped.orderStability, 0.6);
  assert.equal(reshaped.entryTool, "a");
  assert.deepEqual(reshaped.optionalTools, ["c"], "c in 20 of 40 runs; opt in 4 of 40 stays out");
  assert.deepEqual(reshaped.helperTools, ["helper"]);
  assert.deepEqual(reshaped.seedTools, ["a", "b"]);
});

test("placement agrees with mining on a clean project", () => {
  const turns = [
    ...many(40, () => wfTurn(["a", "b", "c"])),
    ...many(40, () => wfTurn(["d", "e"])),
    ...many(30, (i) => wfTurn([`solo${i}`])),
  ];
  const mining = mineWorkflows(turns);
  const placed = placeRuns(turns, mining.workflows, { weights: mining.idf, basis: "all" });
  for (const workflow of mining.workflows) {
    assert.deepEqual(membersByTask(placed).get(workflow.id), [...workflow.memberTurnIds]);
  }
  assert.equal(
    [...placed.values()].filter((id) => id === null).length,
    30,
    "single-tool runs stay out",
  );
  assert.equal(
    workflowFingerprint(["a", "b", "c"]),
    mining.workflows.find((w) => w.coreTools.includes("a"))?.id,
  );
});
