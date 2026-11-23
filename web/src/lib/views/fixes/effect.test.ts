import assert from "node:assert/strict";
import { test } from "node:test";
import { compactEffect, effectDirection, effectLine } from "@/lib/views/fixes/effect";

test("an effect chip becomes one compact figure and its unit", () => {
  const cases: [string, string, string][] = [
    ["3 calls → 1", "3 → 1", "calls"],
    ["2.4 calls → 1", "2.4 → 1", "calls"],
    ["−1 failed call", "−1", "failed call"],
    ["−1 call", "−1", "call"],
    ["−1 tool in every list", "−1", "tool per list"],
    ["−436 model calls total", "−436", "model calls"],
    ["−1.2 s waiting", "−1.2 s", "waiting"],
    ["−686 ms/turn waiting", "−686 ms", "waiting per turn"],
    ["−2 s waiting (−38%)", "−2 s", "waiting"],
    ["−302k tokens total", "−302k", "tokens"],
    ["−$1.19 total", "−$1.19", ""],
    ["1 step", "1", "step"],
  ];
  for (const [text, figure, unit] of cases)
    assert.deepEqual(compactEffect(text), { figure, unit }, text);
  // Words without a number stay whole.
  assert.deepEqual(compactEffect("same calls, one step"), {
    figure: "same calls, one step",
    unit: "",
  });
});

test("the line a row shows, and which way the figure goes", () => {
  assert.equal(effectLine({ figure: "3 → 1", unit: "calls" }), "3 → 1 calls");
  assert.equal(effectLine({ figure: "No change", unit: "" }), "No change");
  assert.equal(effectDirection("3 → 1"), "down");
  assert.equal(effectDirection("−1"), "down");
  assert.equal(effectDirection("+40 pts"), "up");
  assert.equal(effectDirection("No change"), null);
});
