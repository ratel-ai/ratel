import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { BARE_TRACE, ingestSessionUserExport, TRACE } from "@/lib/ingest/otlp/test-support";
import { setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { refreshTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";
import {
  backfillSessionUserIds,
  sessionUserBackfillOptionsFromArgs,
} from "./session-user-backfill";

/**
 * The backfill against a real schema: spans and summaries stored before
 * migration 0056 (no session or end-user value) get the values ingest and the
 * sweep give the same export, read from `trace_events` by trace id.
 */

async function snapshot(client: PGlite): Promise<{ spans: unknown[]; summaries: unknown[] }> {
  const spans = await client.query(
    `select span_id, session_id, end_user_id, received_at from otel_spans order by span_id`,
  );
  const summaries = await client.query(
    `select trace_id, session_id, end_user_id, updated_at from otel_trace_summaries order by trace_id`,
  );
  return { spans: spans.rows, summaries: summaries.rows };
}

/** The rows as they were before migration 0056. */
async function forgetIds(client: PGlite): Promise<void> {
  await client.exec(`
    update otel_spans set session_id = null, end_user_id = null;
    update otel_trace_summaries set session_id = null, end_user_id = null;
  `);
}

test("the backfill gives old spans and summaries the ingest values, and a second run changes nothing", async () => {
  const { client, db } = await setupDb();
  await ingestSessionUserExport(db);
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  const atIngest = await snapshot(client);
  assert.deepEqual(
    (atIngest.summaries as Array<Record<string, unknown>>).map((row) => [
      row.trace_id,
      row.session_id,
      row.end_user_id,
    ]),
    [
      [TRACE, "conv-42", "user-7"],
      [BARE_TRACE, null, null],
    ],
  );
  await forgetIds(client);
  const forgotten = await snapshot(client);

  const dryRun = await backfillSessionUserIds(db, { batchSize: 1 });
  assert.deepEqual(dryRun, { traces: 1, spans: 2, summaries: 1, batches: 1 });
  assert.deepEqual(await snapshot(client), forgotten, "a dry run writes nothing");

  const batches: number[] = [];
  const first = await backfillSessionUserIds(db, {
    apply: true,
    batchSize: 1,
    onBatch: (progress) => batches.push(progress.traces),
  });
  assert.deepEqual(first, { traces: 1, spans: 2, summaries: 1, batches: 1 });
  assert.deepEqual(batches, [1]);
  // The same values, and received_at and updated_at kept: neither sweep runs again.
  assert.deepEqual(await snapshot(client), atIngest);

  const second = await backfillSessionUserIds(db, { apply: true, batchSize: 1 });
  assert.deepEqual(second, { traces: 1, spans: 0, summaries: 0, batches: 1 });
  assert.deepEqual(await snapshot(client), atIngest);
  await client.close();
});

test("the backfill keeps a value ingest wrote and stays in its project", async () => {
  const { client, db } = await setupDb();
  await ingestSessionUserExport(db);
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  await client.exec(`
    update otel_spans set end_user_id = null;
    update otel_spans set session_id = 'kept' where parent_span_id is null;
    update otel_trace_summaries set end_user_id = null;
  `);

  const other = await backfillSessionUserIds(db, {
    apply: true,
    projectId: "33333333-3333-4333-8333-333333333333",
  });
  assert.deepEqual(other, { traces: 0, spans: 0, summaries: 0, batches: 0 });

  await backfillSessionUserIds(db, { apply: true });
  const { rows } = await client.query(
    `select parent_span_id is null as root, session_id, end_user_id from otel_spans
     where trace_id = $1 order by root desc`,
    [TRACE],
  );
  assert.deepEqual(rows, [
    { root: true, session_id: "kept", end_user_id: "user-7" },
    { root: false, session_id: "conv-42", end_user_id: "user-7" },
  ]);
  const summary = await client.query(
    `select session_id, end_user_id from otel_trace_summaries where trace_id = $1`,
    [TRACE],
  );
  assert.deepEqual(summary.rows, [{ session_id: "conv-42", end_user_id: "user-7" }]);
  await client.close();
});

test("the arguments: a dry run by default, --apply to write", () => {
  assert.deepEqual(sessionUserBackfillOptionsFromArgs([]), { apply: false, batchSize: 500 });
  assert.deepEqual(
    sessionUserBackfillOptionsFromArgs(["--apply", "--project", "p-1", "--batch-size", "10"]),
    { apply: true, batchSize: 10, projectId: "p-1" },
  );
  assert.throws(() => sessionUserBackfillOptionsFromArgs(["--apply", "--dry-run"]));
  assert.throws(() => sessionUserBackfillOptionsFromArgs(["--batch-size", "0"]));
  assert.throws(() => sessionUserBackfillOptionsFromArgs(["--project"]));
});
