import assert from "node:assert/strict";
import { test } from "node:test";
import { movedSelfCorrectionsHref } from "@/lib/views/health/self-corrections/routes";

test("the Agent health address moves to Insights with its query", () => {
  assert.equal(movedSelfCorrectionsHref("p 1"), "/project/p%201/self-corrections");
  assert.equal(
    movedSelfCorrectionsHref("p1", {
      days: "30",
      tool: "skill:x",
      task: "wf 1",
      topic: ["t-1", "t-2"],
      peek: undefined,
    }),
    "/project/p1/self-corrections?days=30&tool=skill%3Ax&task=wf+1&topic=t-1&topic=t-2",
  );
});
