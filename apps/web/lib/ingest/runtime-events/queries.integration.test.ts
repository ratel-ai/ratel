import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import {
  countRuntimeEventRejects,
  countRuntimeEvents,
  getRuntimeEvent,
  listRuntimeEventFacets,
  listRuntimeEventRejects,
  listRuntimeEvents,
  type RuntimeEventsDb,
  summarizeRuntimeEventClientDrops,
  sumRuntimeEventClientDrops,
} from "@/lib/ingest/runtime-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-13T12:00:00.000Z");

async function setup(): Promise<RuntimeEventsDb> {
  return (await setupWithClient()).db;
}

async function setupWithClient() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
      values ('${ORG_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORG_ID}', 'Main', 'main'),
      ('${OTHER_PROJECT_ID}', '${ORG_ID}', 'Other', 'other');
    insert into runtime_event_sources
      (project_id, source_id, facts_started_at, first_seen_at, last_seen_at) values
      ('${PROJECT_ID}', 'fresh', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-13T10:00:00Z'),
      ('${PROJECT_ID}', 'stale', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'),
      ('${PROJECT_ID}', 'dormant', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    insert into trace_events
      (id, project_id, type, occurred_at, received_at, ingest_source,
       client_event_id, event_id, source_id, trace_id, span_id, took_ms, payload) values
      ('00000000-0000-8000-8000-000000000001', '${PROJECT_ID}', 'search', '2026-08-13T09:00:00Z', '2026-08-13T09:00:01Z', 'runtime', 'fresh-1', 'evt-fresh', 'fresh', 'trace-fresh', 'span-fresh', 12, '{"query":"deploy"}'),
      ('00000000-0000-8000-8000-000000000002', '${PROJECT_ID}', 'invoke_error', '2026-08-01T09:00:00Z', '2026-08-01T09:00:01Z', 'runtime', 'stale-1', 'evt-stale', 'stale', null, null, 31, '{"error":"timeout"}'),
      ('00000000-0000-8000-8000-000000000003', '${PROJECT_ID}', 'skill_invoke', '2026-07-01T09:00:00Z', '2026-07-01T09:00:01Z', 'runtime', 'dormant-1', 'evt-dormant', 'dormant', null, null, null, '{}'),
      ('00000000-0000-8000-8000-000000000004', '${PROJECT_ID}', 'search', '2026-08-13T08:00:00Z', '2026-08-13T08:00:01Z', 'otlp', 'otel-1', 'evt-otel', 'fresh', null, null, 99, '{}'),
      ('00000000-0000-8000-8000-000000000005', '${OTHER_PROJECT_ID}', 'search', '2026-08-13T08:00:00Z', '2026-08-13T08:00:01Z', 'runtime', 'other-1', 'evt-other', 'fresh', null, null, 99, '{}');
    insert into trace_event_rejects
      (id, project_id, event_id, type, reason, size_bytes, source_id, received_at) values
      ('10000000-0000-4000-8000-000000000001', '${PROJECT_ID}', 'evt-reject', 'search', 'query: required', 321, 'fresh', '2026-08-13T10:00:00Z'),
      ('10000000-0000-4000-8000-000000000002', '${OTHER_PROJECT_ID}', 'evt-other-reject', 'search', 'bad', 12, 'fresh', '2026-08-13T10:00:00Z');
    insert into trace_event_rejects
      (id, project_id, event_id, type, reason, size_bytes, source_id, received_at)
    select
      ('20000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
      '${PROJECT_ID}',
      'evt-bulk-' || value,
      'invoke_error',
      'timeout',
      12,
      'bulk',
      '2026-08-13T11:00:00Z'
    from generate_series(1, 100) as value;
  `);
  return {
    client,
    db: drizzle(client, { schema }) as unknown as RuntimeEventsDb,
  };
}

test("runtime event reads isolate projects, exclude OTLP rows, and mark stale sources", async () => {
  const db = await setup();
  const rows = await listRuntimeEvents(PROJECT_ID, { now: NOW }, db);

  assert.deepEqual(
    rows.map(({ eventId, sourceStatus }) => ({ eventId, sourceStatus })),
    [
      { eventId: "evt-fresh", sourceStatus: "active" },
      { eventId: "evt-stale", sourceStatus: "stale" },
    ],
  );
});

test("runtime event reads filter by type, source, and event time", async () => {
  const db = await setup();
  const rows = await listRuntimeEvents(
    PROJECT_ID,
    {
      now: NOW,
      type: "invoke_error",
      sourceId: "stale",
      since: new Date("2026-08-01T00:00:00Z"),
      until: new Date("2026-08-02T00:00:00Z"),
    },
    db,
  );

  assert.deepEqual(
    rows.map(({ eventId }) => eventId),
    ["evt-stale"],
  );
});

test("an explicit source filter can inspect a dormant source", async () => {
  const db = await setup();
  const rows = await listRuntimeEvents(PROJECT_ID, { now: NOW, sourceId: "dormant" }, db);

  assert.deepEqual(
    rows.map(({ eventId, sourceStatus }) => ({ eventId, sourceStatus })),
    [{ eventId: "evt-dormant", sourceStatus: "dormant" }],
  );
});

test("runtime event drill-down resolves the external ratel.event.id", async () => {
  const db = await setup();
  const row = await getRuntimeEvent(PROJECT_ID, "evt-fresh", db);

  assert.equal(row?.traceId, "trace-fresh");
  assert.deepEqual(row?.payload, { query: "deploy" });
  assert.equal(await getRuntimeEvent(OTHER_PROJECT_ID, "evt-fresh", db), null);
});

test("runtime event facets retain dormant sources while identifying their status", async () => {
  const db = await setup();
  const facets = await listRuntimeEventFacets(PROJECT_ID, { now: NOW }, db);

  assert.deepEqual(facets.types, ["invoke_error", "search"]);
  assert.deepEqual(
    facets.sources.map(({ sourceId, status }) => ({ sourceId, status })),
    [
      { sourceId: "fresh", status: "active" },
      { sourceId: "stale", status: "stale" },
      { sourceId: "dormant", status: "dormant" },
    ],
  );
});

test("runtime event source facets are capped", async () => {
  const { client, db } = await setupWithClient();
  await client.exec(`
    insert into runtime_event_sources
      (project_id, source_id, first_seen_at, last_seen_at)
    select
      '${PROJECT_ID}',
      'bulk-' || lpad(value::text, 4, '0'),
      '2026-08-13T00:00:00Z',
      '2026-08-13T00:00:00Z'
    from generate_series(1, 501) as value;
  `);

  const facets = await listRuntimeEventFacets(PROJECT_ID, { now: NOW }, db);

  assert.equal(facets.sources.length, 500);
});

test("runtime event hot reads have supporting indexes", async () => {
  const { client } = await setupWithClient();
  const indexes = await client.query<{ indexname: string; indexdef: string }>(`
    select indexname, indexdef
    from pg_indexes
    where tablename = 'trace_events'
      and indexname in (
        'trace_events_project_event_idx',
        'trace_events_project_ingest_time_idx'
      )
    order by indexname
  `);

  assert.deepEqual(
    indexes.rows.map(({ indexname }) => indexname),
    ["trace_events_project_event_idx", "trace_events_project_ingest_time_idx"],
  );
  assert.match(indexes.rows[0].indexdef, /\(project_id, event_id\)/);
  assert.match(
    indexes.rows[1].indexdef,
    /\(project_id, ingest_source, COALESCE\(occurred_at, received_at\)\)/,
  );
});

test("dropped reads expose only rejection metadata and honor filters", async () => {
  const db = await setup();
  const rows = await listRuntimeEventRejects(
    PROJECT_ID,
    {
      type: "search",
      sourceId: "fresh",
      since: new Date("2026-08-13T00:00:00Z"),
      until: new Date("2026-08-14T00:00:00Z"),
    },
    db,
  );

  assert.deepEqual(rows, [
    {
      id: "10000000-0000-4000-8000-000000000001",
      eventId: "evt-reject",
      type: "search",
      reason: "query: required",
      sizeBytes: 321,
      sourceId: "fresh",
      receivedAt: new Date("2026-08-13T10:00:00.000Z"),
    },
  ]);
  assert.equal("payload" in rows[0], false);
});

test("client drop markers aggregate by source and reason within the range", async () => {
  const { client, db } = await setupWithClient();
  await client.exec(`
    insert into trace_events
      (id, project_id, type, occurred_at, received_at, ingest_source,
       client_event_id, event_id, source_id, payload) values
      ('30000000-0000-8000-8000-000000000001', '${PROJECT_ID}', 'events_dropped', '2026-08-13T09:00:00Z', '2026-08-13T09:00:01Z', 'runtime', 'drop-1', 'evt-drop-1', 'fresh', '{"reason":"queue_overflow","dropped_count":40}'),
      ('30000000-0000-8000-8000-000000000002', '${PROJECT_ID}', 'events_dropped', '2026-08-13T10:00:00Z', '2026-08-13T10:00:01Z', 'runtime', 'drop-2', 'evt-drop-2', 'fresh', '{"reason":"queue_overflow","dropped_count":2}'),
      ('30000000-0000-8000-8000-000000000003', '${PROJECT_ID}', 'events_dropped', '2026-08-13T08:00:00Z', '2026-08-13T08:00:01Z', 'runtime', 'drop-3', 'evt-drop-3', 'stale', '{"reason":"flush_failed","dropped_count":5}'),
      ('30000000-0000-8000-8000-000000000004', '${PROJECT_ID}', 'events_dropped', '2026-06-01T08:00:00Z', '2026-06-01T08:00:01Z', 'runtime', 'drop-old', 'evt-drop-old', 'fresh', '{"reason":"queue_overflow","dropped_count":999}'),
      ('30000000-0000-8000-8000-000000000005', '${OTHER_PROJECT_ID}', 'events_dropped', '2026-08-13T09:30:00Z', '2026-08-13T09:30:01Z', 'runtime', 'drop-other', 'evt-drop-other', 'fresh', '{"reason":"queue_overflow","dropped_count":777}'),
      ('30000000-0000-8000-8000-000000000006', '${PROJECT_ID}', 'events_dropped', '2026-08-13T09:45:00Z', '2026-08-13T09:45:01Z', 'otlp', 'drop-otlp', 'evt-drop-otlp', 'fresh', '{"reason":"queue_overflow","dropped_count":111}');
  `);
  const range = {
    since: new Date("2026-08-13T00:00:00Z"),
    until: new Date("2026-08-14T00:00:00Z"),
  };

  const groups = await summarizeRuntimeEventClientDrops(PROJECT_ID, range, db);

  assert.deepEqual(groups, [
    {
      sourceId: "fresh",
      reason: "queue_overflow",
      droppedCount: 42,
      windowCount: 2,
      lastDropAt: new Date("2026-08-13T10:00:00.000Z"),
    },
    {
      sourceId: "stale",
      reason: "flush_failed",
      droppedCount: 5,
      windowCount: 1,
      lastDropAt: new Date("2026-08-13T08:00:00.000Z"),
    },
  ]);

  const filtered = await summarizeRuntimeEventClientDrops(
    PROJECT_ID,
    { ...range, sourceId: "stale" },
    db,
  );
  assert.deepEqual(
    filtered.map(({ sourceId }) => sourceId),
    ["stale"],
  );
});

test("dropped count is not capped by the 100-row read page", async () => {
  const db = await setup();

  assert.equal((await listRuntimeEventRejects(PROJECT_ID, {}, db)).length, 100);
  assert.equal(await countRuntimeEventRejects(PROJECT_ID, {}, db), 101);
  assert.equal(await countRuntimeEventRejects(OTHER_PROJECT_ID, {}, db), 1);
});

test("the received count covers every runtime row the list shows, uncapped and per project", async () => {
  const { client, db } = await setupWithClient();
  await client.exec(`
    insert into trace_events
      (id, project_id, type, occurred_at, received_at, ingest_source,
       client_event_id, event_id, source_id, payload) values
      ('40000000-0000-8000-8000-000000000001', '${PROJECT_ID}', 'events_dropped', '2026-08-13T09:30:00Z', '2026-08-13T09:30:01Z', 'runtime', 'drop-count', 'evt-drop-count', 'fresh', '{"reason":"queue_overflow","dropped_count":3}');
  `);

  assert.equal(
    await countRuntimeEvents(PROJECT_ID, {}, db),
    4,
    "fresh, stale and dormant events and the drop report; never the OTLP row",
  );
  assert.equal(
    await countRuntimeEvents(
      PROJECT_ID,
      { since: new Date("2026-08-13T00:00:00Z"), until: new Date("2026-08-14T00:00:00Z") },
      db,
    ),
    2,
    "the fresh search and the drop report fall in the window",
  );
  assert.equal(await countRuntimeEvents(PROJECT_ID, { sourceId: "stale" }, db), 1);
  assert.equal(await countRuntimeEvents(OTHER_PROJECT_ID, {}, db), 1);
});

test("the dropped total sums every drop report in the window, past a page of groups", async () => {
  const { client, db } = await setupWithClient();
  // 101 sources, each reporting 2 dropped events: more groups than one page of the grouped summary.
  await client.exec(`
    insert into trace_events
      (id, project_id, type, occurred_at, received_at, ingest_source,
       client_event_id, event_id, source_id, payload)
    select
      ('50000000-0000-8000-8000-' || lpad(value::text, 12, '0'))::uuid,
      '${PROJECT_ID}',
      'events_dropped',
      '2026-08-13T09:00:00Z',
      '2026-08-13T09:00:01Z',
      'runtime',
      'sum-' || value,
      'evt-sum-' || value,
      'source-' || value,
      '{"reason":"queue_overflow","dropped_count":2}'
    from generate_series(1, 101) as value;
    insert into trace_events
      (id, project_id, type, occurred_at, received_at, ingest_source,
       client_event_id, event_id, source_id, payload) values
      ('60000000-0000-8000-8000-000000000001', '${PROJECT_ID}', 'events_dropped', '2026-06-01T09:00:00Z', '2026-06-01T09:00:01Z', 'runtime', 'sum-old', 'evt-sum-old', 'source-1', '{"reason":"queue_overflow","dropped_count":500}'),
      ('60000000-0000-8000-8000-000000000002', '${OTHER_PROJECT_ID}', 'events_dropped', '2026-08-13T09:00:00Z', '2026-08-13T09:00:01Z', 'runtime', 'sum-other', 'evt-sum-other', 'source-1', '{"reason":"queue_overflow","dropped_count":700}'),
      ('60000000-0000-8000-8000-000000000003', '${PROJECT_ID}', 'events_dropped', '2026-08-13T09:00:00Z', '2026-08-13T09:00:01Z', 'otlp', 'sum-otlp', 'evt-sum-otlp', 'source-1', '{"reason":"queue_overflow","dropped_count":900}');
  `);
  const range = {
    since: new Date("2026-08-13T00:00:00Z"),
    until: new Date("2026-08-14T00:00:00Z"),
  };

  assert.equal(
    (await summarizeRuntimeEventClientDrops(PROJECT_ID, range, db)).length,
    100,
    "the grouped list is one page",
  );
  assert.equal(
    await sumRuntimeEventClientDrops(PROJECT_ID, range, db),
    202,
    "the total covers all 101 sources",
  );
  assert.equal(
    await sumRuntimeEventClientDrops(PROJECT_ID, { ...range, sourceId: "source-7" }, db),
    2,
  );
  assert.equal(
    await sumRuntimeEventClientDrops(PROJECT_ID, {}, db),
    702,
    "without a window the old report counts too",
  );
  assert.equal(await sumRuntimeEventClientDrops(OTHER_PROJECT_ID, range, db), 700);
});
