import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PREVIOUS_WORKFLOWS,
  parsePreviousWorkflows,
} from "@/lib/readings/trace-signals/signals/workflow-previous";

test("stored items parse to id and sorted core tools; everything else is dropped", () => {
  const items = [
    {
      id: "wf-1",
      fingerprint: "wf-1",
      coreTools: ["b", "a", "b"],
      typicalOrder: ["a", "b"],
      health: { completion: 1 },
    },
    { id: "wf-2", coreTools: ["x", "y"] },
  ];
  assert.deepEqual(parsePreviousWorkflows(items), [
    { id: "wf-1", coreTools: ["a", "b"] },
    { id: "wf-2", coreTools: ["x", "y"] },
  ]);
});

test("malformed stored JSON reads as no previous workflows, item by item", () => {
  for (const bad of [null, undefined, "items", 42, { id: "wf" }])
    assert.deepEqual(parsePreviousWorkflows(bad), []);
  const mixed = [
    null,
    "wf",
    [],
    { id: "", coreTools: ["a"] },
    { id: 7, coreTools: ["a"] },
    { id: "x".repeat(200), coreTools: ["a"] },
    { id: "no-tools", coreTools: [] },
    { id: "bad-tools", coreTools: ["a", 3] },
    { id: "blank-tool", coreTools: ["a", ""] },
    { id: "ok", coreTools: ["a", "b"] },
    { id: "ok", coreTools: ["c", "d"] },
  ];
  assert.deepEqual(
    parsePreviousWorkflows(mixed),
    [{ id: "ok", coreTools: ["a", "b"] }],
    "duplicate ids keep the first",
  );
});

test("a runaway list is cut at the read cap", () => {
  const items = Array.from({ length: MAX_PREVIOUS_WORKFLOWS + 10 }, (_, i) => ({
    id: `wf-${i}`,
    coreTools: ["a", "b"],
  }));
  assert.equal(parsePreviousWorkflows(items).length, MAX_PREVIOUS_WORKFLOWS);
});
