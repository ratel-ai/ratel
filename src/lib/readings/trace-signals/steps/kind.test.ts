import assert from "node:assert/strict";
import { test } from "node:test";
import { stepKindOf } from "./kind";

test("stored steps map to public kinds while legacy search and run markers stay unclassified", () => {
  const cases = [
    [{ kind: "invoke", targetType: "tool" }, "tool_call"],
    [{ kind: "invoke", targetType: "skill" }, "skill"],
    [{ kind: "search" }, null],
    [{ kind: "agent" }, null],
    [{ kind: "user_message" }, "user_message"],
    [{ kind: "model_call" }, "model_call"],
    [{ kind: "code" }, "code"],
    [{ kind: "handoff" }, "handoff"],
    [{ kind: "future_kind" }, null],
  ] as const;
  for (const [step, expected] of cases) assert.equal(stepKindOf(step), expected);
});
