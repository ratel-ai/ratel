import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getTraceFacets, type TraceQueriesDb } from "@/lib/synthesis/traces/queries";
import { toOtelSpanRows } from "./span-rows";
import type { DecodedSpan } from "./types";

/** The resource environment reaches the traces facet. */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type TestDb = TraceQueriesDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

const SPAN: DecodedSpan = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  parentSpanId: null,
  name: "chat",
  kind: 3,
  startUnixMs: 1_750_000_000_125,
  endUnixMs: 1_750_000_000_250,
  attributes: {},
  events: [],
  statusCode: 1,
  resourceAttributes: { "service.name": "agent", "deployment.environment.name": "prod" },
  scopeName: "agent",
};

async function facets() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  await insertOtelSpans(PROJECT_ID, toOtelSpanRows(PROJECT_ID, [SPAN]), db);
  const facets = await getTraceFacets(PROJECT_ID, {}, db);
  await client.close();
  return facets;
}

test("the environment facet returns the resource's deployment.environment.name", async () => {
  assert.deepEqual((await facets()).environment, [{ value: "prod", count: 1 }]);
});
