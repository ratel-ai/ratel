import assert from "node:assert/strict";
import { test } from "node:test";
import { wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";
import {
  formsTask,
  stepsUnit,
  taskSteps,
  turnUnit,
} from "@/lib/readings/trace-signals/workflows/units";

test("a tool keeps its bare id, so a tool-only unit reads as its tools", () => {
  const turn = wfTurn(["b", "a", "b"]);
  assert.deepEqual(turnUnit(turn), {
    turnId: turn.id,
    tools: ["a", "b"],
    path: ["b", "a"],
    nonTools: [],
  });
});

test("a unit holds every step's token in first-occurrence order; user messages are no item", () => {
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
  const unit = turnUnit(turn);
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
  assert.deepEqual(stepsUnit("piece", turn.steps.slice(1)).path, ["search", "fetch"]);
});

test("floor: two distinct tools, or one token when any token is not a tool", () => {
  assert.equal(formsTask(turnUnit(wfTurn(["a", "a"]))), false);
  assert.equal(formsTask(turnUnit(wfTurn(["a", "b"]))), true);
  assert.equal(formsTask(turnUnit(wfTurn([{ tool: "plan", kind: "model_call" }]))), true);
  assert.equal(formsTask(turnUnit(wfTurn([{ tool: "", kind: "user_message" }]))), false);
});

test("task steps carry the token as their target id", () => {
  const turn = wfTurn([
    { tool: "plan", kind: "model_call", outcome: "error" },
    "search",
    { tool: "s1", targetType: "skill" },
  ]);
  const steps = taskSteps(turn);
  assert.deepEqual(
    steps.map((step) => step.targetId),
    ["model:plan", "search", "skill:s1"],
  );
  assert.equal(steps[0]!.outcome, "error");
});
