import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { enqueueJob } from "@/lib/jobs/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  enqueueFoldIntentGraphJob,
  listProjectsWithUnfoldedEvents,
} from "@/lib/readings/intent-graph/queries";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug, intent_graph_folded_through)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent', now() - interval '2 days');
  `);
  const db = drizzle(client, { schema }) as unknown as Parameters<typeof enqueueJob>[1];
  return { client, db };
}

test("at most one queued fold per project; the second enqueue coalesces to null", async () => {
  const { client, db } = await setup();

  const first = await enqueueFoldIntentGraphJob(PROJECT_ID, db);
  const second = await enqueueFoldIntentGraphJob(PROJECT_ID, db);

  assert.ok(first);
  assert.equal(second, null);
  const rows = await client.query<{ n: number }>(
    `select count(*)::int as n from jobs where kind = 'fold_intent_graph' and status = 'queued'`,
  );
  assert.equal(rows.rows[0]?.n, 1);
});

test("with a minimum interval, a fold that finished recently stops the ingest path from enqueuing; the cron path is not paced", async () => {
  const { client, db } = await setup();
  const first = await enqueueFoldIntentGraphJob(PROJECT_ID, db);
  await client.query(
    `update jobs set status = 'done', finished_at = now() - interval '20 seconds' where id = '${first!.id}'`,
  );

  assert.equal(
    await enqueueFoldIntentGraphJob(PROJECT_ID, db, { minIntervalMs: 60_000 }),
    null,
    "paced",
  );
  assert.ok(await enqueueFoldIntentGraphJob(PROJECT_ID, db), "the safety net still enqueues");

  await client.query(
    `update jobs set status = 'done', finished_at = now() - interval '90 seconds' where project_id = '${PROJECT_ID}'`,
  );
  assert.ok(
    await enqueueFoldIntentGraphJob(PROJECT_ID, db, { minIntervalMs: 60_000 }),
    "old enough",
  );
});

test("a fold that errored just now paces the ingest path too, so a failure that repeats by design is not retried on every batch", async () => {
  // The store cap holds the cursor and throws on every run. Paced on done
  // folds only, each accepted batch would re-read the page, throw and report.
  const { client, db } = await setup();
  const first = await enqueueFoldIntentGraphJob(PROJECT_ID, db);
  await client.query(
    `update jobs set status = 'error', finished_at = now() where id = '${first!.id}'`,
  );

  assert.equal(
    await enqueueFoldIntentGraphJob(PROJECT_ID, db, { minIntervalMs: 60_000 }),
    null,
    "paced on the error",
  );
  assert.ok(
    await enqueueFoldIntentGraphJob(PROJECT_ID, db, { minIntervalMs: 0 }),
    "no interval, no pacing",
  );
});

test("a running fold does not block a new queued one", async () => {
  const { client, db } = await setup();
  const first = await enqueueFoldIntentGraphJob(PROJECT_ID, db);
  await client.query(`update jobs set status = 'running' where id = '${first!.id}'`);

  const second = await enqueueFoldIntentGraphJob(PROJECT_ID, db);

  assert.ok(second);
});

test("other kinds can still queue several jobs per project", async () => {
  const { client, db } = await setup();

  await enqueueJob(
    { projectId: PROJECT_ID, kind: "match_quality_run", payload: { runId: "a" } },
    db,
  );
  await enqueueJob(
    { projectId: PROJECT_ID, kind: "match_quality_run", payload: { runId: "b" } },
    db,
  );

  const rows = await client.query<{ n: number }>(
    `select count(*)::int as n from jobs where kind = 'match_quality_run' and status = 'queued'`,
  );
  assert.equal(rows.rows[0]?.n, 2);
});

test("the safety net lists a project with unfolded events, skips one with a queued fold, and skips a recent error", async () => {
  const { client, db } = await setup();
  await client.query(`
    insert into trace_events (id, project_id, type, session_id, client_event_id, payload, received_at)
    values (gen_random_uuid(), '${PROJECT_ID}', 'search', 's', 'c1', '{}'::jsonb, now())
  `);

  assert.deepEqual(await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0 }), [
    { id: PROJECT_ID },
  ]);

  const job = await enqueueFoldIntentGraphJob(PROJECT_ID, db);
  assert.deepEqual(await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0 }), []);

  await client.query(
    `update jobs set status = 'error', finished_at = now() where id = '${job!.id}'`,
  );
  assert.deepEqual(
    await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0 }),
    [],
    "errored within the last hour",
  );
  assert.deepEqual(
    await listProjectsWithUnfoldedEvents(db, { errorBackoffMs: 0, commitLagMs: 0 }),
    [{ id: PROJECT_ID }],
  );
});

test("the safety net lists a project whose only unfolded rows are a plain agent trace's", async () => {
  const { client, db } = await setup();
  await client.query(`
    insert into trace_events (id, project_id, type, ingest_source, session_id, client_event_id, payload, received_at)
    values (gen_random_uuid(), '${PROJECT_ID}', 'otlp_model_call', 'otlp', 's', 'c1', '{"prompt":"find my tasks"}'::jsonb, now())
  `);
  assert.deepEqual(await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0 }), [
    { id: PROJECT_ID },
  ]);
});

test("a model call without a prompt is not unfolded: the reader skips it, so the safety net must not count it", async () => {
  // Content capture is off by default in OTel exporters and a run usually ends
  // on a model call, so this is the common newest row. Counted, it would stay
  // past the cursor forever and the cron would queue an empty fold every minute.
  const { client, db } = await setup();
  await client.query(`
    insert into trace_events (id, project_id, type, ingest_source, session_id, client_event_id, payload, received_at)
    values
      (gen_random_uuid(), '${PROJECT_ID}', 'otlp_model_call', 'otlp', 's', 'c1', '{"prompt":"find my tasks"}'::jsonb, now() - interval '1 hour'),
      (gen_random_uuid(), '${PROJECT_ID}', 'otlp_model_call', 'otlp', 's', 'c2', '{}'::jsonb, now())
  `);
  await client.query(
    `update projects set intent_graph_folded_through = now() - interval '30 minutes' where id = '${PROJECT_ID}'`,
  );
  assert.deepEqual(await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0 }), []);
});

test("the safety net skips a project the fold has never met: no cursor and no fold job", async () => {
  // A project outside the build flag never gets either, so it cannot fill the
  // page or cost the drain an org lookup; its first fold is the ingest kick's.
  const { client, db } = await setup();
  await client.query(`
    insert into trace_events (id, project_id, type, session_id, client_event_id, payload, received_at)
    values (gen_random_uuid(), '${PROJECT_ID}', 'search', 's', 'c1', '{}'::jsonb, now())
  `);
  await client.query(
    `update projects set intent_graph_folded_through = null where id = '${PROJECT_ID}'`,
  );
  assert.deepEqual(await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0 }), []);

  const job = await enqueueFoldIntentGraphJob(PROJECT_ID, db);
  await client.query(
    `update jobs set status = 'done', finished_at = now() where id = '${job!.id}'`,
  );
  assert.deepEqual(
    await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0 }),
    [{ id: PROJECT_ID }],
    "a past fold job is enough",
  );
});

test("the safety net ignores events at or before the cursor and non-learning types", async () => {
  const { client, db } = await setup();
  await client.query(`
    insert into trace_events (id, project_id, type, session_id, client_event_id, payload, received_at)
    values
      (gen_random_uuid(), '${PROJECT_ID}', 'search', 's', 'c1', '{}'::jsonb, now() - interval '1 hour'),
      (gen_random_uuid(), '${PROJECT_ID}', 'invoke_end', 's', 'c2', '{}'::jsonb, now())
  `);
  await client.query(
    `update projects set intent_graph_folded_through = now() - interval '30 minutes' where id = '${PROJECT_ID}'`,
  );

  assert.deepEqual(await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0 }), []);
});

test("a row younger than the commit lag is not unfolded yet: the reader will not read it until an open ingest transaction could have committed behind it", async () => {
  const { client, db } = await setup();
  await client.query(`
    insert into trace_events (id, project_id, type, session_id, client_event_id, payload, received_at)
    values (gen_random_uuid(), '${PROJECT_ID}', 'search', 's', 'c1', '{}'::jsonb, now() - interval '10 seconds')
  `);
  assert.deepEqual(await listProjectsWithUnfoldedEvents(db), [], "inside the 30-second lag");
  assert.deepEqual(await listProjectsWithUnfoldedEvents(db, { commitLagMs: 5_000 }), [
    { id: PROJECT_ID },
  ]);
});
