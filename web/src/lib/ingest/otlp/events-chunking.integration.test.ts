import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { type EventsDb, type EventWithMetric, insertEventsWithMetrics } from "./queries";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const AT = new Date("2026-11-25T12:00:00.000Z");

/** As many model calls as one export may hold, each an event of its own. */
function calls(count: number): EventWithMetric[] {
  return Array.from({ length: count }, (_, n) => ({
    event: {
      projectId: PROJECT_ID,
      occurredAt: AT,
      provider: "made-up",
      model: "made-up-model",
      latencyMs: 100,
      inputTokens: 1_500,
      outputTokens: 150,
      // Every column is there, as ingest fills them: each is a parameter.
      stream: false,
      finishReason: null,
      cachedTokens: null,
      reasoningTokens: null,
      costUsd: "0.012",
      payload: null,
      dedupeHash: `made-up-${n}`,
      categorizerVersion: 1,
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: n.toString(16).padStart(16, "0"),
    },
    metric: {
      eventTime: AT,
      tokensByCategory: {},
      splits: {},
      toolsByName: {},
      categorizerVersion: 1,
    },
  })) as unknown as EventWithMetric[];
}

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p')`);
  const stored = async () =>
    (
      await client.query<{ events: number; metrics: number }>(
        "select (select count(*)::int from events) events, (select count(*)::int from event_metrics) metrics",
      )
    ).rows[0];
  return { client, db: drizzle(client, { schema }) as unknown as EventsDb, stored };
}

test("an export of 5,000 model calls is stored whole, and a second time adds nothing", async () => {
  const { db, stored } = await setup();
  const rows = calls(5_000);
  assert.equal(await insertEventsWithMetrics(PROJECT_ID, rows, db), 5_000);
  assert.deepEqual(await stored(), { events: 5_000, metrics: 5_000 });
  assert.equal(await insertEventsWithMetrics(PROJECT_ID, rows, db), 0);
  assert.deepEqual(await stored(), { events: 5_000, metrics: 5_000 });
});

test("a failure in a later part stores nothing", async () => {
  const { client, db, stored } = await setup();
  await client.exec(`
    create function refuse() returns trigger language plpgsql as $$
    begin
      if (select count(*) from event_metrics) > 600 then raise exception 'away'; end if;
      return new;
    end $$;
    create trigger refuse before insert on event_metrics for each row execute function refuse()`);
  await assert.rejects(insertEventsWithMetrics(PROJECT_ID, calls(1_200), db));
  assert.deepEqual(await stored(), { events: 0, metrics: 0 });
});

test("events without metrics are repaired in every part", async () => {
  const { client, db, stored } = await setup();
  await insertEventsWithMetrics(PROJECT_ID, calls(1_200), db);
  await client.exec("delete from event_metrics");
  assert.equal(await insertEventsWithMetrics(PROJECT_ID, calls(1_200), db), 0);
  assert.deepEqual(await stored(), { events: 1_200, metrics: 1_200 });
});
