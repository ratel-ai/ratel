import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLineageRef } from "./types";

test("a stored ref is read back strictly", () => {
  assert.deepEqual(
    parseLineageRef({ stage: "improve", kind: "eval", id: "e1", label: "Eval", extra: 1 }),
    {
      stage: "improve",
      kind: "eval",
      id: "e1",
      label: "Eval",
    },
  );
  assert.equal(parseLineageRef({ stage: "nowhere", kind: "x", id: "y" }), null);
  assert.equal(parseLineageRef(null), null);
});
