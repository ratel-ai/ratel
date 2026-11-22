import assert from "node:assert/strict";
import { test } from "node:test";
import { wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";
import {
  formsTask,
  stepsUnit,
  taskSteps,
  turnUnit,
} from "@/lib/readings/trace-signals/workflows/units";

const typed = { typedSteps: true };

test("flag off: a unit holds the distinct tools, skills and typed steps left out", () => {
  const turn = wfTurn([
    "b",
    { tool: "s", targetType: "skill" },
    { tool: "plan", kind: "model_call" },
    "a",
    "b",
  ]);
  assert.deepEqual(turnUnit(turn), {
    turnId: turn.id,
    tools: ["a", "b"],
    path: ["b", "a"],
    nonTools: [],
  });
});

test("flag on: a unit holds every step's token in first-occurrence order; user messages are no item", () => {
  const turn = wfTurn([
    { tool: "", kind: "user_message" },
    { tool: "plan", kind: "model_call" },
    "search",
    { tool: "s1", targetType: "skill" },
    { tool: "fetch", kind: "code" },
    { tool: "researcher", kind: "handoff" },
    { tool: "plan", kind: "model_call" },
    "search",
  ]);
  const unit = turnUnit(turn, typed);
  assert.deepEqual(unit.path, [
    "model:plan",
    "search",
    "skill:s1",
    "code:fetch",
    "handoff:researcher",
  ]);
  assert.deepEqual(unit.tools, [
    "code:fetch",
    "handoff:researcher",
    "model:plan",
    "search",
    "skill:s1",
  ]);
  assert.deepEqual(unit.nonTools, ["code:fetch", "handoff:researcher", "model:plan", "skill:s1"]);
});

test("the unit builder reads a step list, so a piece of a turn makes its own unit", () => {
  const turn = wfTurn([{ tool: "plan", kind: "model_call" }, "search", "fetch"]);
  assert.deepEqual(stepsUnit("piece", turn.steps.slice(1), typed).path, ["search", "fetch"]);
});

test("floor: two distinct tools, or one token when any token is not a tool", () => {
  assert.equal(formsTask(turnUnit(wfTurn(["a", "a"]), typed)), false);
  assert.equal(formsTask(turnUnit(wfTurn(["a", "b"]), typed)), true);
  assert.equal(formsTask(turnUnit(wfTurn([{ tool: "plan", kind: "model_call" }]), typed)), true);
  assert.equal(
    formsTask(turnUnit(wfTurn([{ tool: "plan", kind: "model_call" }]))),
    false,
    "flag off: no token",
  );
  assert.equal(formsTask(turnUnit(wfTurn([{ tool: "", kind: "user_message" }]), typed)), false);
});

test("task steps carry the token as their target id, flag on; tool calls only, flag off", () => {
  const turn = wfTurn([
    { tool: "plan", kind: "model_call", outcome: "error" },
    "search",
    { tool: "s1", targetType: "skill" },
  ]);
  assert.deepEqual(
    taskSteps(turn).map((step) => step.targetId),
    ["search"],
  );
  const steps = taskSteps(turn, typed);
  assert.deepEqual(
    steps.map((step) => step.targetId),
    ["model:plan", "search", "skill:s1"],
  );
  assert.equal(steps[0]!.outcome, "error");
});
