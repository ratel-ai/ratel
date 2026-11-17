import assert from "node:assert/strict";
import { test } from "node:test";
import { costLabel, isUnpricedCall } from "./cost-label";

/** RC-482: a call whose model has no price reads "Unpriced", never "$0.00". */

test("a model call with tokens and no cost is unpriced; a span with no model call is not", () => {
  assert.equal(
    isUnpricedCall({ model: "my-model", inputTokens: 10, outputTokens: 5, costUsd: null }),
    true,
  );
  assert.equal(
    isUnpricedCall({ model: "gpt-4o", inputTokens: 10, outputTokens: 5, costUsd: "0.0001" }),
    false,
  );
  assert.equal(
    isUnpricedCall({ model: null, inputTokens: null, outputTokens: null, costUsd: null }),
    false,
  );
  assert.equal(
    isUnpricedCall({ model: "gpt-4o", inputTokens: null, outputTokens: null, costUsd: null }),
    false,
  );
});

test("a cost reads Unpriced when nothing in it was priced, and says so when part was", () => {
  assert.equal(costLabel(0, 0), "$0.00");
  assert.equal(costLabel(0, 3), "Unpriced");
  assert.equal(costLabel(1.2, 0), "$1.20");
  assert.equal(costLabel(1.2, 2), "$1.20 + unpriced");
});
