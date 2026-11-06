import assert from "node:assert/strict";
import { test } from "node:test";
import { getRetrievalDescriptionAdoption } from "./adoption";

test("retrieval description adoption follows runtime ownership and opt-in reports", () => {
  assert.equal(
    getRetrievalDescriptionAdoption({
      searchableDescription: "runtime text",
      searchableDescriptionOverride: null,
      useCloudDefinitions: true,
    }),
    "runtime-owned",
  );
  assert.equal(
    getRetrievalDescriptionAdoption({
      searchableDescription: "cloud text",
      searchableDescriptionOverride: "cloud text",
      useCloudDefinitions: true,
    }),
    "in-sync",
  );
  assert.equal(
    getRetrievalDescriptionAdoption({
      searchableDescription: "runtime text",
      searchableDescriptionOverride: "cloud text",
      useCloudDefinitions: true,
    }),
    "pending-adoption",
  );
});

test("a missing or false opt-in report degrades to pending adoption", () => {
  for (const useCloudDefinitions of [undefined, null, false]) {
    assert.equal(
      getRetrievalDescriptionAdoption({
        searchableDescription: "cloud text",
        searchableDescriptionOverride: "cloud text",
        useCloudDefinitions,
      }),
      "pending-adoption",
    );
  }
});

test("an explicit empty override still requires adoption", () => {
  assert.equal(
    getRetrievalDescriptionAdoption({
      searchableDescription: "",
      searchableDescriptionOverride: "",
      useCloudDefinitions: true,
    }),
    "in-sync",
  );
});
