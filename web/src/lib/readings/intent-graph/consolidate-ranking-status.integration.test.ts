import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { listIntentGraphRuntimeStatus } from "@/lib/readings/intent-graph/queries";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BASE = 1_790_000_000_000;

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');`,
  );
  const db = drizzle(client, { schema }) as unknown as Parameters<typeof insertTraceEvents>[2];
  return { client, db };
}

let seq = 0;
function ev(body: Record<string, unknown>, ts = BASE + ++seq): Record<string, unknown> {
  return {
    v: 2,
    ts,
    session_id: "sess-1",
    source_id: "worker-a",
    event_id: `e-${seq}-${ts}`,
    ...body,
  };
}

async function ingest(
  db: Parameters<typeof insertTraceEvents>[2],
  events: Record<string, unknown>[],
  options: { intentGraphRuntimeStatus?: boolean } = { intentGraphRuntimeStatus: true },
) {
  const { valid, rejected } = parseTraceEvents(events);
  assert.equal(rejected.length, 0);
  return insertTraceEvents(
    PROJECT_ID,
    valid.map((e) => ({ ...e, ingestSource: "runtime" })),
    db,
    options,
  );
}

test("without the build flag the status event is stored like any other and no status row is written", async () => {
  const { db, client } = await setup();
  await ingest(
    db,
    [ev({ type: "usage_ranking_status", status: "active", reason: "enabled", rev: 1 })],
    {},
  );
  assert.deepEqual(await listIntentGraphRuntimeStatus(PROJECT_ID, db as never), []);
  const stored = await client.query<{ n: number }>(
    `select count(*)::int as n from trace_events where project_id = $1 and type = 'usage_ranking_status'`,
    [PROJECT_ID],
  );
  assert.equal(stored.rows[0]?.n, 1);
});

test("turn_id lands in its column and a usage_boost row is stored payload-only", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    ev({ type: "search", query: "q", turn_id: "turn-1", hits: [] }),
    ev({
      type: "usage_boost",
      intent: "intent_3",
      similarity: 0.6,
      support: 4,
      promoted: 1,
      dropped: 0,
    }),
  ]);

  const rows = await client.query<{
    type: string;
    turn_id: string | null;
    tool_id: string | null;
    intent: string | null;
  }>(
    `select type, turn_id, tool_id, payload->>'intent' as intent from trace_events order by occurred_at`,
  );
  assert.deepEqual(rows.rows, [
    { type: "search", turn_id: "turn-1", tool_id: null, intent: null },
    { type: "usage_boost", turn_id: null, tool_id: null, intent: "intent_3" },
  ]);
});

test("two status events for one source yield one row, the later one", async () => {
  const { db } = await setup();
  await ingest(db, [
    ev({ type: "usage_ranking_status", status: "inactive", reason: "disabled" }, BASE + 1),
    ev(
      {
        type: "usage_ranking_status",
        status: "active",
        reason: "enabled",
        rev: 214,
        graph_key: "cloud",
        learn: false,
      },
      BASE + 2,
    ),
  ]);

  const rows = await listIntentGraphRuntimeStatus(PROJECT_ID, db as never);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, "worker-a");
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].reason, "enabled");
  assert.equal(rows[0].rev, 214);
  assert.equal(rows[0].graphKey, "cloud");
  assert.equal(rows[0].learn, false);
  assert.equal(rows[0].observedAt.getTime(), BASE + 2);
});

test("a disable and re-enable in the same millisecond leaves the runtime active", async () => {
  const { db } = await setup();
  await ingest(db, [
    ev(
      { type: "usage_ranking_status", status: "inactive", reason: "disabled", event_id: "tie-1" },
      BASE + 3,
    ),
    ev(
      {
        type: "usage_ranking_status",
        status: "active",
        reason: "enabled",
        rev: 240,
        graph_key: "cloud/worker-a",
        learn: false,
        event_id: "tie-2",
      },
      BASE + 3,
    ),
  ]);

  const [row] = await listIntentGraphRuntimeStatus(PROJECT_ID, db as never);
  assert.equal(row?.status, "active");
  assert.equal(row?.rev, 240);
  assert.equal(row?.graphKey, "cloud/worker-a");
});

test("the same-millisecond disable and re-enable still lands the enable when a flush splits them", async () => {
  const { db } = await setup();
  await ingest(db, [
    ev(
      { type: "usage_ranking_status", status: "inactive", reason: "disabled", event_id: "split-1" },
      BASE + 3,
    ),
  ]);
  await ingest(db, [
    ev(
      {
        type: "usage_ranking_status",
        status: "active",
        reason: "enabled",
        rev: 241,
        graph_key: "cloud/worker-a",
        event_id: "split-2",
      },
      BASE + 3,
    ),
  ]);
  const [row] = await listIntentGraphRuntimeStatus(PROJECT_ID, db as never);
  assert.equal(row?.status, "active");
  assert.equal(row?.rev, 241);
  // A replay of the disable is deduplicated by its id before the status is read, so it changes nothing.
  await ingest(db, [
    ev(
      { type: "usage_ranking_status", status: "inactive", reason: "disabled", event_id: "split-1" },
      BASE + 3,
    ),
  ]);
  assert.equal((await listIntentGraphRuntimeStatus(PROJECT_ID, db as never))[0]?.status, "active");
});

test("a disable report names no graph, so the row keeps the graph the runtime stopped ranking from", async () => {
  const { db } = await setup();
  await ingest(db, [
    ev(
      {
        type: "usage_ranking_status",
        status: "active",
        reason: "enabled",
        rev: 7,
        graph_key: "cloud/worker-a",
        learn: false,
      },
      BASE + 1,
    ),
  ]);
  await ingest(db, [
    ev({ type: "usage_ranking_status", status: "inactive", reason: "disabled" }, BASE + 2),
  ]);

  const [row] = await listIntentGraphRuntimeStatus(PROJECT_ID, db as never);
  assert.equal(row?.status, "inactive");
  assert.equal(row?.reason, "disabled");
  assert.equal(row?.graphKey, "cloud/worker-a");
});

test("an older status ingested later does not overwrite the newer stored one", async () => {
  const { db } = await setup();
  await ingest(db, [
    ev({ type: "usage_ranking_status", status: "active", reason: "enabled", rev: 9 }, BASE + 10),
  ]);
  await ingest(db, [
    ev({ type: "usage_ranking_status", status: "inactive", reason: "disabled" }, BASE + 5),
  ]);

  const [row] = await listIntentGraphRuntimeStatus(PROJECT_ID, db as never);
  assert.equal(row?.status, "active");
  assert.equal(row?.rev, 9);
});

test("a replayed batch changes nothing and learn defaults to true when absent", async () => {
  const { db } = await setup();
  const batch = [
    ev({ type: "usage_ranking_status", status: "paused", reason: "enabled", rev: 3 }, BASE + 7),
  ];
  const first = await ingest(db, batch);
  const second = await ingest(db, batch);
  assert.equal(first.accepted, 1);
  assert.equal(second.accepted, 0);

  const rows = await listIntentGraphRuntimeStatus(PROJECT_ID, db as never);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].learn, true);
  assert.equal(rows[0].model, null);
});

test("sources are kept apart and listed newest first", async () => {
  const { db } = await setup();
  await ingest(db, [
    ev({ type: "usage_ranking_status", status: "active", reason: "enabled", rev: 1 }, BASE + 1),
    ev(
      {
        type: "usage_ranking_status",
        status: "active",
        reason: "enabled",
        rev: 2,
        source_id: "worker-b",
      },
      BASE + 2,
    ),
  ]);

  const rows = await listIntentGraphRuntimeStatus(PROJECT_ID, db as never);
  assert.deepEqual(
    rows.map((r) => [r.sourceId, r.rev]),
    [
      ["worker-b", 2],
      ["worker-a", 1],
    ],
  );
});

test("a runtime fact upgrading an OTLP-derived row carries turn_id onto the column", async () => {
  const { client, db } = await setup();
  const { valid } = parseTraceEvents([ev({ type: "search", query: "q", hits: [] }, BASE + 50)]);
  const [event] = valid;
  assert.ok(event);
  // The same event first seen through the OTel bridge: no turn id, and no
  // event_id either (a span without ratel.event.id), so the pre-insert delete
  // by event_id leaves it in place and the row must be upgraded in place.
  await insertTraceEvents(
    PROJECT_ID,
    [{ ...event, ingestSource: "otlp", eventId: null, turnId: null }],
    db,
  );
  // Then the authoritative runtime fact for it: same client_event_id, so the
  // same row id, so the ON CONFLICT DO UPDATE upgrade path runs.
  await insertTraceEvents(
    PROJECT_ID,
    [{ ...event, ingestSource: "runtime", turnId: "turn-9" }],
    db,
  );

  const rows = await client.query<{ ingest_source: string; turn_id: string | null }>(
    `select ingest_source, turn_id from trace_events`,
  );
  assert.deepEqual(rows.rows, [{ ingest_source: "runtime", turn_id: "turn-9" }]);
});
