import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents, type TraceDb } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { listIntentGraphRuntimeStatus } from "@/lib/readings/intent-graph/queries";

/**
 * RC-590: what a shippable (ingest-only) key sends is kept, and changes
 * nothing else. Against real Postgres: an append-only batch never replaces or
 * deletes a stored row, never opens its source's facts era, and never writes
 * the latest-wins ranking status. The same batch without the option does all
 * of those, which is what makes the comparison mean something.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TS = Date.parse("2026-11-01T00:00:00Z");

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');`,
  );
  return {
    client,
    db: drizzle(client, { schema }) as unknown as TraceDb & Parameters<typeof insertTraceEvents>[2],
  };
}

function fact(body: Record<string, unknown>) {
  const { valid, rejected } = parseTraceEvents([
    { v: 2, ts: TS, session_id: "sess-1", source_id: "worker-a", ...body },
  ]);
  assert.equal(rejected.length, 0);
  return { ...valid[0], ingestSource: "runtime" as const };
}

/** The customer's own OTLP-derived row for an event the attacker learned the id of. */
function storedOtlpRow(eventId: string) {
  const runtime = fact({
    type: "search",
    query: "the customer's real query",
    hits: [],
    event_id: eventId,
  });
  return { ...runtime, ingestSource: "otlp" as const, clientEventId: eventId };
}

test("an append-only fact never replaces a stored row with the same event id", async () => {
  const { client, db } = await setup();
  await insertTraceEvents(PROJECT_ID, [storedOtlpRow("evt-known")], db);

  const forged = fact({ type: "search", query: "forged", hits: [], event_id: "evt-known" });
  assert.deepEqual(await insertTraceEvents(PROJECT_ID, [forged], db, { appendOnly: true }), {
    accepted: 0,
  });

  const rows = await client.query<{ ingest_source: string; query: string }>(
    `select ingest_source, query from trace_events`,
  );
  assert.deepEqual(rows.rows, [{ ingest_source: "otlp", query: "the customer's real query" }]);
});

test("an append-only fact never deletes another row that shares its event id", async () => {
  const { client, db } = await setup();
  await insertTraceEvents(
    PROJECT_ID,
    [{ ...storedOtlpRow("evt-shared"), clientEventId: "otlp-projection" }],
    db,
  );

  const forged = fact({ type: "search", query: "forged", hits: [], event_id: "evt-shared" });
  await insertTraceEvents(PROJECT_ID, [forged], db, { appendOnly: true });

  const rows = await client.query<{ client_event_id: string }>(
    `select client_event_id from trace_events order by client_event_id`,
  );
  assert.deepEqual(
    rows.rows.map((row) => row.client_event_id),
    ["evt-shared", "otlp-projection"],
    "the customer's row stays; the new fact is only added",
  );
});

test("an append-only fact never opens a facts era, so the source's later OTLP rows still land", async () => {
  const { client, db } = await setup();
  await insertTraceEvents(PROJECT_ID, [fact({ type: "future_event", event_id: "evt-era" })], db, {
    appendOnly: true,
  });

  const sources = await client.query(
    `select 1 from runtime_event_sources where source_id = 'worker-a'`,
  );
  assert.equal(sources.rows.length, 0);

  const later = { ...storedOtlpRow("evt-later"), occurredAt: new Date(Date.now() + 60_000) };
  assert.deepEqual(await insertTraceEvents(PROJECT_ID, [later], db), { accepted: 1 });
});

test("without append-only the same fact does open the era (the comparison the tests above rest on)", async () => {
  const { client, db } = await setup();
  await insertTraceEvents(PROJECT_ID, [fact({ type: "future_event", event_id: "evt-era-on" })], db);
  const sources = await client.query(
    `select 1 from runtime_event_sources where source_id = 'worker-a'`,
  );
  assert.equal(sources.rows.length, 1);
});

test("an append-only status event is stored but never written to the ranking status", async () => {
  const { client, db } = await setup();
  const status = fact({
    type: "usage_ranking_status",
    status: "inactive",
    reason: "disabled",
    event_id: "evt-status",
  });
  assert.deepEqual(
    await insertTraceEvents(PROJECT_ID, [status], db, {
      appendOnly: true,
      intentGraphRuntimeStatus: true,
    }),
    { accepted: 1 },
  );
  assert.deepEqual(await listIntentGraphRuntimeStatus(PROJECT_ID, db as never), []);
  const stored = await client.query(
    `select 1 from trace_events where type = 'usage_ranking_status'`,
  );
  assert.equal(stored.rows.length, 1);
});

test("an append-only batch still stores its new events", async () => {
  const { client, db } = await setup();
  const batch = [
    fact({ type: "search", query: "a", hits: [], event_id: "evt-a" }),
    fact({ type: "search", query: "b", hits: [], event_id: "evt-b" }),
  ];
  assert.deepEqual(await insertTraceEvents(PROJECT_ID, batch, db, { appendOnly: true }), {
    accepted: 2,
  });
  const rows = await client.query(`select 1 from trace_events`);
  assert.equal(rows.rows.length, 2);
});
