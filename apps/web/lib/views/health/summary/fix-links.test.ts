import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESCRIPTION_FIX_LABEL,
  descriptionFixHref,
  descriptionsHref,
  type FixRef,
  isDescriptionFix,
  rewriteOfTool,
} from "@/lib/views/health/summary/fix-links";

/**
 * A description update is made on Quality › Descriptions, never on Fixes:
 * on Quality's own rewrite of the tool when one exists, else on the tool.
 */

const PROJECT = "p 1";

test("Quality › Descriptions, on a tool or on one of Quality's rewrites", () => {
  assert.equal(
    descriptionsHref(PROJECT, { tool: "create_task" }),
    "/project/p%201/quality/descriptions?tool=create_task",
  );
  assert.equal(
    descriptionsHref(PROJECT, { rewrite: "rewrite:9f3" }),
    "/project/p%201/quality/descriptions?peek=rewrite%3A9f3",
  );
  assert.equal(
    new URL(descriptionsHref("p1", { rewrite: "rewrite:9f3" }), "http://x").searchParams.get(
      "peek",
    ),
    "rewrite:9f3",
    "the peek reads back whole",
  );
  assert.equal(DESCRIPTION_FIX_LABEL, "Update description");
  assert.equal(isDescriptionFix("rewrite"), true);
  assert.equal(
    isDescriptionFix("tell-apart"),
    true,
    "telling two tools apart is a change to their descriptions",
  );
  assert.equal(isDescriptionFix("fail-clearly"), false);
  assert.equal(isDescriptionFix(undefined), false);
});

const QUALITY_OPEN: FixRef = {
  id: "rewrite:open",
  kind: "rewrite",
  source: "rewrite",
  status: "open",
  toolIds: ["create_task"],
};
const QUALITY_APPLIED: FixRef = {
  id: "rewrite:done",
  kind: "rewrite",
  source: "rewrite",
  status: "applied",
  toolIds: ["create_task"],
};
const DRAFT: FixRef = {
  id: "craft:7",
  kind: "rewrite",
  source: "craft",
  status: "open",
  toolIds: ["create_task"],
};
const ISSUE_ONLY: FixRef = { id: "issue:a", kind: "rewrite", source: "issue", status: "open" };

test("Quality's rewrite of the tool when Fixes holds one: an open one before an applied one", () => {
  assert.equal(rewriteOfTool([QUALITY_APPLIED, DRAFT, QUALITY_OPEN], "create_task"), QUALITY_OPEN);
  assert.equal(rewriteOfTool([QUALITY_APPLIED, DRAFT], "create_task"), QUALITY_APPLIED);
  assert.equal(rewriteOfTool([DRAFT], "create_task"), null, "a drafted rewrite is not Quality's");
  assert.equal(rewriteOfTool([QUALITY_OPEN], "assign_task"), null);
});

test("a description fix opens Quality's rewrite of its tool, else its tool on Descriptions", () => {
  const all = [QUALITY_OPEN, DRAFT, ISSUE_ONLY];
  assert.equal(
    descriptionFixHref("p1", QUALITY_OPEN, all, null),
    "/project/p1/quality/descriptions?peek=rewrite%3Aopen",
    "Quality's own rewrite",
  );
  assert.equal(
    descriptionFixHref("p1", DRAFT, all, null),
    "/project/p1/quality/descriptions?peek=rewrite%3Aopen",
    "a draft of a tool Quality rewrites opens Quality's",
  );
  assert.equal(
    descriptionFixHref("p1", ISSUE_ONLY, all, "create_task"),
    "/project/p1/quality/descriptions?peek=rewrite%3Aopen",
    "an issue's own fix, by the tool it names",
  );
  assert.equal(
    descriptionFixHref("p1", ISSUE_ONLY, [ISSUE_ONLY], "assign_task"),
    "/project/p1/quality/descriptions?tool=assign_task",
    "no rewrite yet: the tool",
  );
  assert.equal(
    descriptionFixHref("p1", ISSUE_ONLY, [], null),
    null,
    "no tool, no description page",
  );
  const apart: FixRef = {
    id: "issue:b",
    kind: "tell-apart",
    source: "issue",
    status: "open",
    toolIds: ["find_documents", "search_document_chunks"],
  };
  assert.equal(
    descriptionFixHref("p1", apart, [apart], null),
    "/project/p1/quality/descriptions?tool=find_documents",
    "two tools apart: the first one",
  );
});
