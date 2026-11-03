import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { countSdkActivity, countSdkActivityByDay, latestSdkEventAt } from "@/lib/views/home/load";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

async function setup(): Promise<BoundReadDb> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
    insert into trace_events (id, project_id, type, client_event_id, payload, occurred_at, received_at) values
      ('50000000-0000-4000-8000-000000000001', '${PROJECT_ID}', 'search', 'e1', '{}', '2026-10-14T10:00:00Z', '2026-10-14T10:00:01Z'),
      ('50000000-0000-4000-8000-000000000002', '${PROJECT_ID}', 'search', 'e2', '{}', '2026-10-15T09:00:00Z', '2026-10-15T09:00:01Z'),
      ('50000000-0000-4000-8000-000000000003', '${PROJECT_ID}', 'invoke_start', 'e3', '{}', '2026-10-15T09:00:02Z', '2026-10-15T09:00:03Z'),
      ('50000000-0000-4000-8000-000000000004', '${PROJECT_ID}', 'invoke_end', 'e4', '{}', '2026-10-15T09:00:04Z', '2026-10-15T09:00:05Z'),
      ('50000000-0000-4000-8000-000000000005', '${PROJECT_ID}', 'skill_invoke', 'e5', '{}', null, '2026-10-15T11:00:00Z'),
      ('50000000-0000-4000-8000-000000000006', '${PROJECT_ID}', 'search', 'e6', '{}', '2026-09-01T10:00:00Z', '2026-09-01T10:00:01Z'),
      ('50000000-0000-4000-8000-000000000007', '${OTHER_PROJECT_ID}', 'search', 'e7', '{}', '2026-10-15T12:00:00Z', '2026-10-15T12:00:01Z');
  `);
  return drizzle(client, { schema }) as unknown as BoundReadDb;
}

test("SDK activity counts searches, tool calls and skill runs in the window, for this project only", async () => {
  const db = await setup();
  const activity = await countSdkActivity(
    PROJECT_ID,
    { since: new Date("2026-10-09T00:00:00Z"), until: new Date("2026-10-16T00:00:00Z") },
    db,
  );
  // invoke_end is not counted twice: a tool call is its start.
  assert.deepEqual(activity, { searches: 2, toolCalls: 1, skillRuns: 1 });
});

test("an empty window counts nothing", async () => {
  const db = await setup();
  const activity = await countSdkActivity(
    PROJECT_ID,
    { since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-08T00:00:00Z") },
    db,
  );
  assert.deepEqual(activity, { searches: 0, toolCalls: 0, skillRuns: 0 });
});

test("the newest SDK event falls back to when it was received", async () => {
  const db = await setup();
  assert.equal((await latestSdkEventAt(PROJECT_ID, db))?.toISOString(), "2026-10-15T11:00:00.000Z");
  const empty = "44444444-4444-4444-8444-444444444444";
  assert.equal(await latestSdkEventAt(empty, db), null);
});

test("SDK activity by day: each UTC day's searches, tool calls and skill runs, oldest first", async () => {
  const db = await setup();
  const days = await countSdkActivityByDay(
    PROJECT_ID,
    { since: new Date("2026-10-09T00:00:00Z"), until: new Date("2026-10-16T00:00:00Z") },
    db,
  );
  assert.deepEqual(days, [
    { day: "2026-10-14", searches: 1, toolCalls: 0, skillRuns: 0 },
    // The skill run has no event time: it is counted when it was received.
    { day: "2026-10-15", searches: 1, toolCalls: 1, skillRuns: 1 },
  ]);
});
