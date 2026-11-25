import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as tables from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  claimNextIngestBatch,
  enqueueIngestBatch,
  failIngestBatch,
  markIngestBatchDone,
  pruneIngestBatches,
  readIngestQueueStats,
  reapStaleIngestBatches,
  retryIngestBatch,
} from "./queries";
import * as queueSchema from "./schema";

/** RTL-314 against real PGlite: the durable batch queue, its fair claim and its housekeeping. */

const ORG = "22222222-2222-4222-8222-222222222222";
const BUSY = "11111111-1111-4111-8111-111111111111";
const QUIET = "33333333-3333-4333-8333-333333333333";
type Db = ReturnType<typeof getDb>;

async function setup(): Promise<{ db: Db; client: PGlite }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${BUSY}', '${ORG}', 'Busy', 'busy'), ('${QUIET}', '${ORG}', 'Quiet', 'quiet');
  `);
  const db = drizzle(client, { schema: { ...tables, ...queueSchema } }) as unknown as Db;
  return { db, client };
}

const body = (text: string) => new TextEncoder().encode(text);

function batch(projectId: string, text = "{}") {
  return {
    projectId,
    signal: "traces" as const,
    contentType: "application/json",
    contentEncoding: null,
    body: body(text),
    context: { appendOnly: false },
  };
}

async function backdate(client: PGlite, id: string, minutes: number): Promise<void> {
  await client.query(
    `update ingest_batches set received_at = now() - make_interval(mins => $2::int) where id = $1`,
    [id, minutes],
  );
}

test("a queued batch keeps its bytes and context, and the claim hands them back once", async () => {
  const { db } = await setup();
  const { id } = await enqueueIngestBatch(
    { ...batch(BUSY, '{"resourceSpans":[]}'), context: { appendOnly: true } },
    db,
  );
  const claimed = await claimNextIngestBatch(db, { perProject: 1 });
  assert.equal(claimed?.id, id);
  assert.equal(claimed?.projectId, BUSY);
  assert.equal(claimed?.signal, "traces");
  assert.equal(claimed?.contentType, "application/json");
  assert.equal(claimed?.contentEncoding, null);
  assert.equal(new TextDecoder().decode(claimed?.body), '{"resourceSpans":[]}');
  assert.deepEqual(claimed?.context, { appendOnly: true });
  assert.equal(claimed?.attempts, 1);
  assert.ok(claimed?.receivedAt instanceof Date);
  assert.equal(await claimNextIngestBatch(db, { perProject: 0 }), null, "claimed only once");
});

test("a project with a backlog at its cap waits while the quiet project's batch is claimed", async () => {
  const { db, client } = await setup();
  for (let n = 0; n < 5; n++) {
    const { id } = await enqueueIngestBatch(batch(BUSY), db);
    await backdate(client, id, 60 - n);
  }
  await enqueueIngestBatch(batch(QUIET), db);

  const first = await claimNextIngestBatch(db, { perProject: 1 });
  assert.equal(first?.projectId, BUSY, "the oldest batch first");
  const second = await claimNextIngestBatch(db, { perProject: 1 });
  assert.equal(second?.projectId, QUIET, "the busy project is at its cap");
  assert.equal(await claimNextIngestBatch(db, { perProject: 1 }), null, "both at their cap");
  assert.equal((await claimNextIngestBatch(db, { perProject: 2 }))?.projectId, BUSY);
  assert.equal((await claimNextIngestBatch(db, { perProject: 0 }))?.projectId, BUSY, "0: no cap");
});

test("the projects a drainer just served go last, even with older batches", async () => {
  const { db, client } = await setup();
  for (let n = 0; n < 3; n++) {
    const { id } = await enqueueIngestBatch(batch(BUSY), db);
    await backdate(client, id, 60 - n);
  }
  await enqueueIngestBatch(batch(QUIET), db);
  const next = await claimNextIngestBatch(db, { perProject: 0, avoidProjects: [BUSY] });
  assert.equal(next?.projectId, QUIET);
  const after = await claimNextIngestBatch(db, { perProject: 0, avoidProjects: [BUSY, QUIET] });
  assert.equal(after?.projectId, BUSY, "ordering, not a filter: it still runs");
});

test("round robin: with every project served, the one served longest ago goes first", async () => {
  const { db, client } = await setup();
  for (let n = 0; n < 3; n++) {
    const { id } = await enqueueIngestBatch(batch(BUSY), db);
    await backdate(client, id, 60 - n);
  }
  await enqueueIngestBatch(batch(QUIET), db);
  // The drainer served QUIET, then BUSY: BUSY's older backlog must not win again.
  const next = await claimNextIngestBatch(db, { perProject: 0, avoidProjects: [QUIET, BUSY] });
  assert.equal(next?.projectId, QUIET);
});

test("a done batch drops its bytes and frees its project's slot", async () => {
  const { db, client } = await setup();
  await enqueueIngestBatch(batch(BUSY, "x".repeat(1000)), db);
  await enqueueIngestBatch(batch(BUSY), db);
  const claimed = await claimNextIngestBatch(db, { perProject: 1 });
  assert.ok(claimed);
  await markIngestBatchDone(claimed.id, claimed.attempts, { accepted: 3 }, db);
  const row = await client.query<{ status: string; body_len: number; result: unknown }>(
    `select status, length(body) as body_len, result from ingest_batches where id = $1`,
    [claimed.id],
  );
  assert.deepEqual(row.rows[0], { status: "done", body_len: 0, result: { accepted: 3 } });
  assert.ok(await claimNextIngestBatch(db, { perProject: 1 }), "the slot is free again");
});

test("a failed try goes back to the queue after a backoff, and past its tries is marked failed", async () => {
  const { db, client } = await setup();
  const { id } = await enqueueIngestBatch(batch(BUSY), db);
  const first = await claimNextIngestBatch(db, { perProject: 1 });
  assert.equal(first?.id, id);
  assert.equal(
    await retryIngestBatch(id, 1, "db down", { maxAttempts: 2, backoffMs: 60_000 }, db),
    "queued",
  );
  assert.equal(await claimNextIngestBatch(db, { perProject: 1 }), null, "waits out its backoff");
  await client.query(`update ingest_batches set available_at = now() where id = $1`, [id]);
  const second = await claimNextIngestBatch(db, { perProject: 1 });
  assert.equal(second?.attempts, 2);
  assert.equal(
    await retryIngestBatch(id, 2, "db down again", { maxAttempts: 2, backoffMs: 0 }, db),
    "failed",
  );
  const row = await client.query<{ status: string; error: string; finished: boolean }>(
    `select status, error, finished_at is not null as finished from ingest_batches where id = $1`,
    [id],
  );
  assert.deepEqual(row.rows[0], { status: "failed", error: "db down again", finished: true });
});

test("a permanent failure is marked failed at once and keeps its bytes for an operator", async () => {
  const { db, client } = await setup();
  const { id } = await enqueueIngestBatch(batch(BUSY, "garbage"), db);
  await claimNextIngestBatch(db, { perProject: 1 });
  await failIngestBatch(id, 1, "malformed: bad json", db);
  const row = await client.query<{ status: string; error: string; body_len: number }>(
    `select status, error, length(body) as body_len from ingest_batches where id = $1`,
    [id],
  );
  assert.deepEqual(row.rows[0], { status: "failed", error: "malformed: bad json", body_len: 7 });
});

test("the reaper puts a batch stuck in running back in the queue, or fails it past its tries", async () => {
  const { db, client } = await setup();
  const { id: stuck } = await enqueueIngestBatch(batch(BUSY), db);
  const { id: worn } = await enqueueIngestBatch(batch(QUIET), db);
  const { id: fresh } = await enqueueIngestBatch(batch(QUIET), db);
  await client.exec(`
    update ingest_batches set status = 'running', attempts = 1, started_at = now() - interval '20 minutes' where id = '${stuck}';
    update ingest_batches set status = 'running', attempts = 3, started_at = now() - interval '20 minutes' where id = '${worn}';
    update ingest_batches set status = 'running', attempts = 1, started_at = now() where id = '${fresh}';
  `);
  const reaped = await reapStaleIngestBatches(5 * 60_000, 3, db);
  assert.deepEqual(reaped, { requeued: 1, failed: 1 });
  const rows = await client.query<{ id: string; status: string }>(
    `select id, status from ingest_batches order by received_at`,
  );
  const status = Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
  assert.deepEqual(status, { [stuck]: "queued", [worn]: "failed", [fresh]: "running" });
});

test("a late outcome from a try the reaper took back changes nothing", async () => {
  const { db, client } = await setup();
  const { id } = await enqueueIngestBatch(batch(BUSY, "payload"), db);
  const first = await claimNextIngestBatch(db, { perProject: 1 });
  assert.equal(first?.attempts, 1);
  await client.query(
    `update ingest_batches set started_at = now() - interval '20 minutes' where id = $1`,
    [id],
  );
  await reapStaleIngestBatches(5 * 60_000, 5, db);
  const second = await claimNextIngestBatch(db, { perProject: 1 });
  assert.equal(second?.attempts, 2);
  // The first try finishes late, while the second runs: none of its outcomes may touch the row.
  await failIngestBatch(id, 1, "late failure", db);
  assert.equal(
    await retryIngestBatch(id, 1, "late retry", { maxAttempts: 5, backoffMs: 0 }, db),
    "lost",
  );
  await markIngestBatchDone(id, 1, { accepted: 0 }, db);
  await markIngestBatchDone(id, 2, { accepted: 1 }, db);
  const row = await client.query<{ status: string; result: unknown; error: string | null }>(
    `select status, result, error from ingest_batches where id = $1`,
    [id],
  );
  assert.deepEqual(row.rows[0], { status: "done", result: { accepted: 1 }, error: null });
});

test("a batch orphaned in running does not hold its project's slot while it waits for the reaper", async () => {
  const { db, client } = await setup();
  const { id: orphan } = await enqueueIngestBatch(batch(BUSY), db);
  await enqueueIngestBatch(batch(BUSY), db);
  await client.query(
    `update ingest_batches set status = 'running', attempts = 1, started_at = now() - interval '6 minutes' where id = $1`,
    [orphan],
  );
  assert.equal((await claimNextIngestBatch(db, { perProject: 1 }))?.projectId, BUSY);
});

test("retention deletes done batches after an hour and failed ones after a week, nothing queued", async () => {
  const { db, client } = await setup();
  const ids: Record<string, string> = {};
  for (const name of ["oldDone", "newDone", "oldFailed", "newFailed", "oldQueued"]) {
    ids[name] = (await enqueueIngestBatch(batch(BUSY), db)).id;
  }
  await client.exec(`
    update ingest_batches set status = 'done', finished_at = now() - interval '2 hours' where id = '${ids.oldDone}';
    update ingest_batches set status = 'done', finished_at = now() - interval '10 minutes' where id = '${ids.newDone}';
    update ingest_batches set status = 'failed', finished_at = now() - interval '8 days' where id = '${ids.oldFailed}';
    update ingest_batches set status = 'failed', finished_at = now() - interval '2 days' where id = '${ids.newFailed}';
    update ingest_batches set received_at = now() - interval '30 days' where id = '${ids.oldQueued}';
  `);
  assert.equal(await pruneIngestBatches(db), 2);
  const rows = await client.query<{ id: string }>(`select id from ingest_batches`);
  assert.deepEqual(
    new Set(rows.rows.map((r) => r.id)),
    new Set([ids.newDone, ids.newFailed, ids.oldQueued]),
  );
});

test("queue stats: depth, running, oldest age and recent failures per project", async () => {
  const { db, client } = await setup();
  for (let n = 0; n < 3; n++) {
    const { id } = await enqueueIngestBatch(batch(BUSY), db);
    await backdate(client, id, 10 - n);
  }
  await claimNextIngestBatch(db, { perProject: 1 });
  const { id: failed } = await enqueueIngestBatch(batch(QUIET), db);
  await client.exec(
    `update ingest_batches set status = 'failed', finished_at = now() where id = '${failed}'`,
  );
  const stats = await readIngestQueueStats(db);
  const busy = stats.find((s) => s.projectId === BUSY);
  const quiet = stats.find((s) => s.projectId === QUIET);
  assert.equal(busy?.queued, 2);
  assert.equal(busy?.running, 1);
  assert.ok(
    busy && busy.oldestAgeMs !== null && busy.oldestAgeMs >= 9 * 60_000,
    "the oldest waiting",
  );
  assert.equal(busy?.failedLastHour, 0);
  assert.deepEqual(
    {
      queued: quiet?.queued,
      running: quiet?.running,
      oldest: quiet?.oldestAgeMs,
      failed: quiet?.failedLastHour,
    },
    { queued: 0, running: 0, oldest: null, failed: 1 },
  );
});
