import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPricingRows, parseModelPrice } from "./settings";

/** RC-482: the Model pricing table and what a person may save. */

test("the table lists the project's models, unpriced first, with the price each pays", () => {
  const rows = modelPricingRows(
    [
      { model: "gpt-4o-2024-08-06", calls: 40, unpricedCalls: 40 },
      { model: "claude-sonnet-5-5", calls: 12, unpricedCalls: 12 },
      { model: "my-own-model", calls: 3, unpricedCalls: 3 },
    ],
    { "gpt-4o": { input: 2, output: 8 }, "added-by-hand": { input: 1, output: 1 } },
  );
  assert.deepEqual(
    rows.map((row) => [row.model, row.source, row.price?.input ?? null, row.customModel]),
    [
      ["my-own-model", "unpriced", null, null],
      // A dated id pays the price set for its model.
      ["gpt-4o-2024-08-06", "custom", 2, "gpt-4o"],
      ["claude-sonnet-5-5", "built-in", 2, null],
      // A model priced by hand that no call used yet.
      ["added-by-hand", "custom", 1, "added-by-hand"],
    ],
  );
  assert.deepEqual(rows.find((row) => row.model === "gpt-4o-2024-08-06")?.builtIn, {
    input: 2.5,
    output: 10,
    cachedInput: 1.25,
  });
});

test("a built-in price with a long-context tier says where it starts", () => {
  const [row] = modelPricingRows([{ model: "claude-haiku-5-5", calls: 1, unpricedCalls: 0 }], {});
  assert.equal(row.longContextOver, 100_000);
});

test("a saved price needs a model and input and output rates; cache rates are optional", () => {
  assert.deepEqual(
    parseModelPrice({
      model: " gpt-4o ",
      input: "2.5",
      output: "10",
      cachedInput: "",
      cacheWrite: "",
    }),
    {
      ok: true,
      model: "gpt-4o",
      price: { input: 2.5, output: 10 },
    },
  );
  assert.deepEqual(
    parseModelPrice({ model: "m", input: 1, output: 2, cachedInput: 0.5, cacheWrite: 1.25 }),
    {
      ok: true,
      model: "m",
      price: { input: 1, output: 2, cachedInput: 0.5, cacheWrite: 1.25 },
    },
  );
  assert.deepEqual(parseModelPrice({ model: "", input: 1, output: 1 }), {
    ok: false,
    field: "model",
    error: "Enter the model id your calls report.",
  });
  assert.deepEqual(parseModelPrice({ model: "m", input: "", output: 1 }), {
    ok: false,
    field: "input",
    error: "Enter a price of 0 or more.",
  });
  assert.deepEqual(parseModelPrice({ model: "m", input: 1, output: -1 }), {
    ok: false,
    field: "output",
    error: "Enter a price of 0 or more.",
  });
  assert.deepEqual(parseModelPrice({ model: "m", input: 1, output: 1, cachedInput: "abc" }), {
    ok: false,
    field: "cachedInput",
    error: "Enter a price of 0 or more.",
  });
  assert.deepEqual(parseModelPrice({ model: "m", input: 1_000_001, output: 1 }), {
    ok: false,
    field: "input",
    error: "Enter a price under $1,000,000 per 1M tokens.",
  });
  assert.equal(parseModelPrice({ model: "x".repeat(201), input: 1, output: 1 }).ok, false);
});
