import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseSpread,
  DEFAULT_ROW_LIMIT,
  datasetDetailsSchema,
  datasetQuerySchema,
  MAX_ROW_LIMIT,
  rowKindOf,
  valueRowSchema,
  valuesContent,
} from "../domain/dataset";

test("each kind parses, and a query kind gets the default row limit", () => {
  const parse = (query: unknown) => datasetQuerySchema.parse(query);
  assert.deepEqual(parse({ kind: "fixed" }), { kind: "fixed" });
  assert.deepEqual(parse({ kind: "last_traces" }), {
    kind: "last_traces",
    limit: DEFAULT_ROW_LIMIT,
  });
  assert.deepEqual(parse({ kind: "task_traces", taskId: "refunds", limit: 10 }), {
    kind: "task_traces",
    taskId: "refunds",
    limit: 10,
  });
  assert.deepEqual(parse({ kind: "rql", text: "select trace_id from traces" }), {
    kind: "rql",
    text: "select trace_id from traces",
    limit: DEFAULT_ROW_LIMIT,
  });
  assert.deepEqual(parse({ kind: "auto" }), {
    kind: "auto",
    taskId: null,
    limit: DEFAULT_ROW_LIMIT,
  });
});

test("a limit above the hard limit is refused with the reason", () => {
  const result = datasetQuerySchema.safeParse({ kind: "last_traces", limit: MAX_ROW_LIMIT + 1 });
  assert.equal(result.success, false);
  assert.match(result.error?.issues[0]?.message ?? "", /at most 500 rows/);
  assert.equal(
    datasetQuerySchema.safeParse({ kind: "last_traces", limit: MAX_ROW_LIMIT }).success,
    true,
  );
  assert.equal(datasetQuerySchema.safeParse({ kind: "task_traces", limit: 5 }).success, false);
  assert.equal(datasetQuerySchema.safeParse({ kind: "rql", text: " " }).success, false);
});

test("a dataset has a name", () => {
  assert.equal(datasetDetailsSchema.safeParse({ name: " " }).success, false);
  assert.deepEqual(datasetDetailsSchema.parse({ name: " Refunds " }), {
    name: "Refunds",
    description: null,
  });
});

test("a value row holds named typed values and becomes the input of a case", () => {
  const row = valueRowSchema.parse({
    values: { order: "A200", amount: 12.5, vip: true, tags: ["a"], meta: { x: null } },
    expectedOutput: "No refund.",
  });
  const content = valuesContent(row);
  assert.deepEqual(content, {
    input: { order: "A200", amount: 12.5, vip: true, tags: ["a"], meta: { x: null } },
    earlierTurns: [],
    toolFixtures: [],
    expectedOutput: "No refund.",
  });
  assert.equal(valueRowSchema.safeParse({ values: {} }).success, false);
  assert.equal(valueRowSchema.safeParse({ values: { "bad name": 1 } }).success, false);
});

test("a row from a turn is a trace row, any other row holds values", () => {
  assert.equal(rowKindOf({ sourceTurnId: "t1" }), "trace");
  assert.equal(rowKindOf({ sourceTurnId: null }), "values");
});

test("let Ratel choose: newest failed turns first, then a spread over tasks", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 10, minute));
  const candidates = [
    { turnId: "a1", taskId: "a", failed: false, endedAt: at(9) },
    { turnId: "a2", taskId: "a", failed: false, endedAt: at(8) },
    { turnId: "a3", taskId: "a", failed: false, endedAt: at(7) },
    { turnId: "b1", taskId: "b", failed: false, endedAt: at(6) },
    { turnId: "f-old", taskId: "a", failed: true, endedAt: at(1) },
    { turnId: "f-new", taskId: null, failed: true, endedAt: at(5) },
    { turnId: "n1", taskId: null, failed: false, endedAt: at(4) },
  ];
  assert.deepEqual(chooseSpread(candidates, 5), ["f-new", "f-old", "a1", "b1", "n1"]);
  assert.deepEqual(chooseSpread(candidates, 1), ["f-new"]);
  assert.deepEqual(chooseSpread(candidates, 100).length, candidates.length);
});
