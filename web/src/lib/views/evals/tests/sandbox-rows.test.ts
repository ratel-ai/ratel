import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxRun } from "@/lib/views/sandboxes";
import { rowOfSandboxRun } from "../sandbox-rows";

const run = (over: object) =>
  ({
    status: "completed",
    request: { input: { message: "hi" } },
    ...over,
  }) as unknown as SandboxRun;

test("a Playground run that has not ended gives no row, and the refusal says why", () => {
  for (const status of ["queued", "running"]) {
    const found = rowOfSandboxRun(run({ status }));
    assert.equal(found.ok, false);
    assert.match(found.ok ? "" : found.message, new RegExp(`is ${status}`));
  }
});

test("a row copies the input, and the output of the result, else of the response, as text", () => {
  assert.deepEqual(rowOfSandboxRun(run({ result: { output: "done" } })), {
    ok: true,
    input: { message: "hi" },
    output: "done",
  });
  const fromResponse = rowOfSandboxRun(run({ status: "failed", response: { output: { a: 1 } } }));
  assert.deepEqual(fromResponse.ok && fromResponse.output, '{"a":1}');
});
