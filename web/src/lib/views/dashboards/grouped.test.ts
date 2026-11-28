import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupByLabel,
  groupByOptions,
  groupLimitOf,
  groupValueLabel,
  leftOutNote,
} from "@/lib/views/dashboards/grouped";
import { NO_PROPERTIES } from "@/lib/views/dashboards/properties";

test("the Group by dropdown lists task, user, session, then the properties as the Metric form", () => {
  const options = groupByOptions({
    ...NO_PROPERTIES,
    indexed: [{ name: "plan", values: [] }],
    detected: [{ name: "tenant", source: "user" }],
  });
  assert.deepEqual(
    options.map(({ value }) => value),
    ["none", "task", "user", "session", "property:plan", "property:tenant"],
  );
  assert.equal((options.at(-1) as { detail?: string }).detail, "not indexed");
});

test("a small chart's title is its value, a task's name, or No value", () => {
  assert.equal(groupByLabel("task"), "Task");
  assert.equal(groupByLabel({ property: "plan" }), "plan");
  assert.equal(groupValueLabel("task", "w1", { w1: "Checkout" }), "Checkout");
  assert.equal(groupValueLabel("user", "w1", { w1: "Checkout" }), "w1");
  assert.equal(groupValueLabel({ property: "plan" }, null), "No value");
});

test("the values left out are said, and the count of values stays in its limits", () => {
  assert.equal(leftOutNote(0), null);
  assert.equal(leftOutNote(1), "1 more value is not shown.");
  assert.equal(leftOutNote(5), "5 more values are not shown.");
  assert.deepEqual(["0", "7", "40", "x"].map(groupLimitOf), [1, 7, 12, null]);
});
