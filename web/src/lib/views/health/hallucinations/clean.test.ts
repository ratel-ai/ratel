import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanResult } from "@/lib/views/health/hallucinations/clean";

const groups = (unchecked: ReadonlyArray<"tool" | "input" | "completion">) =>
  (["tool", "input", "completion"] as const).map((group) => ({
    group,
    unchecked: unchecked.includes(group) ? "nothing to read" : null,
  }));

test("nothing found where something was checked says the agent is trustworthy", () => {
  const result = { state: "clean", title: "Your agent is trustworthy" };
  assert.deepEqual(cleanResult({ groups: groups([]), toolNames: null }), result);
  assert.deepEqual(cleanResult({ groups: groups(["completion"]), toolNames: null }), result);
  assert.deepEqual(
    cleanResult({
      groups: groups(["input", "completion"]),
      toolNames: { calls: 40, callsOnWorking: 40 },
    }),
    result,
  );
});

test("a call to a name that never worked keeps the result positive but does not call the agent trustworthy", () => {
  assert.deepEqual(
    cleanResult({
      groups: groups(["input", "completion"]),
      toolNames: { calls: 41187, callsOnWorking: 41185 },
    }),
    { state: "clean", title: "No hallucinations found" },
  );
});

test("nothing checked makes no claim about the agent", () => {
  const result = cleanResult({
    groups: groups(["tool", "input", "completion"]),
    toolNames: null,
  });
  assert.equal(result.state, "unchecked");
  assert.doesNotMatch(result.title, /trust|no hallucinations/i);
});
