import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { findInFlightJob } from "@/lib/jobs/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  advanceQueryIntentsWatermark,
  enqueueDueQueryCategorizations,
  type QueryIntentsDb,
} from "@/lib/readings/query-intents/queries";

/**
 * The count-based categorization trigger (`enqueueDueQueryCategorizations`), run against
 * real PGlite: a project is enqueued only once it has accumulated `threshold`
 * un-categorized search queries past its watermark and has no run already in flight.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BASE = Date.parse("2026-06-27T00:00:00Z");

async function setup(): Promise<QueryIntentsDb> {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');`,
  );
  return drizzle(client, { schema }) as unknown as QueryIntentsDb;
}

/** `n` distinct search wire events, newest first, relative to BASE. */
function searchEvents(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const ts = BASE - i * 60_000;
    return {
      v: 1,
      ts,
      session_id: "s",
      occurred_at: new Date(ts).toISOString(),
      type: "skill_search" as const,
      query: `query number ${i}`,
    };
  });
}

test("below the threshold does not enqueue; reaching it enqueues exactly one run", async () => {
  const db = await setup();
  await insertTraceEvents(PROJECT_ID, parseTraceEvents(searchEvents(3)).valid, db);

  // 3 pending, threshold 5 -> nothing due.
  assert.deepEqual(await enqueueDueQueryCategorizations(db, 5), { enqueued: 0 });
  assert.equal(await findInFlightJob(PROJECT_ID, "categorize_queries", db), null);

  // 3 pending, threshold 3 -> due.
  assert.deepEqual(await enqueueDueQueryCategorizations(db, 3), { enqueued: 1 });
  assert.ok(
    await findInFlightJob(PROJECT_ID, "categorize_queries", db),
    "a categorize_queries job was enqueued",
  );
});

test("the in-flight guard prevents a second concurrent enqueue", async () => {
  const db = await setup();
  await insertTraceEvents(PROJECT_ID, parseTraceEvents(searchEvents(4)).valid, db);

  assert.deepEqual(await enqueueDueQueryCategorizations(db, 2), { enqueued: 1 });
  // A job is now queued -> a second poll must not stack another.
  assert.deepEqual(await enqueueDueQueryCategorizations(db, 2), { enqueued: 0 });
});

test("events already folded past the watermark don't count toward the threshold", async () => {
  const db = await setup();
  await insertTraceEvents(PROJECT_ID, parseTraceEvents(searchEvents(4)).valid, db);
  // Advance the watermark past every event -> zero pending, so nothing is due.
  await advanceQueryIntentsWatermark(PROJECT_ID, new Date(BASE + 60_000), db);
  assert.deepEqual(await enqueueDueQueryCategorizations(db, 1), { enqueued: 0 });
});
