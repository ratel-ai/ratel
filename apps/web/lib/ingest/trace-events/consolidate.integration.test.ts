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
