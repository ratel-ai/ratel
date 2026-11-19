import assert from "node:assert/strict";
import { test } from "node:test";
import { composition } from "@/lib/composition/ports";
import { productName, productSlug } from "./product-name";

test("without an edition's name, the copy keeps its neutral words", () => {
  assert.equal(composition.productName, undefined);
  assert.equal(productName(), "Ratel");
  assert.equal(productSlug(), "ratel");
});

test("an edition's name: the full one and its slug", (t) => {
  composition.productName = { full: "Ratel Cloud", short: "Cloud" };
  t.after(() => {
    composition.productName = undefined;
  });
  assert.equal(productName(), "Ratel Cloud");
  assert.equal(productSlug(), "ratel-cloud");
});
