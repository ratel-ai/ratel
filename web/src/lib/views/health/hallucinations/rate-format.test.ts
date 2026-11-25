import assert from "node:assert/strict";
import { test } from "node:test";
import { formatHallucinationRate } from "@/components/console/hallucinations/copy";

test("a hallucination rate reads to one decimal under 10%, never rounds a few to nothing, and says None unread", () => {
  assert.equal(formatHallucinationRate(null), "None");
  assert.equal(formatHallucinationRate(0), "0%");
  assert.equal(formatHallucinationRate(0.0004), "<0.1%");
  assert.equal(formatHallucinationRate(0.011), "1.1%");
  assert.equal(formatHallucinationRate(0.099), "9.9%");
  assert.equal(formatHallucinationRate(0.42), "42%");
});
