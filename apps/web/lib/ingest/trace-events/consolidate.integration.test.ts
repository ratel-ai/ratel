import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { parseTraceEvents } from "./parse";
import { insertTraceEvents } from "./queries";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BASE = 1_790_000_000_000;

type Db = Parameters<typeof insertTraceEvents>[2];

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');`,
  );
  return { client, db: drizzle(client) as unknown as Db };
}

const statusEvent = {
  v: 2,
  ts: BASE,
  session_id: "sess-1",
  source_id: "worker-a",
  event_id: "e-1",
  type: "usage_ranking_status",
  status: "active",
  reason: "enabled",
  rev: 1,
};

function parsed() {
  const { valid, rejected } = parseTraceEvents([statusEvent]);
  assert.equal(rejected.length, 0);
  return valid.map((e) => ({ ...e, ingestSource: "runtime" as const }));
}

async function statusRows(client: Awaited<ReturnType<typeof setup>>["client"]) {
  const { rows } = await client.query<{ source_id: string; status: string }>(
    "select source_id, status from intent_graph_runtime_status",
  );
  return rows;
}

test("a ranking status keeps its row and runs the injected live sync once", async () => {
  const { client, db } = await setup();
  const synced: string[] = [];
  await insertTraceEvents(PROJECT_ID, parsed(), db, {
    intentGraphRuntimeStatus: true,
    syncIntentGraphLive: async (projectId) => {
      synced.push(projectId);
    },
  });
  assert.deepEqual(await statusRows(client), [{ source_id: "worker-a", status: "active" }]);
  assert.deepEqual(synced, [PROJECT_ID]);
});

test("without the live sync the status row is still kept", async () => {
  const { client, db } = await setup();
  await insertTraceEvents(PROJECT_ID, parsed(), db, { intentGraphRuntimeStatus: true });
  assert.deepEqual(await statusRows(client), [{ source_id: "worker-a", status: "active" }]);
});

test("without the option the event is stored and no status row is written", async () => {
  const { client, db } = await setup();
  const { accepted } = await insertTraceEvents(PROJECT_ID, parsed(), db);
  assert.equal(accepted, 1);
  assert.deepEqual(await statusRows(client), []);
});

let seq = 0;
function ev(body: Record<string, unknown>, ts = BASE + ++seq): Record<string, unknown> {
  return { ...statusEvent, ts, event_id: `e-${++seq}-${ts}`, ...body };
}

async function ingest(db: Db, events: Record<string, unknown>[]) {
  const { valid, rejected } = parseTraceEvents(events);
  assert.equal(rejected.length, 0);
  return insertTraceEvents(
    PROJECT_ID,
    valid.map((e) => ({ ...e, ingestSource: "runtime" as const })),
    db,
    { intentGraphRuntimeStatus: true },
  );
}

type StatusRow = {
  source_id: string;
  status: string;
  rev: number | null;
  graph_key: string | null;
  learn: boolean;
  observed_at: number;
};

async function fullRows(client: Awaited<ReturnType<typeof setup>>["client"]) {
  const { rows } = await client.query<StatusRow>(
    `select source_id, status, rev::int as rev, graph_key, learn,
       (extract(epoch from observed_at) * 1000)::bigint::float8 as observed_at
     from intent_graph_runtime_status order by source_id`,
  );
  return rows;
}

test("two status events for one source yield one row, the later one", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    ev({ status: "inactive", reason: "disabled", rev: undefined }, BASE + 1),
    ev({ status: "active", rev: 214, graph_key: "cloud", learn: false }, BASE + 2),
  ]);
  assert.deepEqual(await fullRows(client), [
    {
      source_id: "worker-a",
      status: "active",
      rev: 214,
      graph_key: "cloud",
      learn: false,
      observed_at: BASE + 2,
    },
  ]);
});

test("an older status ingested later does not overwrite the newer stored one", async () => {
  const { client, db } = await setup();
  await ingest(db, [ev({ rev: 9 }, BASE + 10)]);
  await ingest(db, [ev({ status: "inactive", reason: "disabled", rev: undefined }, BASE + 5)]);
  const [row] = await fullRows(client);
  assert.equal(row?.status, "active");
  assert.equal(row?.rev, 9);
});

test("a disable and re-enable in the same millisecond leaves the runtime active", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    ev({ status: "inactive", reason: "disabled", rev: undefined }, BASE + 3),
    ev({ rev: 240, graph_key: "cloud/worker-a", learn: false }, BASE + 3),
  ]);
  const [row] = await fullRows(client);
  assert.equal(row?.status, "active");
  assert.equal(row?.rev, 240);
  assert.equal(row?.graph_key, "cloud/worker-a");
});

test("the same-millisecond enable still lands when a flush splits it from the disable, and a replayed disable changes nothing", async () => {
  const { client, db } = await setup();
  const disable = ev({ status: "inactive", reason: "disabled", rev: undefined }, BASE + 3);
  await ingest(db, [disable]);
  await ingest(db, [ev({ rev: 241, graph_key: "cloud/worker-a" }, BASE + 3)]);
  assert.equal((await fullRows(client))[0]?.status, "active");
  // Deduplicated by its event id before the status is read.
  const replay = await ingest(db, [disable]);
  assert.equal(replay.accepted, 0);
  const [row] = await fullRows(client);
  assert.equal(row?.status, "active");
  assert.equal(row?.rev, 241);
});

test("a disable report names no graph, so the row keeps the graph the runtime stopped ranking from", async () => {
  const { client, db } = await setup();
  await ingest(db, [ev({ rev: 7, graph_key: "cloud/worker-a", learn: false }, BASE + 1)]);
  await ingest(db, [ev({ status: "inactive", reason: "disabled", rev: undefined }, BASE + 2)]);
  const [row] = await fullRows(client);
  assert.equal(row?.status, "inactive");
  assert.equal(row?.graph_key, "cloud/worker-a");
});

test("a replayed batch changes nothing and learn defaults to true when absent", async () => {
  const { client, db } = await setup();
  const batch = [ev({ status: "paused", rev: 3 }, BASE + 7)];
  assert.equal((await ingest(db, batch)).accepted, 1);
  assert.equal((await ingest(db, batch)).accepted, 0);
  assert.deepEqual(await fullRows(client), [
    {
      source_id: "worker-a",
      status: "paused",
      rev: 3,
      graph_key: null,
      learn: true,
      observed_at: BASE + 7,
    },
  ]);
});
