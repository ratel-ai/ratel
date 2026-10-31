import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogToolHref,
  descriptionHref,
  fixesRoot,
  fixHref,
  hasFilters,
  issueHref,
  legacyCraftPeek,
  legacyRewritePeek,
  parseFixFilters,
  taskHref,
  topicHref,
} from "@/lib/views/fixes/href";

test("Fixes lives under Improvements, and every filter is a URL parameter", () => {
  assert.equal(fixesRoot("p 1"), "/project/p%201/improvement/fixes");
  assert.equal(fixHref("p1"), "/project/p1/improvement/fixes");
  assert.equal(fixHref("p1", { kind: "rewrite" }), "/project/p1/improvement/fixes?kind=rewrite");
  assert.equal(
    fixHref("p1", { task: "wf_1", tool: "lookup order", topic: "t3", peek: "rewrite:abc" }),
    "/project/p1/improvement/fixes?task=wf_1&tool=lookup+order&topic=t3&peek=rewrite%3Aabc",
  );
  // Nothing set reads as no filter at all.
  assert.equal(
    fixHref("p1", { kind: null, task: null, tool: "", topic: undefined, peek: null }),
    "/project/p1/improvement/fixes",
  );
});

test("filters are read strictly from the query", () => {
  assert.deepEqual(parseFixFilters({ kind: "merge", task: "wf_1", tool: ["a", "b"], topic: "" }), {
    kind: "merge",
    task: "wf_1",
    tool: "a",
    topic: null,
  });
  assert.deepEqual(parseFixFilters({ kind: "rewrite_tool" }), {
    kind: null,
    task: null,
    tool: null,
    topic: null,
  });
  assert.equal(hasFilters(parseFixFilters({})), false);
  assert.equal(hasFilters(parseFixFilters({ topic: "t1" })), true);
});

test("the neighbours a fix links to", () => {
  assert.equal(issueHref("p1", "sig-1"), "/project/p1/health#signal-sig-1");
  assert.equal(taskHref("p1", "wf 1"), "/project/p1/health/tasks/wf%201");
  assert.equal(topicHref("p1", "t1"), "/project/p1/intents?peek=t1");
  assert.equal(
    catalogToolHref("p1", "lookup_order"),
    "/project/p1/catalogs/tools?highlight=lookup_order",
  );
});

test("a description fix opens Quality › Descriptions: the rewrite, else the tool, else the page", () => {
  assert.equal(
    descriptionHref("p 1", { rewriteId: "abc" }),
    "/project/p%201/quality/descriptions?peek=rewrite%3Aabc",
  );
  assert.equal(
    descriptionHref("p1", { toolId: "lookup order" }),
    "/project/p1/quality/descriptions?tool=lookup%20order",
  );
  assert.equal(
    descriptionHref("p1", { rewriteId: "abc", toolId: "lookup_order" }),
    "/project/p1/quality/descriptions?peek=rewrite%3Aabc",
  );
  assert.equal(descriptionHref("p1"), "/project/p1/quality/descriptions");
});

test("old suggestion links open the same change on Fixes", () => {
  assert.equal(
    legacyCraftPeek("6f1c1c4e-0000-4000-8000-000000000001"),
    "craft:6f1c1c4e-0000-4000-8000-000000000001",
  );
  // The kinds guide and anything that is not a draft id drop the panel.
  assert.equal(legacyCraftPeek("kinds"), null);
  assert.equal(legacyCraftPeek(undefined), null);
  assert.equal(
    legacyRewritePeek(["9a1c1c4e-0000-4000-8000-000000000002"]),
    "rewrite:9a1c1c4e-0000-4000-8000-000000000002",
  );
  assert.equal(legacyRewritePeek("not-an-id"), null);
});
