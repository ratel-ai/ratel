import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { refreshTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";
import { listTraceProperties, setTracePropertyState } from "./store";
import {
  CHILD,
  ingestPropertyExport,
  propertyExport,
  ROOT,
  testPropertyIngest,
} from "./test-support";

/**
 * Ingest and the summary sweep against a real schema: what a project's export leaves in
 * `trace_property_keys`, `otel_spans.properties` and `otel_trace_summaries.properties`.
 */

const TRACE = "5b8efff798038103d269b633813fc60c";
const LATER = "6c9f0008a9149214e37ac744924fd71d";

async function spanValues(client: PGlite, traceId: string) {
  const { rows } = await client.query<{ span_id: string; properties: unknown }>(
    `select span_id, properties from otel_spans where trace_id = $1 order by span_id`,
    [traceId],
  );
  return Object.fromEntries(rows.map((row) => [row.span_id, row.properties]));
}

async function summary(client: PGlite, traceId: string) {
  const { rows } = await client.query<{ properties: unknown; end_user_id: string }>(
    `select properties, end_user_id from otel_trace_summaries where trace_id = $1`,
    [traceId],
  );
  return rows[0];
}

test("ingest records every key, indexes the standard ones at first sight and stores only their values", async () => {
  const { client, db } = await setupDb();
  // No plan is read: the open-source edition and a free Cloud plan get the same.
  await ingestPropertyExport(db, propertyExport(TRACE), {
    properties: testPropertyIngest(db).capture,
  });
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  const listed = await listTraceProperties(PROJECT_ID, db);
  assert.deepEqual(
    listed.map(({ name, state, source, column }) => [name, state, source, column]).sort(),
    [
      ["app.plan", "detected", "user", null],
      ["organization", "indexed", "standard", null],
      ["release", "indexed", "standard", null],
      ["service", "indexed", "standard", "service_name"],
      ["user", "indexed", "standard", "end_user_id"],
    ],
  );
  // Each span its own value, then its ancestors', then its resource's. The user, a summary
  // column already, and app.plan, only detected, are stored nowhere here.
  assert.deepEqual(await spanValues(client, TRACE), {
    [ROOT]: { organization: "acme", release: "1.2.3" },
    [CHILD]: { organization: "other", release: "1.2.3" },
  });
  // The root wins on the trace.
  assert.deepEqual(await summary(client, TRACE), {
    properties: { organization: "acme", release: "1.2.3" },
    end_user_id: "user-7",
  });
  await client.close();
});

test("a key the user indexes gets its values from the next export on", async () => {
  const { client, db } = await setupDb();
  const ingest = testPropertyIngest(db);
  await ingestPropertyExport(db, propertyExport(TRACE), { properties: ingest.capture });
  await setTracePropertyState(PROJECT_ID, "app.plan", "indexed", db);
  await ingestPropertyExport(db, propertyExport(LATER, "team"), { properties: ingest.capture });
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  assert.deepEqual((await summary(client, TRACE))?.properties, {
    organization: "acme",
    release: "1.2.3",
  });
  assert.deepEqual((await summary(client, LATER))?.properties, {
    organization: "acme",
    release: "1.2.3",
    "app.plan": "team",
  });
  await client.close();
});

test("with customMonitoring off, ingest records no key and stores no value", async () => {
  const { client, db } = await setupDb();
  await ingestPropertyExport(db, propertyExport(TRACE), {
    properties: testPropertyIngest(db, false).capture,
  });
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  assert.deepEqual(await listTraceProperties(PROJECT_ID, db), []);
  assert.deepEqual(await spanValues(client, TRACE), { [ROOT]: null, [CHILD]: null });
  assert.deepEqual((await summary(client, TRACE))?.properties, {});
  await client.close();
});
