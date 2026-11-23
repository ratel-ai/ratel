import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRate } from "./format";

test("a rate per 1M tokens keeps its cents and any finer digits", () => {
  assert.equal(formatRate(2.5), "$2.50");
  assert.equal(formatRate(0.075), "$0.075");
  assert.equal(formatRate(0.006), "$0.006");
  assert.equal(formatRate(1.32), "$1.32");
  assert.equal(formatRate(0), "$0.00");
  assert.equal(formatRate(1250), "$1,250.00");
  assert.equal(formatRate(undefined), "Same as input");
});
