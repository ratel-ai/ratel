import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalEntries,
  fingerprintOf,
  inventoryOf,
} from "@/lib/ingest/runtime-catalog/inventory";
import type { FingerprintSourceRow } from "@/lib/synthesis/quality/fingerprint";

function row(overrides: Partial<FingerprintSourceRow> & { entryId: string }): FingerprintSourceRow {
  return {
    kind: "tool",
    name: overrides.entryId,
    description: "does a thing",
    searchableDescription: null,
    searchableDescriptionOverride: null,
    ...overrides,
  };
}

test("fingerprintOf is stable under input ordering", () => {
  const a = { kind: "tool", entryId: "a", name: "a", searchable: "alpha" };
  const b = { kind: "tool", entryId: "b", name: "b", searchable: "beta" };

  assert.equal(fingerprintOf([a, b]), fingerprintOf([b, a]));
});

test("fingerprintOf ignores re-wrapping but not rewording", () => {
  const wrapped = [{ kind: "tool", entryId: "a", name: "a", searchable: "unlink   two\n tasks" }];
  const flat = [{ kind: "tool", entryId: "a", name: "a", searchable: "unlink two tasks" }];
  const reworded = [{ kind: "tool", entryId: "a", name: "a", searchable: "unlink two task" }];

  assert.equal(fingerprintOf(wrapped), fingerprintOf(flat));
  assert.notEqual(fingerprintOf(flat), fingerprintOf(reworded));
});

test("fingerprintOf cannot be forged by moving text across fields", () => {
  const split = [{ kind: "tool", entryId: "a", name: "b", searchable: "c" }];
  const merged = [{ kind: "tool", entryId: "ab", name: "", searchable: "c" }];

  assert.notEqual(fingerprintOf(split), fingerprintOf(merged));
});

test("fingerprintOf distinguishes a corpus that gained an entry", () => {
  const one = [{ kind: "tool", entryId: "a", name: "a", searchable: "alpha" }];
  const two = [...one, { kind: "tool", entryId: "b", name: "b", searchable: "beta" }];

  assert.notEqual(fingerprintOf(one), fingerprintOf(two));
});

test("canonicalEntries sorts by kind then id and normalizes whitespace", () => {
  const canonical = canonicalEntries([
    { kind: "tool", entryId: "b", name: "b", searchable: " beta  text " },
    { kind: "skill", entryId: "z", name: "z", searchable: "zeta" },
    { kind: "tool", entryId: "a", name: "a", searchable: "alpha" },
  ]);

  assert.deepEqual(
    canonical.map((entry) => `${entry.kind}:${entry.entryId}`),
    ["skill:z", "tool:a", "tool:b"],
  );
  assert.equal(canonical[2].searchable, "beta text");
});

test("inventoryOf resolves an override ahead of the runtime's own text", () => {
  const inventory = inventoryOf([
    row({
      entryId: "delete_task_relationship",
      description: "removes an edge",
      searchableDescription: "remove a link between tasks",
      searchableDescriptionOverride: "unlink tasks",
    }),
  ]);

  assert.equal(inventory.entries[0].searchable, "unlink tasks");
  assert.equal(inventory.overriddenCount, 1);
  assert.equal(inventory.distinctCount, 1);
  assert.equal(inventory.searchableChars, "unlink tasks".length);
});

test("inventoryOf counts an entry with no separate searchable text as not distinct", () => {
  const inventory = inventoryOf([
    row({ entryId: "a", description: "does a thing" }),
    row({
      entryId: "b",
      description: "does a thing",
      // Ingest copies description into searchable_description by default, so
      // "present but identical" is the common case and must not read as
      // customised.
      searchableDescription: "does a thing",
    }),
  ]);

  assert.equal(inventory.entryCount, 2);
  assert.equal(inventory.distinctCount, 0);
  assert.equal(inventory.overriddenCount, 0);
});

test("an override that restates the description still counts as overridden", () => {
  // The operator took ownership of the field even though the text matches, and
  // the adoption question is "who owns this", not "did the bytes change".
  const inventory = inventoryOf([
    row({
      entryId: "a",
      description: "does a thing",
      searchableDescriptionOverride: "does a thing",
    }),
  ]);

  assert.equal(inventory.overriddenCount, 1);
  assert.equal(inventory.distinctCount, 0);
});

test("changing an override changes the fingerprint", () => {
  const before = inventoryOf([row({ entryId: "a", description: "removes an edge" })]);
  const after = inventoryOf([
    row({
      entryId: "a",
      description: "removes an edge",
      searchableDescriptionOverride: "unlink tasks",
    }),
  ]);

  assert.notEqual(before.fingerprint, after.fingerprint);
});

test("an empty corpus still fingerprints, and reports zeroes", () => {
  const inventory = inventoryOf([]);
  assert.equal(inventory.entryCount, 0);
  assert.equal(inventory.searchableChars, 0);
  assert.equal(inventory.fingerprint.length, 64);
});
