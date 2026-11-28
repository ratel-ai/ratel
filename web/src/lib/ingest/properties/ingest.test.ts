import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttrMap, DecodedSpan } from "@/lib/ingest/otlp/types";
import { createPropertyIngest, type PropertyIngestDeps, SEEN_MS } from "./ingest";
import type { KeySighting } from "./store";

const ROOT = "1111111111111111";
const CHILD = "2222222222222222";

function span(
  spanId: string,
  attributes: AttrMap,
  parentSpanId: string | null = null,
): DecodedSpan {
  return {
    traceId: "5b8efff798038103d269b633813fc60c",
    spanId,
    parentSpanId,
    name: "work",
    kind: 1,
    startUnixMs: 1,
    endUnixMs: 2,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
  };
}

function fakes(overrides: Partial<PropertyIngestDeps> = {}) {
  const writes: KeySighting[][] = [];
  const fills: Array<[string, string[]]> = [];
  const indexed = new Set<string>();
  let now = 1_000;
  let reads = 0;
  const deps: PropertyIngestDeps = {
    enabled: async () => true,
    record: async (_projectId, sightings) => {
      writes.push(sightings);
      return sightings.map(({ name, source }) => {
        const created = !indexed.has(name);
        if (source === "standard") indexed.add(name);
        return { name, state: source === "standard" ? "indexed" : "detected", created };
      });
    },
    indexed: async () => {
      reads += 1;
      return new Set(indexed);
    },
    now: () => now,
    fill: async (projectId, names) => {
      fills.push([projectId, names]);
    },
    ...overrides,
  };
  return {
    deps,
    fills,
    writes,
    indexed,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const EXPORT = [
  span(ROOT, { "tenant.id": "acme", "app.plan": "pro", "user.id": "u-1" }),
  span(CHILD, { "app.plan": "free" }, ROOT),
];

test("an unknown key is recorded with no value; a standard key is indexed at first sight with its value", async () => {
  const { deps, writes, fills } = fakes();
  const values = await createPropertyIngest(deps).capture("p1", { id: "o1" }, EXPORT);
  // The stored traces get the standard property that has no column, once.
  assert.deepEqual(fills, [["p1", ["organization"]]]);
  assert.deepEqual(writes, [
    [
      { name: "organization", source: "standard", count: 1 },
      { name: "app.plan", source: "user", count: 2 },
      { name: "user", source: "standard", count: 1 },
    ],
  ]);
  // The user is a summary column already: it is not stored a second time.
  assert.deepEqual(Object.fromEntries(values), {
    [ROOT]: { organization: "acme" },
    [CHILD]: { organization: "acme" },
  });
});

test("an indexed key of the user's own gets its value", async () => {
  const { deps, indexed } = fakes();
  indexed.add("app.plan");
  const values = await createPropertyIngest(deps).capture("p1", null, EXPORT);
  assert.deepEqual(values.get(CHILD), { organization: "acme", "app.plan": "free" });
});

test("keys seen in the last hour are not written again, and their sightings are counted later", async () => {
  const { deps, writes, advance } = fakes();
  const ingest = createPropertyIngest(deps);
  await ingest.capture("p1", null, EXPORT);
  await ingest.capture("p1", null, EXPORT);
  assert.equal(writes.length, 1, "the second export writes nothing");
  await ingest.capture("p1", null, [span(ROOT, { "app.region": "eu", "app.plan": "x" })]);
  assert.deepEqual(writes[1], [{ name: "app.region", source: "user", count: 1 }]);
  advance(SEEN_MS);
  await ingest.capture("p1", null, [span(ROOT, { "app.plan": "x" })]);
  assert.deepEqual(writes[2], [{ name: "app.plan", source: "user", count: 4 }]);
  // Another project has its own cache.
  await ingest.capture("p2", null, [span(ROOT, { "app.plan": "x" })]);
  assert.deepEqual(writes[3], [{ name: "app.plan", source: "user", count: 1 }]);
});

test("the indexed names are read once a minute per project", async () => {
  const { deps, reads, advance } = fakes();
  const ingest = createPropertyIngest(deps);
  await ingest.capture("p1", null, EXPORT);
  await ingest.capture("p1", null, EXPORT);
  assert.equal(reads(), 1);
  advance(60_000);
  await ingest.capture("p1", null, EXPORT);
  assert.equal(reads(), 2);
});

test("with customMonitoring off, ingest records nothing and stores no value", async () => {
  const { deps, writes, reads } = fakes({ enabled: async () => false });
  const values = await createPropertyIngest(deps).capture("p1", { id: "o1" }, EXPORT);
  assert.equal(values.size, 0);
  assert.equal(writes.length, 0);
  assert.equal(reads(), 0);
});
