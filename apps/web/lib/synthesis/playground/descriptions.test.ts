import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasOwnSearchableDescription,
  resolveSearchableDescription,
  searchableDescriptionSource,
  searchableMatchesAgentDescription,
} from "./descriptions";

/**
 * The precedence retrieval uses, pinned.
 *
 * This is a four-line function guarding a product rule that is invisible in
 * most projects — ingest copies `description` into `searchable_description`, so
 * the two are usually the same string and getting the order wrong looks like it
 * works. These tests are the only thing standing between that and a Playground
 * that silently scores the wrong text again.
 */

test("an operator override outranks the runtime's own retrieval text", () => {
  const tool = {
    description: "Agent-facing prose.",
    searchableDescription: "Runtime retrieval prose.",
    searchableDescriptionOverride: "Ratel retrieval prose.",
  };
  assert.equal(resolveSearchableDescription(tool), "Ratel retrieval prose.");
  assert.equal(searchableDescriptionSource(tool), "override");
});

test("the runtime's retrieval text is used when no override is set", () => {
  const tool = {
    description: "Agent-facing prose.",
    searchableDescription: "Runtime retrieval prose.",
    searchableDescriptionOverride: null,
  };
  assert.equal(resolveSearchableDescription(tool), "Runtime retrieval prose.");
  assert.equal(searchableDescriptionSource(tool), "runtime");
  assert.equal(hasOwnSearchableDescription(tool), true);
});

test("with no retrieval text at all, retrieval reads the description", () => {
  const tool = {
    description: "Agent-facing prose.",
    searchableDescription: null,
    searchableDescriptionOverride: null,
  };
  assert.equal(resolveSearchableDescription(tool), "Agent-facing prose.");
  assert.equal(searchableDescriptionSource(tool), "description");
  assert.equal(hasOwnSearchableDescription(tool), false);
});

test("an empty override is a real choice, not an absent one", () => {
  // `searchable_description_override` is nullable, so "" is a deliberate
  // operator decision to match on nothing. Falling back to the description here
  // would quietly re-enable a capability someone switched off.
  const tool = {
    description: "Agent-facing prose.",
    searchableDescription: "Runtime retrieval prose.",
    searchableDescriptionOverride: "",
  };
  assert.equal(resolveSearchableDescription(tool), "");
  assert.equal(searchableDescriptionSource(tool), "override");
});

test("identical texts are recognized as one description, whitespace aside", () => {
  assert.equal(
    searchableMatchesAgentDescription({
      description: "Same prose.",
      searchableDescription: "Same prose.\n",
    }),
    true,
  );
  assert.equal(
    searchableMatchesAgentDescription({
      description: "Same prose.",
      searchableDescription: "Different prose.",
    }),
    false,
  );
});

test("a capability with only a description is described by it", () => {
  const skill = { description: "Only prose." };
  assert.equal(resolveSearchableDescription(skill), "Only prose.");
  assert.equal(searchableMatchesAgentDescription(skill), true);
});
