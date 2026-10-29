import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEMO_RUNTIME_TOOLS,
  demoRuntimeCatalogEntries,
} from "@/lib/console/seed/demo-runtime-catalog";
import { DEMO_TOOLS } from "@/lib/console/seed/demo-tools";
import { getRetrievalDescriptionAdoption } from "@/lib/ingest/runtime-catalog/adoption";

const PROJECT = "11111111-1111-4111-8111-111111111111";

test("the demo catalog spills past a page, so pagination is exercised", () => {
  const entries = demoRuntimeCatalogEntries(PROJECT);

  assert.ok(entries.length > 75, `expected a catalog worth paginating, got ${entries.length}`);
});

test("described demo tools become managed; undescribed ones stay observed", () => {
  const entries = demoRuntimeCatalogEntries(PROJECT);
  const names = new Set(entries.map((entry) => entry.name));
  const undescribed = DEMO_TOOLS.filter((tool) => tool.description === undefined);

  assert.ok(undescribed.length > 0, "the fixture keeps an observed-only case");
  for (const tool of undescribed) {
    assert.equal(
      names.has(tool.name),
      false,
      `${tool.name} has no definition, so it must not become managed`,
    );
  }
  for (const tool of DEMO_TOOLS.filter((t) => t.description !== undefined)) {
    assert.equal(names.has(tool.name), true, `${tool.name} should be managed`);
  }
});

test("every entry is a valid runtime catalog row", () => {
  for (const entry of demoRuntimeCatalogEntries(PROJECT)) {
    assert.equal(entry.projectId, PROJECT);
    assert.equal(entry.kind, "tool");
    assert.equal(entry.entryId, entry.name);
    assert.ok(entry.description.length > 0, `${entry.name} needs a description`);
    assert.ok(entry.searchableDescription.length > 0);
    assert.match(
      entry.contentHash,
      /^[a-f0-9]{64}$/,
      `${entry.name} needs an ingest-shaped content hash`,
    );
  }
});

test("content hashes are unique, so no two entries look like the same content", () => {
  const entries = demoRuntimeCatalogEntries(PROJECT);
  const hashes = new Set(entries.map((entry) => entry.contentHash));

  assert.equal(hashes.size, entries.length);
});

test("entry ids are unique, so the upsert cannot collide with itself", () => {
  const entries = demoRuntimeCatalogEntries(PROJECT);
  const ids = new Set(entries.map((entry) => entry.entryId));

  assert.equal(ids.size, entries.length);
});

test("the catalog covers all three adoption states the modal renders", () => {
  const entries = demoRuntimeCatalogEntries(PROJECT);
  const states = entries.map((entry) =>
    getRetrievalDescriptionAdoption({
      searchableDescription: entry.searchableDescription,
      searchableDescriptionOverride: entry.searchableDescriptionOverride ?? null,
      useCloudDefinitions: entry.useCloudDefinitions,
    }),
  );

  for (const state of ["runtime-owned", "in-sync", "pending-adoption"] as const) {
    assert.ok(states.includes(state), `no demo tool exercises the "${state}" state`);
  }
});

test("both description states are present: identical and diverged", () => {
  const entries = demoRuntimeCatalogEntries(PROJECT);
  const identical = entries.filter((entry) => entry.searchableDescription === entry.description);
  const diverged = entries.filter((entry) => entry.searchableDescription !== entry.description);

  assert.ok(identical.length > 0, "the ingest default must be represented");
  assert.ok(diverged.length > 0, "the diff view needs something to diff");
});

test("searchableDescriptionOverridden tracks the runtime, not the Cloud override", () => {
  for (const entry of demoRuntimeCatalogEntries(PROJECT)) {
    assert.equal(
      entry.searchableDescriptionOverridden,
      entry.searchableDescription !== entry.description,
      `${entry.name} misreports who changed the retrieval text`,
    );
  }
});

test("a good share of entries carry an input schema for the collapsed panel", () => {
  const entries = demoRuntimeCatalogEntries(PROJECT);
  const withSchema = entries.filter((entry) => entry.inputSchema !== null);

  assert.ok(withSchema.length > 20, `only ${withSchema.length} carry a schema`);
});

test("runtime-only tools are named densely enough to collide", () => {
  // Retrieval is only interesting when several entries are plausible answers to
  // the same question; a catalog of well-separated names makes it look easy.
  const prefixes = new Map<string, number>();
  for (const tool of DEMO_RUNTIME_TOOLS) {
    const prefix = tool.name.split("_")[0];
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }

  const crowded = [...prefixes.values()].filter((count) => count >= 5);
  assert.ok(crowded.length >= 4, "several namespaces should overlap heavily");
});

test("seeding is deterministic, so re-running does not churn content hashes", () => {
  const first = demoRuntimeCatalogEntries(PROJECT, new Date("2026-08-25T00:00:00Z"));
  const second = demoRuntimeCatalogEntries(PROJECT, new Date("2026-08-26T00:00:00Z"));

  assert.deepEqual(
    first.map((entry) => entry.contentHash),
    second.map((entry) => entry.contentHash),
  );
});
