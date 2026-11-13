import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseRepeats, exampleStatus, exampleSteps } from "@/lib/views/tasks/examples";

const ok = { failed: false };
const bad = { failed: true };

test("how a run ended, read as Self-corrections reads it", () => {
  assert.equal(exampleStatus([ok, ok], 0), "worked");
  assert.equal(exampleStatus([bad, ok], 1), "recovered", "a call failed and a later one worked");
  assert.equal(
    exampleStatus([ok, bad], 1),
    "gave_up",
    "the last call failed and nothing ran after it",
  );
  assert.equal(
    exampleStatus([], 2),
    "failed",
    "its calls are no longer kept: only that one failed",
  );
  assert.equal(exampleStatus([], 0), "worked");
});

test("a run's calls in order: searches are no step, a skill keeps its prefix, names come from the catalog", () => {
  const steps = exampleSteps(
    [
      { kind: "search", targetType: null, targetId: null, outcome: null },
      { kind: "invoke", targetType: "tool", targetId: "find", outcome: "ok" },
      { kind: "invoke", targetType: "skill", targetId: "triage", outcome: "error" },
      { kind: "invoke", targetType: "tool", targetId: null, outcome: "ok" },
      { kind: "invoke", targetType: "tool", targetId: "notify", outcome: "unknown" },
    ],
    new Map([["find", "Find task"]]),
  );
  assert.deepEqual(steps, [
    { toolId: "find", label: "Find task", failed: false },
    { toolId: "skill:triage", label: "skill:triage", failed: true },
    { toolId: "notify", label: "notify", failed: false },
  ]);
});

test("back-to-back calls of one tool fold into one group with its count and failures", () => {
  const step = (toolId: string, failed = false) => ({ toolId, label: toolId, failed });
  assert.deepEqual(collapseRepeats([step("a"), step("b"), step("b", true), step("b"), step("a")]), [
    { toolId: "a", label: "a", failed: false, count: 1, failures: 0 },
    { toolId: "b", label: "b", failed: true, count: 3, failures: 1 },
    { toolId: "a", label: "a", failed: false, count: 1, failures: 0 },
  ]);
  assert.deepEqual(collapseRepeats([]), []);
});
