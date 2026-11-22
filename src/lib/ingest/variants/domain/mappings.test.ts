import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseVariantMapping,
  resolveSpanVariant,
  type VariantMapping,
} from "@/lib/ingest/variants/domain/mappings";

const MAPPINGS: VariantMapping[] = [{ attributeKey: "app.variant", experiment: "checkout-model" }];

test("a mapped key with no ratel.variant.* tag gives the mapped experiment and the value as the name", () => {
  assert.deepEqual(resolveSpanVariant({ "app.variant": "b" }, MAPPINGS), {
    experiment: "checkout-model",
    name: "b",
    descriptors: {},
  });
});

test("an explicit ratel.variant.name wins over the mapping", () => {
  assert.deepEqual(
    resolveSpanVariant(
      { "app.variant": "b", "ratel.variant.experiment": "x", "ratel.variant.name": "a" },
      MAPPINGS,
    ),
    { experiment: "x", name: "a", descriptors: {} },
  );
});

test("a mapping fills the name of a span tagged with descriptors only, and keeps them", () => {
  assert.deepEqual(resolveSpanVariant({ "app.variant": 2, "ratel.variant.model": "m" }, MAPPINGS), {
    experiment: "checkout-model",
    name: "2",
    descriptors: { model: "m" },
  });
});

test("an unmapped key, or a blank mapped value, gives no variant", () => {
  assert.equal(resolveSpanVariant({ "other.variant": "b" }, MAPPINGS), null);
  assert.equal(resolveSpanVariant({ "app.variant": " " }, MAPPINGS), null);
});

test("the first mapping with a value wins", () => {
  const mappings = [
    { attributeKey: "a.v", experiment: "one" },
    { attributeKey: "b.v", experiment: "two" },
  ];
  assert.equal(resolveSpanVariant({ "b.v": "y", "a.v": "x" }, mappings)?.experiment, "one");
});

test("parseVariantMapping trims both fields and refuses blanks, long values and ratel keys", () => {
  assert.deepEqual(
    parseVariantMapping({ attributeKey: " app.variant ", experiment: " checkout-model " }),
    {
      ok: true,
      mapping: { attributeKey: "app.variant", experiment: "checkout-model" },
    },
  );
  assert.equal(parseVariantMapping({ attributeKey: "", experiment: "x" }).ok, false);
  assert.equal(parseVariantMapping({ attributeKey: "a", experiment: "  " }).ok, false);
  assert.equal(parseVariantMapping({ attributeKey: "a".repeat(257), experiment: "x" }).ok, false);
  assert.equal(
    parseVariantMapping({ attributeKey: "ratel.variant.name", experiment: "x" }).ok,
    false,
  );
  assert.equal(parseVariantMapping({ attributeKey: 3, experiment: "x" }).ok, false);
});
