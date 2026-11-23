import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, compareValues, formatValue, sortValue } from "./format";

const NOW = new Date("2026-11-11T14:00:00Z");

test("text and numbers: exact in tables, abbreviated in stats", () => {
  assert.equal(formatValue("support.chat", "text"), "support.chat");
  assert.equal(formatValue(12431, "number"), "12,431");
  assert.equal(formatValue(12431, "number", "stat"), "12.4K");
  assert.equal(formatValue(0.125, "number"), "0.13");
  assert.equal(formatValue(null, "number"), "–");
});

test("currency: two decimals; null is unpriced, never $0; absent is missing", () => {
  assert.equal(formatValue(3.2, "currency"), "$3.20");
  assert.equal(formatValue(0, "currency"), "$0.00");
  assert.equal(formatValue(0.001, "currency"), "<$0.01");
  assert.equal(formatValue(null, "currency"), "Unpriced");
  assert.equal(formatValue(undefined, "currency"), "–");
});

test("duration, percent and ids read as the console reads them", () => {
  assert.equal(formatValue(820, "duration"), "820 ms");
  assert.equal(formatValue(125_000, "duration"), "2 min 5 s");
  assert.equal(formatValue(0.034, "percent"), "3.4%");
  assert.equal(formatValue("4bf92f3577b34da6a3ce929d0e0e4736", "id"), "4bf92f35…4736");
});

test("dates: relative in tables, absolute in detail, days as days", () => {
  assert.equal(formatValue("2026-11-11T13:57:00Z", "date", "table", NOW), "3 min ago");
  assert.equal(
    formatValue("2026-11-11T13:57:00Z", "date", "detail", NOW),
    "Nov 11, 2026, 13:57:00 UTC",
  );
  assert.equal(formatValue("2026-11-03", "date", "table", NOW), "Nov 3");
});

test("badge, entity and bar fall back to their text", () => {
  assert.equal(formatValue(2, "badge"), "2");
  assert.equal(formatValue("lookup_order", "entity"), "lookup_order");
  assert.equal(formatValue(1500, "bar"), "1,500");
});

test("sorting compares numbers as numbers, text without case, and puts missing last", () => {
  assert.equal(sortValue("10", "number"), 10);
  assert.equal(sortValue("Beta", "text"), "beta");
  assert.equal(sortValue(null, "currency"), null);
  const values = [3, null, 10, 1].map((value) => sortValue(value, "number"));
  assert.deepEqual(
    [...values].sort((a, b) => compareValues(a, b, "desc")),
    [10, 3, 1, null],
  );
  assert.deepEqual(
    [...values].sort((a, b) => compareValues(a, b, "asc")),
    [1, 3, 10, null],
  );
  assert.ok(
    sortValue("2026-11-11T00:00:00Z", "date")! > sortValue("2026-11-10T00:00:00Z", "date")!,
  );
});

test("series aggregates skip non-numbers and say when there is nothing", () => {
  assert.equal(aggregate([1, 2, "3", null], "sum"), 6);
  assert.equal(aggregate([2, 4], "avg"), 3);
  assert.equal(aggregate([2, 9, 4], "max"), 9);
  assert.equal(aggregate([2, 9, 4], "last"), 4);
  assert.equal(aggregate([], "sum"), null);
});

test("task shares, per-100 rates and cost read as the task pages print them", () => {
  // lib/tasks/format.ts formatShare: a whole percent, never a false 0% or 100%.
  assert.equal(formatValue(0.094, "share"), "9%");
  assert.equal(formatValue(0.004, "share"), "<1%");
  assert.equal(formatValue(0.996, "share"), ">99%");
  assert.equal(formatValue(1, "share"), "100%");
  assert.equal(formatValue(null, "share"), "–");
  // formatPer100: one decimal below ten, whole from ten.
  assert.equal(formatValue(12.37, "per100"), "12");
  assert.equal(formatValue(3.26, "per100"), "3.3");
  assert.equal(formatValue(0, "per100"), "0");
  // components/tasks/TaskView.tsx costStat.
  assert.equal(formatValue({ kind: "estimated", perRun: 0.12 }, "taskCost"), "~$0.12");
  assert.equal(formatValue({ kind: "measured", perRun: 0.12 }, "taskCost"), "$0.12");
  assert.equal(formatValue({ kind: "measured", perRun: null }, "taskCost"), "Not priced");
  assert.equal(formatValue({ kind: "none" }, "taskCost"), "–");
  assert.equal(sortValue({ kind: "estimated", perRun: 0.12 }, "taskCost"), 0.12);
  assert.equal(sortValue({ kind: "none" }, "taskCost"), null);
});

test("intent shares read as the intent pages print them: a whole percent", () => {
  assert.equal(formatValue(0.066, "whole"), "7%");
  assert.equal(formatValue(0.066, "meter"), "7%");
  assert.equal(formatValue(0.004, "whole"), "0%");
  assert.equal(formatValue(1, "whole"), "100%");
});

test("points read as Agent health's If fixed column: whole points, a dash under one", () => {
  assert.equal(formatValue(7, "points"), "+7\u00a0pts");
  assert.equal(formatValue(0, "points"), "–");
  assert.equal(formatValue(null, "points"), "–");
  assert.equal(sortValue(7, "points"), 7);
});
