import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanResult } from "@/lib/views/health/hallucinations/clean";

const groups = (unchecked: ReadonlyArray<"tool" | "input" | "completion">) =>
  (["tool", "input", "completion"] as const).map((group) => ({
    group,
    unchecked: unchecked.includes(group) ? "nothing to read" : null,
  }));
const at = { turns: 1648, span: "in the last 30 days" };

test("nothing found where everything was checked says the agent is trustworthy, and what was checked", () => {
  assert.deepEqual(cleanResult({ groups: groups([]), toolNames: null, ...at }), {
    state: "clean",
    title: "Your agent is trustworthy",
    info: "Checked the tools, inputs and completion claims of 1,648 turns in the last 30 days.",
  });
});

test("where part was checked, the line names that part", () => {
  const some = cleanResult({ groups: groups(["completion"]), toolNames: null, ...at });
  assert.equal(some.info, "Checked the tools and inputs of 1,648 turns in the last 30 days.");
  const tools = cleanResult({
    groups: groups(["input", "completion"]),
    toolNames: { calls: 40, callsOnWorking: 40 },
    turns: 1,
    span: "this week",
  });
  assert.equal(tools.title, "Your agent is trustworthy");
  assert.equal(tools.info, "Checked the tools of 1 turn this week.");
});

test("a call to a name that never worked keeps the result positive but does not call the agent trustworthy", () => {
  const result = cleanResult({
    groups: groups(["input", "completion"]),
    toolNames: { calls: 41187, callsOnWorking: 41185 },
    ...at,
  });
  assert.equal(result.title, "No hallucinations found");
  assert.equal(result.info, "Checked the tools of 1,648 turns in the last 30 days.");
});

test("nothing checked makes no claim about the agent", () => {
  const result = cleanResult({
    groups: groups(["tool", "input", "completion"]),
    toolNames: null,
    ...at,
  });
  assert.equal(result.state, "unchecked");
  assert.doesNotMatch(result.title, /trust|no hallucinations/i);
});
