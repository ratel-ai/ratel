import assert from "node:assert/strict";
import { test } from "node:test";
import { inSample } from "./sample";

const ids = Array.from({ length: 4000 }, (_, n) => n.toString(16).padStart(32, "0"));

test("the sample is about the rate, stable, and grows with the rate", () => {
  for (const rate of [1, 10, 50, 90]) {
    const taken = ids.filter((id) => inSample("scorer", id, rate));
    assert.ok(Math.abs(taken.length / ids.length - rate / 100) < 0.03, `${rate}: ${taken.length}`);
    assert.deepEqual(
      taken,
      ids.filter((id) => inSample("scorer", id, rate)),
    );
    assert.ok(taken.every((id) => inSample("scorer", id, rate + 5)));
  }
  assert.ok(ids.every((id) => inSample("scorer", id, 100)));
});

test("two scorers take different samples", () => {
  const sampleOf = (scorer: string) => ids.filter((id) => inSample(scorer, id, 50)).join();
  assert.notEqual(sampleOf("a"), sampleOf("b"));
});
