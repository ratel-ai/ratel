import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { addressLookup } from "@/lib/ingest/geo/address";
import { DEFAULT_GEO_ATTRIBUTES, type GeoAttributes } from "@/lib/ingest/geo/attributes";
import { loadReverseLookup } from "@/lib/ingest/geo/boundaries";
import { locateSpans } from "@/lib/ingest/geo/locate";
import { mmdbFixture } from "@/lib/ingest/geo/mmdb-fixture";
import { loadGeoAttributes, saveGeoAttributes } from "@/lib/ingest/geo/store";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { type PersistSpansDeps, persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import { insertEventsWithMetrics, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  recomputeTraceSummaries,
  type TraceSummaryExecutor,
} from "@/lib/synthesis/traces/summary-refresh";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ADDRESS = "8.8.8.8";
const LOOKUP = addressLookup(
  mmdbFixture({
    "8.8.8.0/24": { country: { iso_code: "US" }, subdivisions: [{ names: { en: "California" } }] },
  }),
);

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: never;

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema }) as never;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
});

after(() => client.close());

test("an address becomes codes on the trace, and is in no stored row", async () => {
  const result = await ingest(1, [
    attribute("client.address", ADDRESS),
    attribute("geo.location.lat", "37.771234"),
  ]);
  assert.ok(result.ok && result.addressed);
  assert.deepEqual(await summary(1), { geo_country: "US", geo_region: "US-CA" });
  assert.deepEqual(await rowsWith(ADDRESS), []);
  assert.deepEqual(await rowsWith("37.771234"), []);
  // The search does find what is stored.
  assert.ok((await rowsWith("US-CA")).includes("otel_trace_summaries"));
});

test("a batch that fails to be located is stored, and counts as one that carries an address", async () => {
  const result = await ingest(2, [attribute("client.address", ADDRESS)], () => {
    throw new Error("no database");
  });
  assert.ok(result.ok && result.addressed);
  assert.deepEqual(await summary(2), { geo_country: null, geo_region: null });
  assert.deepEqual(await rowsWith(ADDRESS), []);
});

test("the root's place is the trace's", async () => {
  await ingest(3, [attribute("geo.country.iso_code", "IT")], undefined, [
    attribute("geo.country.iso_code", "FR"),
  ]);
  assert.deepEqual(await summary(3), { geo_country: "IT", geo_region: null });
});

test("a project's names are its own, and the defaults without them", async () => {
  assert.deepEqual(await loadGeoAttributes(PROJECT, db), DEFAULT_GEO_ATTRIBUTES);
  const own: GeoAttributes = { ...DEFAULT_GEO_ATTRIBUTES, address: "app.ip" };
  await saveGeoAttributes(PROJECT, own, db);
  await saveGeoAttributes(PROJECT, { ...own, country: "app.country" }, db);
  assert.deepEqual(await loadGeoAttributes(PROJECT, db), { ...own, country: "app.country" });
});

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function ingest(
  trace: number,
  attributes: object[],
  lookup: typeof LOOKUP = LOOKUP,
  child: object[] = [],
) {
  const traceId = String(trace).padStart(32, "0");
  const start = Date.UTC(2026, 10, 2) * 1e6;
  const span = (id: number, more: object) => ({
    traceId,
    spanId: String(id).padStart(16, "0"),
    startTimeUnixNano: String(start + id),
    endTimeUnixNano: String(start + 1e9),
    kind: 1,
    ...more,
  });
  const body = {
    resourceSpans: [
      {
        resource: { attributes },
        scopeSpans: [
          {
            spans: [
              span(1, {
                name: "chat gpt-4o",
                attributes: [
                  ...attributes,
                  attribute("gen_ai.operation.name", "chat"),
                  attribute("gen_ai.request.model", "gpt-4o"),
                ],
                events: [{ name: "gen_ai.choice", timeUnixNano: String(start), attributes }],
              }),
              span(2, {
                name: "execute_tool search",
                parentSpanId: String(1).padStart(16, "0"),
                attributes: [
                  ...child,
                  attribute("gen_ai.operation.name", "execute_tool"),
                  attribute("gen_ai.tool.name", "search"),
                ],
              }),
            ],
          },
        ],
      },
    ],
  };
  const spans = decodeOtlp("application/json", Buffer.from(JSON.stringify(body)));
  return persistDecodedSpans(
    spans,
    { projectId: PROJECT, organization: null, quotaOrgId: null, endpoint: "/v1/traces" } as never,
    deps(lookup),
  );
}

function deps(lookup: typeof LOOKUP): PersistSpansDeps {
  return {
    insertEventsWithMetrics: (id, rows) => insertEventsWithMetrics(id, rows, db),
    insertOtelSpans: (id, rows) => insertOtelSpans(id, rows, db),
    insertTraceEvents: (id, rows) => insertTraceEvents(id, rows, db),
    agentSpanDedupe: null,
    agentRunsEnabled: async () => true,
    locate: (_id, spans) =>
      locateSpans(spans, DEFAULT_GEO_ATTRIBUTES, { address: lookup, reverse: loadReverseLookup }),
    logError: () => {},
    captureFailure: () => {},
  } satisfies Partial<PersistSpansDeps> as unknown as PersistSpansDeps;
}

async function summary(trace: number) {
  const traceId = String(trace).padStart(32, "0");
  await recomputeTraceSummaries(db as TraceSummaryExecutor, [{ projectId: PROJECT, traceId }]);
  const { rows } = await client.query(
    "select geo_country, geo_region from otel_trace_summaries where trace_id = $1",
    [traceId],
  );
  return rows[0];
}

/** The tables with a row that holds the text anywhere. */
async function rowsWith(text: string): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    "select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
  );
  const found: string[] = [];
  for (const { name } of rows) {
    const { rows: hits } = await client.query<{ n: number }>(
      `select count(*)::int as n from "${name}" t where strpos(t::text, $1) > 0`,
      [text],
    );
    if (hits[0].n > 0) found.push(name);
  }
  return found;
}
