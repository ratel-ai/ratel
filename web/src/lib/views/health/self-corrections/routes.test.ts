import assert from "node:assert/strict";
import { test } from "node:test";
import { selfCorrectionsHref } from "@/lib/views/health/self-corrections/paths";
import { selfCorrectionsRedirect } from "@/lib/views/health/self-corrections/routes";

const QUERY = { days: "30", tool: "skill:x", task: "wf 1", topic: ["t-1", "t-2"], peek: undefined };

test("flag on: the Agent health address moves to Insights with its query", () => {
  assert.equal(
    selfCorrectionsRedirect("health", true, "p 1", { days: "30", tool: "x" }),
    "/project/p%201/self-corrections?days=30&tool=x",
  );
  assert.equal(
    selfCorrectionsRedirect("health", true, "p1", QUERY),
    "/project/p1/self-corrections?days=30&tool=skill%3Ax&task=wf+1&topic=t-1&topic=t-2",
  );
  assert.equal(selfCorrectionsRedirect("top-level", true, "p1", QUERY), null);
});

test("flag off: the Insights address moves to Agent health, where every link points", () => {
  assert.equal(
    selfCorrectionsRedirect("top-level", false, "p1", { days: "30", tool: "x" }),
    selfCorrectionsHref("p1", { days: 30, filters: { tool: "x" } }),
  );
  assert.equal(selfCorrectionsRedirect("top-level", false, "p1"), selfCorrectionsHref("p1"));
  assert.equal(selfCorrectionsRedirect("health", false, "p1", QUERY), null);
});
