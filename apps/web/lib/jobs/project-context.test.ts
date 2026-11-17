import assert from "node:assert/strict";
import { test } from "node:test";
import { jobAsk } from "./project-context";

test("a job's ask names its kind, its project and its payload", () => {
  assert.equal(
    jobAsk({ kind: "draft_fix", projectId: "p-1", payload: { fixId: "f-9" } }),
    'draft_fix for project p-1\n{"fixId":"f-9"}',
  );
});

test("a job with no payload asks by kind and project only", () => {
  assert.equal(
    jobAsk({ kind: "label_workflows", projectId: "p-1", payload: null }),
    "label_workflows for project p-1",
  );
});
