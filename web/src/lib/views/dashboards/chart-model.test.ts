import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMetric } from "./chart-model";

test("a number of an RQL column keeps the digits of a small value", () => {
  assert.equal(formatMetric(0.12, "number"), "0.12");
  assert.equal(formatMetric(0.04, "number"), "0.04");
  assert.equal(formatMetric(0.123456, "number"), "0.1235");
  assert.equal(formatMetric(2.236, "number"), "2.24");
  assert.equal(formatMetric(9412.2612, "number"), "9,412.26");
  assert.equal(formatMetric(12_400, "number"), "12.4K");
  assert.equal(formatMetric(0, "number"), "0");
  // A count stays whole.
  assert.equal(formatMetric(3, "count"), "3");
});
