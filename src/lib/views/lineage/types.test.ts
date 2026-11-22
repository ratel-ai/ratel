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

test("a fine-tuning dataset is an improve-stage kind; its ref opens its use case, a bare ref the Fine-tuning page", async () => {
  const { stageOfKind, KIND_NOUNS, LINEAGE_KINDS } = await import("./types");
  const { datasetRef, hrefFor } = await import("./refs");
  assert.equal(stageOfKind("dataset"), "improve");
  assert.ok((LINEAGE_KINDS.improve as readonly string[]).includes("dataset"));
  assert.equal(KIND_NOUNS.dataset, "dataset");
  const ref = datasetRef("p1", "d1", "u1", "Triage");
  assert.deepEqual(ref, {
    stage: "improve",
    kind: "dataset",
    id: "d1",
    label: "Triage",
    href: "/project/p1/fine-tuning/u1?dataset=d1",
  });
  assert.equal(hrefFor(ref, "p1"), "/project/p1/fine-tuning/u1?dataset=d1");
  assert.equal(
    hrefFor({ stage: "improve", kind: "dataset", id: "d1" }, "p1"),
    "/project/p1/fine-tuning",
  );
  assert.deepEqual(parseLineageRef({ stage: "improve", kind: "dataset", id: "d1" }), {
    stage: "improve",
    kind: "dataset",
    id: "d1",
  });
});
