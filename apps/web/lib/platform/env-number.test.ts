import assert from "node:assert/strict";
import { test } from "node:test";
import { envNumber } from "@/lib/platform/env-number";

test("envNumber: fallback when unset, empty, non-numeric, or rejected by the predicate", () => {
  assert.equal(envNumber("X", 7, undefined, {}), 7);
  assert.equal(envNumber("X", 7, undefined, { X: "" }), 7);
  assert.equal(envNumber("X", 7, undefined, { X: "abc" }), 7);
  assert.equal(
    envNumber("X", 7, undefined, { X: "0" }),
    7,
    "the default predicate is strictly positive",
  );
  assert.equal(envNumber("X", 7, undefined, { X: "-1" }), 7);
  assert.equal(envNumber("X", 7, undefined, { X: "Infinity" }), 7);
});

test("envNumber: accepts a valid value, honors a custom range", () => {
  assert.equal(envNumber("X", 7, undefined, { X: "3.5" }), 3.5);
  const unit = (n: number) => n >= 0 && n <= 1;
  assert.equal(envNumber("X", 0.6, unit, { X: "0" }), 0, "zero is inside the unit range");
  assert.equal(envNumber("X", 0.6, unit, { X: "0.5" }), 0.5);
  assert.equal(envNumber("X", 0.6, unit, { X: "1.5" }), 0.6);
});
