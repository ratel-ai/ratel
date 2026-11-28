import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GEO_ATTRIBUTES } from "@/lib/ingest/geo/attributes";
import { createGeoIngest, type GeoIngestDeps } from "@/lib/ingest/geo/ingest";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";

const MINUTE = 60_000;

test("every batch is located, and a span with an address says so", async () => {
  const { locate } = setup();
  const address = { "client.address": "8.8.8.8" };
  assert.deepEqual(await locate("p", [span(address)]), { addressed: true });
  assert.deepEqual(await locate("q", [span()]), { addressed: false });
});

test("a project's attribute names are read once a minute", async () => {
  const { locate, read, clock } = setup();
  for (let batch = 0; batch < 5; batch++) await locate("p", [span()]);
  await locate("q", [span()]);
  assert.deepEqual(read, ["p", "q"]);
  clock.now += MINUTE - 1;
  await locate("p", [span()]);
  assert.equal(read.length, 2);
  clock.now += 1;
  await locate("p", [span()]);
  assert.deepEqual(read, ["p", "q", "p"]);
});

function span(attributes: DecodedSpan["attributes"] = {}): DecodedSpan {
  return { attributes, resourceAttributes: {} } as DecodedSpan;
}

function setup() {
  const read: string[] = [];
  const clock = { now: 0 };
  const deps: GeoIngestDeps = {
    attributes: async (projectId) => {
      read.push(projectId);
      return DEFAULT_GEO_ATTRIBUTES;
    },
    address: async () => null,
    now: () => clock.now,
  };
  return { ...createGeoIngest(deps), read, clock };
}
