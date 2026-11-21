import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deterministicEventId, parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { IntentGraphDocument } from "@/lib/readings/intent-types/wire";
import { loadAskOutcomes, resetAskOutcomeCache } from "@/lib/views/intents/map/queries";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date(Date.UTC(2026, 9, 18, 12, 0, 0));

const DOCUMENT: IntentGraphDocument = {
  v: 1,
  built_from_ts: NOW.getTime() - 86_400_000,
  rev: 9,
  intents: [
    {
      id: "intent_orders",
      label: "find an order",
      terms: ["find", "order"],
      members: ["find an order", "find order 1042"],
      support: 20,
      tools: { lookup_order: 20 },
      skills: {},
    },
    {
      id: "intent_customers",
      label: "look up a customer",
      terms: ["look", "customer"],
      members: ["look up a customer", "look up the customer by email"],
      support: 12,
      tools: { stripe_search_customers: 6, stripe_get_customer: 6 },
      skills: {},
    },
  ],
};

async function setup(): Promise<{ client: PGlite; db: BoundReadDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
           ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  const db = drizzle(client, { schema }) as unknown as BoundReadDb;
  await client.query(
    `insert into intent_graphs (project_id, graph_key, producer, document, rev, schema_version, built_from_ts, cluster_count, byte_size, content_hash)
     values ($1, 'cloud', 'cloud', $2, 9, 1, now(), 2, 100, 'h')`,
    [PROJECT_ID, JSON.stringify(DOCUMENT)],
  );
  return { client, db };
}

let seq = 0;
/** One search with its served list, stored the way the events API stores it, and its shadow turn. */
async function search(
  client: PGlite,
  db: BoundReadDb,
  input: {
    query: string;
    first: string;
    ran: string;
    live?: boolean;
    elsewhereLive?: string;
    project?: string;
  },
) {
  seq += 1;
  const project = input.project ?? PROJECT_ID;
  const eventId = `search-${seq}`;
  const { valid } = parseTraceEvents([
    {
      v: 2,
      ts: NOW.getTime() - 3_600_000 + seq,
      session_id: "s",
      source_id: "agent-app",
      event_id: eventId,
      type: "search",
      query: input.query,
      origin: "agent",
      top_k: 2,
      hits: [
        { tool_id: input.first, score: 0.9 },
        { tool_id: input.ran, score: 0.5 },
      ],
      turn_id: `t-${seq}`,
    },
  ]);
  await insertTraceEvents(
    project,
    valid.map((event) => ({ ...event, ingestSource: "runtime" as const })),
    db as never,
  );
  const searchEventId = deterministicEventId(project, eventId);
  const turn = (graphKey: string, live: boolean) =>
    client.query(
      `insert into intent_graph_shadow_turns (project_id, graph_key, search_event_id, occurred_at, plain_ids, boosted_ids, live, invoked_tool_id)
       values ($1, $2, $3, $4, '[]', '[]', $5, $6)`,
      [project, graphKey, searchEventId, new Date(NOW.getTime() - 3_600_000), live, input.ran],
    );
  await turn("cloud", input.live ?? false);
  if (input.elsewhereLive) await turn(input.elsewhereLive, true);
}

test("every search is attributed by the SDK's matcher and scored on its own tool; lists a Ratel graph ranked are counted apart", async () => {
  resetAskOutcomeCache();
  const { client, db } = await setup();
  // Orders: three searches, one worded the way no stored phrasing is; two put the right tool first.
  await search(client, db, { query: "find an order", first: "lookup_order", ran: "lookup_order" });
  await search(client, db, {
    query: "find order 99999",
    first: "lookup_order",
    ran: "lookup_order",
  });
  await search(client, db, {
    query: "find order 7",
    first: "stripe_list_invoices",
    ran: "lookup_order",
  });
  // Customers: an even split between two tools, each first for its own search.
  await search(client, db, {
    query: "look up a customer",
    first: "stripe_search_customers",
    ran: "stripe_search_customers",
  });
  await search(client, db, {
    query: "look up the customer by email",
    first: "stripe_get_customer",
    ran: "stripe_get_customer",
  });
  // Ranked by a Cloud graph: live here, or live on another Cloud graph of the project.
  await search(client, db, {
    query: "find an order",
    first: "lookup_order",
    ran: "lookup_order",
    live: true,
  });
  await search(client, db, {
    query: "find order 12",
    first: "lookup_order",
    ran: "lookup_order",
    elsewhereLive: "cloud/agent-app",
  });
  // Another project's search, never read.
  await search(client, db, {
    query: "find an order",
    first: "x",
    ran: "lookup_order",
    project: OTHER_PROJECT_ID,
  });

  const reading = await loadAskOutcomes(
    {
      projectId: PROJECT_ID,
      graphKey: "cloud",
      rev: 9,
      keep: new Set(["intent_orders", "intent_customers"]),
      cloudGraphKeys: ["cloud", "cloud/agent-app"],
      now: NOW,
    },
    db,
  );
  assert.deepEqual(reading.outcomes, [
    { clusterId: "intent_customers", ranked: 2, firstTry: 2, shaped: 0 },
    { clusterId: "intent_orders", ranked: 3, firstTry: 2, shaped: 2 },
  ]);
  assert.equal(reading.searches, 7);
  assert.equal(reading.capped, false);

  const kept = await loadAskOutcomes(
    {
      projectId: PROJECT_ID,
      graphKey: "cloud",
      rev: 9,
      keep: new Set(["intent_orders"]),
      cloudGraphKeys: ["cloud"],
      now: NOW,
    },
    db,
  );
  assert.deepEqual(
    kept.outcomes.map((outcome) => outcome.clusterId),
    ["intent_orders"],
    "only the groups asked for",
  );
  await client.close();
});
