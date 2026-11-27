import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { setTracePropertyState } from "@/lib/ingest/properties/store";
import {
  CHILD,
  ingestPropertyExport,
  propertyExport,
  ROOT,
  testPropertyIngest,
} from "@/lib/ingest/properties/test-support";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { backfillTraceProperties, propertyBackfillOptionsFromArgs } from "./property-backfill";
import { erasePropertyValues } from "./property-values";
import { refreshTraceSummaries } from "./summary-refresh";

/**
 * The fill of stored traces from the raw store, and the erase, against a real schema: a key of
 * the user's own that ingest only detected becomes indexed, and the traces stored before get its
 * values, as ingest would have stored them.
 */

const TRACE = "5b8efff798038103d269b633813fc60c";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_TRACE = "7d0a1119b0250325f48bd855a52ee82e";

async function snapshot(client: PGlite) {
  const spans = await client.query(
    `select project_id, span_id, properties, received_at from otel_spans order by project_id, span_id`,
  );
  const summaries = await client.query(
    `select project_id, trace_id, properties, updated_at from otel_trace_summaries order by project_id, trace_id`,
  );
  return { spans: spans.rows, summaries: summaries.rows };
}

async function setup() {
  const { client, db } = await setupDb();
  await client.exec(`
    insert into projects (id, organization_id, name, slug)
    values ('${OTHER_PROJECT}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
  `);
  const ingest = testPropertyIngest(db);
  await ingestPropertyExport(db, propertyExport(TRACE), { properties: ingest.capture });
  await ingestPropertyExport(db, propertyExport(OTHER_TRACE), {
    projectId: OTHER_PROJECT,
    properties: ingest.capture,
  });
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  return { client, db };
}

test("the fill gives old traces the values of a newly indexed key, and a second run changes nothing", async () => {
  const { client, db } = await setup();
  await setTracePropertyState(PROJECT_ID, "app.plan", "indexed", db);
  const before = await snapshot(client);

  const dryRun = await backfillTraceProperties(db, { projectId: PROJECT_ID, pageSize: 1 });
  assert.deepEqual(dryRun, { exports: 1, undecodable: 0, spans: 2, summaries: 1, batches: 1 });
  assert.deepEqual(await snapshot(client), before, "a dry run writes nothing");

  const first = await backfillTraceProperties(db, { projectId: PROJECT_ID, apply: true });
  assert.deepEqual(first, { exports: 1, undecodable: 0, spans: 2, summaries: 1, batches: 1 });
  const { rows: spans } = await client.query<{ span_id: string; properties: unknown }>(
    `select span_id, properties from otel_spans where trace_id = $1 order by span_id`,
    [TRACE],
  );
  assert.deepEqual(Object.fromEntries(spans.map((row) => [row.span_id, row.properties])), {
    [ROOT]: { organization: "acme", release: "1.2.3", "app.plan": "pro" },
    [CHILD]: { organization: "other", release: "1.2.3", "app.plan": "free" },
  });
  const after = await snapshot(client);
  // The root wins on the trace; received_at and updated_at are kept, so no sweep runs again.
  assert.deepEqual(
    after.summaries.map((row) => (row as { properties: unknown }).properties),
    [
      { organization: "acme", release: "1.2.3", "app.plan": "pro" },
      { organization: "acme", release: "1.2.3" },
    ],
  );
  assert.deepEqual(
    after.spans.map((row) => (row as { received_at: unknown }).received_at),
    before.spans.map((row) => (row as { received_at: unknown }).received_at),
  );
  assert.deepEqual(
    after.summaries.map((row) => (row as { updated_at: unknown }).updated_at),
    before.summaries.map((row) => (row as { updated_at: unknown }).updated_at),
  );

  const second = await backfillTraceProperties(db, { projectId: PROJECT_ID, apply: true });
  assert.deepEqual(second, { exports: 1, undecodable: 0, spans: 0, summaries: 0, batches: 1 });
  assert.deepEqual(await snapshot(client), after);
  // The sweep agrees with the fill.
  await client.exec(`update otel_spans set received_at = now()`);
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  const { rows } = await client.query<{ properties: unknown }>(
    `select properties from otel_trace_summaries where trace_id = $1`,
    [TRACE],
  );
  assert.deepEqual(rows[0]?.properties, {
    organization: "acme",
    release: "1.2.3",
    "app.plan": "pro",
  });
  await client.close();
});

test("with no indexed key of its own, the fill has nothing to do", async () => {
  const { client, db } = await setup();
  // The standard ones are stored already: nothing changes.
  const result = await backfillTraceProperties(db, { projectId: PROJECT_ID, apply: true });
  assert.deepEqual(result, { exports: 1, undecodable: 0, spans: 0, summaries: 0, batches: 1 });
  const nothing = await backfillTraceProperties(db, {
    projectId: PROJECT_ID,
    names: [],
    apply: true,
  });
  assert.deepEqual(nothing, { exports: 0, undecodable: 0, spans: 0, summaries: 0, batches: 0 });
  await client.close();
});

test("a queued fill of a property stopped since writes nothing: an erase stays erased", async () => {
  const { client, db } = await setup();
  // A person indexes the key (the fill is queued), then stops it and erases its values before
  // the drain runs the job.
  await setTracePropertyState(PROJECT_ID, "app.plan", "indexed", db);
  await setTracePropertyState(PROJECT_ID, "app.plan", "detected", db);
  await erasePropertyValues(db, PROJECT_ID, "app.plan");
  const before = await snapshot(client);

  const result = await backfillTraceProperties(db, {
    projectId: PROJECT_ID,
    names: ["app.plan"],
    apply: true,
  });
  assert.deepEqual(result, { exports: 0, undecodable: 0, spans: 0, summaries: 0, batches: 0 });
  assert.deepEqual(await snapshot(client), before);
  await client.close();
});

test("the erase removes one property's values from one project only", async () => {
  const { client, db } = await setup();
  const erased = await erasePropertyValues(db, PROJECT_ID, "organization", 1);
  assert.deepEqual(erased, { spans: 2, traces: 1 });
  const { rows } = await client.query<{ project_id: string; properties: unknown }>(
    `select project_id, properties from otel_trace_summaries order by project_id`,
  );
  assert.deepEqual(rows, [
    { project_id: PROJECT_ID, properties: { release: "1.2.3" } },
    { project_id: OTHER_PROJECT, properties: { organization: "acme", release: "1.2.3" } },
  ]);
  const { rows: spans } = await client.query<{ properties: unknown }>(
    `select properties from otel_spans where project_id = $1 order by span_id`,
    [PROJECT_ID],
  );
  assert.deepEqual(spans, [
    { properties: { release: "1.2.3" } },
    { properties: { release: "1.2.3" } },
  ]);
  assert.deepEqual(await erasePropertyValues(db, PROJECT_ID, "organization"), {
    spans: 0,
    traces: 0,
  });
  await client.close();
});

test("the script's arguments", () => {
  assert.deepEqual(propertyBackfillOptionsFromArgs(["--project", "p"]), {
    projectId: "p",
    apply: false,
    pageSize: 50,
  });
  assert.deepEqual(
    propertyBackfillOptionsFromArgs([
      "--project",
      "p",
      "--apply",
      "--name",
      "a",
      "--name",
      "b",
      "--page-size",
      "5",
    ]),
    { projectId: "p", apply: true, pageSize: 5, names: ["a", "b"] },
  );
  assert.throws(() => propertyBackfillOptionsFromArgs([]), /--project/);
  assert.throws(
    () => propertyBackfillOptionsFromArgs(["--project", "p", "--apply", "--dry-run"]),
    /together/,
  );
});
