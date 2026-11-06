import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTrailingContext } from "@/lib/readings/query-intents/intent-text";

test("stripTrailingContext drops a provenance clause but keeps the ask", () => {
  assert.equal(
    stripTrailingContext("cancel their plan after the requested refund is processed"),
    "cancel their plan",
  );
  assert.equal(
    stripTrailingContext("cancel their plan following the refund request"),
    "cancel their plan",
  );
  assert.equal(
    stripTrailingContext("deploy the service once the tests pass"),
    "deploy the service",
  );
  assert.equal(
    stripTrailingContext("export the report so that finance can review it"),
    "export the report",
  );
  assert.equal(
    stripTrailingContext(
      "find all usages of the deprecated function so they can plan the migration",
    ),
    "find all usages of the deprecated function",
  );
  assert.equal(stripTrailingContext("run the tests before merging"), "run the tests");
});

test("stripTrailingContext leaves a phrase alone when fewer than two tokens would remain", () => {
  assert.equal(stripTrailingContext("after deploy"), "after deploy");
  assert.equal(stripTrailingContext("run after the build"), "run after the build");
});

test("stripTrailingContext is a no-op without a clause", () => {
  assert.equal(stripTrailingContext("refund their order"), "refund their order");
});
