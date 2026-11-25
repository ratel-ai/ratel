import assert from "node:assert/strict";
import { test } from "node:test";
import { toolNameCheck } from "@/lib/views/health/hallucinations/tool-names";

test("a name that worked once exists, whatever failed under it", () => {
  const rows = [
    { name: "Read", calls: 98, worked: 90 },
    { name: "Edit", calls: 2, worked: 1 },
  ];
  assert.deepEqual(toolNameCheck(rows), { calls: 100, callsOnWorking: 100 });
});

test("calls to a name that never worked are not counted as working", () => {
  const rows = [
    { name: "Read", calls: 10, worked: 10 },
    { name: "a", calls: 3, worked: 0 },
  ];
  assert.deepEqual(toolNameCheck(rows), { calls: 13, callsOnWorking: 10 });
});
