import assert from "node:assert/strict";
import { test } from "node:test";
import {
  argumentNamedIn,
  classifyError,
  countTurnReliability,
  createReliabilityStats,
  finishReliability,
  MAX_PREREQUISITE_ROWS,
} from "@/lib/readings/tool-explorer/reliability";

const step = (toolId: string, outcome: "ok" | "error" = "ok", endId?: string) =>
  ({
    kind: "invoke" as const,
    targetType: "tool",
    targetId: toolId,
    outcome,
    occurredAt: new Date(0),
    tookMs: 10,
    endTraceEventId: endId,
  }) as never;
const turn = (steps: unknown[]) => ({ steps }) as never;

test("classifyError reads the message only, and an absent or opaque message is other", () => {
  assert.equal(classifyError("Invalid status: must be one of todo, done"), "validation");
  assert.equal(classifyError("statusKey is required"), "validation");
  assert.equal(classifyError("Task not found"), "not_found");
  assert.equal(classifyError("No such project"), "not_found");
  assert.equal(classifyError("Internal server error"), "server");
  assert.equal(classifyError("request timed out, try again"), "server");
  assert.equal(classifyError("operation_failed"), "other");
  assert.equal(classifyError(null), "other");
  assert.equal(classifyError(undefined), "other");
});

test("argumentNamedIn finds the argument a validation message names, and nothing when it names none", () => {
  assert.equal(
    argumentNamedIn("Invalid statusKey or statusId — status not available"),
    "statusKey",
  );
  assert.equal(argumentNamedIn("Description must be 10000 characters or less"), "Description");
  assert.equal(argumentNamedIn("missing required field assignee"), "assignee");
  assert.equal(argumentNamedIn("validation_failed"), null);
  assert.equal(argumentNamedIn("The value is required"), null, "a filler word is not an argument");
  assert.equal(argumentNamedIn(null), null);
});

test("a prerequisite row splits a failing tool's calls by whether the other tool ran earlier in the turn, and the arithmetic closes", () => {
  const stats = createReliabilityStats();
  for (let i = 0; i < 4; i += 1) countTurnReliability(stats, turn([step("lookup"), step("write")]));
  for (let i = 0; i < 3; i += 1) countTurnReliability(stats, turn([step("write", "error")]));
  countTurnReliability(stats, turn([step("write")]));
  const out = finishReliability(stats);
  const write = out.tools.find((t) => t.toolId === "write")!;
  assert.deepEqual(
    [write.calls, write.errorCalls, write.retriedErrors],
    [8, 3, 0],
    "an error with no later call of the tool is not a retry",
  );
  const pair = out.prerequisites.find((p) => p.a === "lookup" && p.b === "write")!;
  assert.deepEqual(pair, {
    a: "lookup",
    b: "write",
    withA: { calls: 4, errors: 0 },
    withoutA: { calls: 4, errors: 3 },
  });
  assert.equal(pair.withA.calls + pair.withoutA.calls, write.calls);
  assert.equal(pair.withA.errors + pair.withoutA.errors, write.errorCalls);
  assert.equal(
    out.prerequisites.find((p) => p.b === "lookup"),
    undefined,
    "a tool that never failed has no prerequisite rows",
  );
});

test("the recovery path keeps at most five lookups per tool, commonest first, and the pair list is capped", () => {
  const stats = createReliabilityStats();
  const errors = new Map([["e", { message: "validation_failed" }]]);
  for (let i = 0; i < 7; i += 1) {
    const via = `lookup_${i}`;
    for (let k = 0; k <= i; k += 1)
      countTurnReliability(
        stats,
        turn([step("write", "error", "e"), step(via), step("write")]),
        errors,
      );
  }
  const write = finishReliability(stats).tools.find((t) => t.toolId === "write")!;
  assert.equal(write.recoveredVia!.length, 5);
  assert.deepEqual(
    write.recoveredVia!.map((v) => v.tool),
    ["lookup_6", "lookup_5", "lookup_4", "lookup_3", "lookup_2"],
  );
  assert.equal(write.recoveredDirect, 0, "every recovery went through a lookup");

  const wide = createReliabilityStats();
  for (let i = 0; i < MAX_PREREQUISITE_ROWS + 20; i += 1)
    countTurnReliability(wide, turn([step(`before_${i}`), step("flaky", "error")]));
  assert.equal(finishReliability(wide).prerequisites.length, MAX_PREREQUISITE_ROWS);
});
