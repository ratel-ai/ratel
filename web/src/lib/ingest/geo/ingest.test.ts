import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GEO_ATTRIBUTES } from "@/lib/ingest/geo/attributes";
import { createGeoIngest, type GeoIngestDeps } from "@/lib/ingest/geo/ingest";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";

const MINUTE = 60_000;

test("F445-1: five batches with the flag off ask for the flag once per organization, for five minutes", async () => {
  const { locate, asked, clock } = setup({ enabled: false });
  for (let batch = 0; batch < 5; batch++)
    assert.deepEqual(await locate("p", { id: "org-a" }, [span()]), { addressed: false });
  // Batches at one time, and the organization's other projects, share the decision.
  await Promise.all([locate("p", "org-b", []), locate("q", "org-b", [])]);
  assert.deepEqual(asked, ["org-a", "org-b"]);
  clock.now += 5 * MINUTE - 1;
  await locate("p", "org-a", []);
  assert.equal(asked.length, 2);
  clock.now += 1;
  await locate("p", "org-a", []);
  assert.deepEqual(asked, ["org-a", "org-b", "org-a"]);
});

test("the decision of one organization is not another's", async () => {
  const { locate } = setup({ enabled: (organizationId) => organizationId === "on" });
  const address = { "client.address": "8.8.8.8" };
  assert.deepEqual(await locate("p", "off", [span(address)]), { addressed: false });
  assert.deepEqual(await locate("q", "on", [span(address)]), { addressed: true });
  assert.deepEqual(await locate("r", null, [span(address)]), { addressed: false });
});

function span(attributes: DecodedSpan["attributes"] = {}): DecodedSpan {
  return { attributes, resourceAttributes: {} } as DecodedSpan;
}

function setup(options: { enabled: boolean | ((organizationId?: string) => boolean) }) {
  const asked: (string | undefined)[] = [];
  const clock = { now: 0 };
  const deps: GeoIngestDeps = {
    enabled: async ({ organizationId }) => {
      asked.push(organizationId);
      return typeof options.enabled === "function"
        ? options.enabled(organizationId)
        : options.enabled;
    },
    attributes: async () => DEFAULT_GEO_ATTRIBUTES,
    address: async () => null,
    now: () => clock.now,
  };
  return { ...createGeoIngest(deps), asked, clock };
}
