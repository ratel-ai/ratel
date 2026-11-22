import assert from "node:assert/strict";
import { test } from "node:test";
import { variantTags } from "@/lib/ingest/variants/domain/tags";

test("reads the experiment, the name and the descriptors without their prefix", () => {
  assert.deepEqual(
    variantTags({
      "ratel.variant.experiment": "checkout-model",
      "ratel.variant.name": "b",
      "ratel.variant.model": "claude-haiku-5-5",
      "ratel.variant.prompt_version": 3,
      "gen_ai.request.model": "claude-haiku-5-5",
    }),
    {
      experiment: "checkout-model",
      name: "b",
      descriptors: { model: "claude-haiku-5-5", prompt_version: 3 },
    },
  );
});

test("a span with no ratel.variant.* key has no tags", () => {
  assert.equal(variantTags({ "ratel.experiment.id": "search-v2", "app.variant": "b" }), null);
});

test("a numeric name reads as text, and a blank or non-scalar one is absent", () => {
  assert.equal(variantTags({ "ratel.variant.name": 2 })?.name, "2");
  assert.equal(variantTags({ "ratel.variant.name": "  " })?.name, null);
  assert.equal(variantTags({ "ratel.variant.name": ["a"] })?.name, null);
});

test("descriptors only: the experiment and the name are null", () => {
  assert.deepEqual(variantTags({ "ratel.variant.model": "m" }), {
    experiment: null,
    name: null,
    descriptors: { model: "m" },
  });
});

test("the bare prefix is not a descriptor", () => {
  assert.deepEqual(
    variantTags({ "ratel.variant.": "x", "ratel.variant.name": "a" })?.descriptors,
    {},
  );
});
