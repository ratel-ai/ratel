import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePath, runCheck } from "./check";
import { traceFixture } from "./test-support";
import type { CheckConfig } from "./types";

const trace = traceFixture({
  durationMs: 1200,
  costUsd: 0.02,
  inputTokens: 100,
  outputTokens: 20,
  error: false,
  models: ["gpt-a", "gpt-b"],
  tools: ["search_docs"],
  service: "checkout",
  environment: null,
  attributes: {
    "http.status": "200",
    "user.plan": "Pro",
    "app.flag": true,
    nested: { deep: 3 },
    nothing: null,
    tags: [],
  },
});

const cases: [string, CheckConfig, boolean][] = [
  ["equals text", { path: "service", op: "eq", value: "checkout" }, true],
  ["equals is exact", { path: "attributes.user.plan", op: "eq", value: "pro" }, false],
  ["equals any list item", { path: "models", op: "eq", value: "gpt-b" }, true],
  ["equals a boolean written as text", { path: "error", op: "eq", value: "false" }, true],
  [
    "equals a numeric text and a number",
    { path: "attributes.http.status", op: "eq", value: 200 },
    true,
  ],
  ["equals a number and a numeric text", { path: "total_tokens", op: "eq", value: "120" }, true],
  ["not equals", { path: "service", op: "ne", value: "billing" }, true],
  ["not equals holds for no list item", { path: "models", op: "ne", value: "gpt-a" }, false],
  ["contains ignores case", { path: "attributes.user.plan", op: "contains", value: "PR" }, true],
  ["contains in a list", { path: "tools", op: "contains", value: "docs" }, true],
  ["contains misses in an empty list", { path: "agents", op: "contains", value: "x" }, false],
  ["greater", { path: "duration_ms", op: "gt", value: 1200 }, false],
  ["greater or equal", { path: "duration_ms", op: "gte", value: 1200 }, true],
  ["smaller", { path: "cost_usd", op: "lt", value: "0.03" }, true],
  ["smaller or equal", { path: "input_tokens", op: "lte", value: 99 }, false],
  [
    "orders a numeric text as a number, not as text",
    { path: "attributes.http.status", op: "gt", value: 99 },
    true,
  ],
  ["exists", { path: "attributes.app.flag", op: "exists" }, true],
  ["exists fails on a missing attribute", { path: "attributes.none", op: "exists" }, false],
  [
    "exists fails on null and on an empty list",
    { path: "attributes.nothing", op: "exists" },
    false,
  ],
  ["exists fails on an empty list", { path: "attributes.tags", op: "exists" }, false],
];

for (const [name, config, passed] of cases) {
  test(name, () => {
    assert.deepEqual(runCheck(config, trace), {
      status: "scored",
      score: { value: passed ? 1 : 0, passed, confidence: null },
    });
  });
}

test("a missing attribute is skipped, not failed, for every operator but exists", () => {
  for (const op of ["eq", "ne", "contains", "gt", "gte", "lt", "lte"] as const) {
    for (const path of ["attributes.none", "attributes.nothing", "environment", "unknown"])
      assert.deepEqual(runCheck({ path, op, value: 1 }, trace), {
        status: "skipped",
        reason: "missing_attribute",
      });
  }
});

test("an order on text is skipped", () => {
  assert.deepEqual(runCheck({ path: "service", op: "gt", value: 1 }, trace), {
    status: "skipped",
    reason: "not_a_number",
  });
});

test("a path reads a nested attribute, and never an inherited property", () => {
  assert.equal(resolvePath(trace, "attributes.nested.deep"), 3);
  assert.equal(resolvePath(trace, "attributes.constructor"), undefined);
  assert.equal(resolvePath(trace, "constructor"), undefined);
});
