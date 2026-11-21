import assert from "node:assert/strict";
import { test } from "node:test";
import { oneToolPerTrace } from "@/lib/readings/trace-signals/otel-trace-shape";

test("too few tool rows say nothing", () => {
  assert.equal(
    oneToolPerTrace({ toolRows: 19, rootToolRows: 19, rootToolRowsWithSession: 0 }).verdict,
    "not_enough_data",
  );
});

test("calls that share traces with their run are fine", () => {
  const reading = oneToolPerTrace({ toolRows: 100, rootToolRows: 10, rootToolRowsWithSession: 0 });
  assert.equal(reading.verdict, "ok");
  assert.equal(reading.share, 0.1);
});

test("one call per trace with a session groups by session", () => {
  const reading = oneToolPerTrace({ toolRows: 80, rootToolRows: 80, rootToolRowsWithSession: 80 });
  assert.deepEqual(reading, { verdict: "grouped_by_session", share: 1, sessionShare: 1 });
});

test("one call per trace without a session cannot be grouped", () => {
  const reading = oneToolPerTrace({ toolRows: 80, rootToolRows: 60, rootToolRowsWithSession: 6 });
  assert.equal(reading.verdict, "ungroupable");
  assert.equal(reading.share, 0.75);
  assert.equal(reading.sessionShare, 0.1);
});

test("thresholds are options and shares stay in 0..1", () => {
  const counts = { toolRows: 10, rootToolRows: 12, rootToolRowsWithSession: 3 };
  const reading = oneToolPerTrace(counts, { minToolRows: 5, minShare: 0.9, minSessionShare: 0.2 });
  assert.deepEqual(reading, { verdict: "grouped_by_session", share: 1, sessionShare: 0.25 });
});
