import assert from "node:assert/strict";
import { test } from "node:test";
import { kindsOf, parseStepsView, showsAnnotations } from "./view";

test("the preset parser accepts the five URL values and defaults unknown inputs to all", () => {
  const cases = [
    ["all", "all"],
    ["tools", "tools"],
    ["models", "models"],
    ["intents", "intents"],
    ["flow", "flow"],
    [null, "all"],
    [undefined, "all"],
    ["", "all"],
    ["unknown", "all"],
    ["TOOLS", "all"],
    [["tools"], "all"],
    [42, "all"],
  ] as const;
  for (const [input, expected] of cases) assert.equal(parseStepsView(input), expected);
});

test("presets select their step kinds and flow omits annotations", () => {
  assert.deepEqual(kindsOf("all"), [
    "user_message",
    "model_call",
    "tool_call",
    "skill",
    "code",
    "handoff",
  ]);
  assert.deepEqual(kindsOf("tools"), ["tool_call", "skill"]);
  assert.deepEqual(kindsOf("models"), ["model_call"]);
  assert.deepEqual(kindsOf("intents"), ["user_message"]);
  assert.deepEqual(kindsOf("flow"), ["model_call", "tool_call", "skill", "code", "handoff"]);
  assert.equal(showsAnnotations("all"), true);
  assert.equal(showsAnnotations("tools"), true);
  assert.equal(showsAnnotations("models"), true);
  assert.equal(showsAnnotations("intents"), true);
  assert.equal(showsAnnotations("flow"), false);
});
