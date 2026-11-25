import assert from "node:assert/strict";
import { test } from "node:test";
import { claimNextQueuedJob, enqueueJob, oldestQueuedJobAgeQuery } from "@/lib/jobs/queries";
import { listProjectsDueTraceTurnBuild } from "@/lib/ledger/turns/queries";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import { clearHold, setHold } from "@/lib/platform/org-hold/store";
import { listProjectsWithUnfoldedEvents } from "@/lib/readings/intent-graph/queries";
import { enqueueDueQueryCategorizations } from "@/lib/readings/query-intents/queries";
import { refreshQualitySnapshots } from "@/lib/synthesis/quality/snapshot";
import { pruneExpiredOtelSpans } from "@/lib/synthesis/traces/queries";
import {
  acceptOnto,
  drain,
  envelopeHandler,
  ingestTraces,
  ORGANIZATION_ID,
  PROJECT_ID,
  setupDeployment,
  spoolQueue,
} from "./test-support";

/** An organization on hold: what it sends is stored, and nothing acts on it until the hold ends. */

const OTHER_ORG = "88888888-8888-4888-8888-888888888888";
const OTHER = "99999999-9999-4999-8999-999999999999";
const HOLD = { kind: "organization", organizationId: ORGANIZATION_ID } as const;

test("telemetry is stored, jobs wait, and clearing the hold starts them", async () => {
  const deployment = await setupDeployment();
  const { client, db } = deployment;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${OTHER_ORG}', 'Globex', 'globex');
    insert into projects (id, organization_id, name, slug) values ('${OTHER}', '${OTHER_ORG}', 'Agent', 'agent');
  `);
  await setHold(HOLD, db);
  const bodies = loadFixture("vercel-ai");
  const queue = spoolQueue(deployment);
  await ingestTraces(deployment, bodies, acceptOnto(queue));
  await drain(queue, envelopeHandler(deployment), bodies.length);
  await enqueueJob({ projectId: OTHER, kind: "categorize_queries" }, db);

  const stored = await client.query<{ n: number }>(
    `select count(*)::int as n from otel_spans where project_id = '${PROJECT_ID}'`,
  );
  assert.ok((stored.rows[0]?.n ?? 0) > 0, "the consumer stores what arrives");
  const queued = await client.query<{ n: number }>(
    `select count(*)::int as n from jobs where project_id = '${PROJECT_ID}' and status = 'queued'`,
  );
  assert.ok((queued.rows[0]?.n ?? 0) > 0, "its jobs are queued");

  assert.equal((await claimNextQueuedJob(undefined, undefined, db))?.projectId, OTHER);
  assert.equal(await claimNextQueuedJob(undefined, undefined, db), null);
  assert.equal(await claimNextQueuedJob(PROJECT_ID, undefined, db), null);
  await client.exec(
    `update jobs set created_at = now() - interval '1 day' where project_id = '${PROJECT_ID}'`,
  );
  const lag = await db.execute<{ age_ms: string | null }>(oldestQueuedJobAgeQuery());
  assert.equal(lag.rows[0]?.age_ms ?? null, null, "a job that waits out a hold is not a lag");

  assert.equal(await clearHold(HOLD, db), 1);
  assert.equal((await claimNextQueuedJob(undefined, undefined, db))?.projectId, PROJECT_ID);
});

test("the scheduled sweeps skip a held project and take the other", async () => {
  const deployment = await setupDeployment();
  const { client, db } = deployment;
  const bodies = loadFixture("vercel-ai");
  await ingestTraces(deployment, bodies);
  await client.exec(`
    insert into organizations (id, name, slug) values ('${OTHER_ORG}', 'Globex', 'globex');
    insert into projects (id, organization_id, name, slug) values ('${OTHER}', '${OTHER_ORG}', 'Agent', 'agent');
    create temp table copied as select * from trace_events;
    update copied set id = gen_random_uuid(), project_id = '${OTHER}';
    insert into trace_events select * from copied;
    update projects set intent_graph_folded_through = '2026-01-01', trace_turns_built_through = '2026-01-01';
    delete from jobs;
    update trace_events set type = 'search', query = 'q', ingest_source = 'runtime', occurred_at = now() - interval '1 hour';
  `);
  const before = await candidates();
  for (const [name, ids] of Object.entries(before)) {
    assert.deepEqual(ids, [PROJECT_ID, OTHER].sort(), name);
  }
  await setHold(HOLD, db);
  for (const [name, ids] of Object.entries(await candidates())) {
    assert.deepEqual(ids, [OTHER], name);
  }
  assert.deepEqual(await enqueueDueQueryCategorizations(db, 1), { enqueued: 1 });

  await client.exec(`update otel_spans set received_at = now() - interval '90 days'`);
  assert.equal(await pruneExpiredOtelSpans({}, db), 0);
  await refreshQualitySnapshots({ db, force: true });
  await clearHold(HOLD, db);
  assert.ok((await pruneExpiredOtelSpans({}, db)) > 0);

  async function candidates(): Promise<Record<string, string[]>> {
    const ids = (rows: { id: string }[]) => rows.map(({ id }) => id).sort();
    return {
      builds: ids(await listProjectsDueTraceTurnBuild(db)),
      folds: ids(await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0, retentionDays: 400 })),
    };
  }
});
