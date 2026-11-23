import assert from "node:assert/strict";
import { test } from "node:test";
import { openProblem, problemPeekId } from "@/lib/views/traces/sentiment/cause-peek";

const problems = [
  { cause: null, key: "" },
  { cause: "misread_request" as const, key: "misread_request" },
];

test("a cause opens its own unsatisfied turns, and the turns no cause was named for open theirs", () => {
  assert.equal(problemPeekId(problems[0]!), "no-cause");
  assert.equal(problemPeekId(problems[1]!), "misread_request");
  for (const problem of problems)
    assert.equal(openProblem(problems, problemPeekId(problem)), problem);
});

test("an address naming a cause nobody was unsatisfied by opens nothing", () => {
  assert.equal(openProblem(problems, "tool_fault"), null);
  assert.equal(openProblem(problems, null), null);
});
