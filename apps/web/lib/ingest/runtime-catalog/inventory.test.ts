import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalEntries, fingerprintOf, type InventorySourceRow, inventoryOf } from "./inventory";

const ROWS = [
  { kind: "tool", entryId: "b", name: "B", searchable: "  beta   tool " },
  { kind: "tool", entryId: "a", name: "A", searchable: "alpha tool" },
  { kind: "skill", entryId: "s", name: "S", searchable: "skill" },
];

test("the fingerprint is pinned, and stable under ordering and re-wrapping", () => {
  // The value upstream's quality fingerprint gives these three entries.
  const pinned = "7490136c8f6545a7d92d47c61926db666c638930f7d9f7803374768c99375e61";
  assert.equal(fingerprintOf(ROWS), pinned);
  assert.equal(fingerprintOf([...ROWS].reverse()), pinned);
  assert.equal(
    fingerprintOf(ROWS.map((r) => ({ ...r, searchable: r.searchable.replace(/ +/g, "\n ") }))),
    pinned,
  );
  assert.notEqual(
    fingerprintOf(ROWS.map((r) => ({ ...r, searchable: `${r.searchable}!` }))),
    pinned,
  );
  assert.deepEqual(
    canonicalEntries(ROWS).map((e) => `${e.kind}/${e.entryId}:${e.searchable}`),
    ["skill/s:skill", "tool/a:alpha tool", "tool/b:beta tool"],
  );
});

test("the inventory resolves the searchable text in the runtime's precedence and counts overrides", () => {
  const rows: InventorySourceRow[] = [
    {
      kind: "tool",
      entryId: "plain",
      name: "Plain",
      description: "Plain tool",
      searchableDescription: null,
      searchableDescriptionOverride: null,
    },
    {
      kind: "tool",
      entryId: "runtime",
      name: "Runtime",
      description: "Runtime tool",
      searchableDescription: "find runtime",
      searchableDescriptionOverride: null,
    },
    {
      kind: "tool",
      entryId: "over",
      name: "Over",
      description: "Over tool",
      searchableDescription: "find over",
      searchableDescriptionOverride: "OVERRIDE",
    },
    {
      kind: "tool",
      entryId: "same",
      name: "Same",
      description: "Same tool",
      searchableDescription: "Same  tool",
      searchableDescriptionOverride: null,
    },
  ];
  const inventory = inventoryOf(rows);
  assert.equal(inventory.entryCount, 4);
  assert.equal(inventory.overriddenCount, 1);
  assert.equal(
    inventory.distinctCount,
    2,
    "the override and the runtime text differ; the plain and the re-wrapped one do not",
  );
  assert.deepEqual(Object.fromEntries(inventory.entries.map((e) => [e.entryId, e.searchable])), {
    over: "OVERRIDE",
    plain: "Plain tool",
    runtime: "find runtime",
    same: "Same tool",
  });
  assert.equal(
    inventory.searchableChars,
    "OVERRIDE".length + "Plain tool".length + "find runtime".length + "Same tool".length,
  );
  assert.equal(inventory.fingerprint, fingerprintOf(inventory.entries));
});
