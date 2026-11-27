import assert from "node:assert/strict";
import { test } from "node:test";
import { metricQuery } from "@/lib/contracts/query";
import { claimNextQueuedJob, enqueueJob, oldestQueuedJobAgeQuery } from "@/lib/jobs/queries";
import { listProjectsDueTraceTurnBuild } from "@/lib/ledger/turns/queries";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import { clearHold, setHold } from "@/lib/platform/org-hold/store";
import { listProjectsWithUnfoldedEvents } from "@/lib/readings/intent-graph/queries";
import { enqueueDueQueryCategorizations } from "@/lib/readings/query-intents/queries";
import { metricSeams } from "@/lib/synthesis/metrics/query";
import { refreshQualitySnapshots } from "@/lib/synthesis/quality/snapshot";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import { pruneExpiredOtelSpans } from "@/lib/synthesis/traces/queries";
import { evaluateAlerts } from "@/lib/views/alerts/evaluate";
import { createAlertRule } from "@/lib/views/alerts/store";
import type { AlertDraft } from "@/lib/views/alerts/types";
import { sweepScorers } from "@/lib/views/scorers/sweep";
import { persistIngestBatch } from "./persist";
import { claimNextIngestBatch, enqueueIngestBatch, markIngestBatchDone } from "./queries";
import {
  drain,
  envelopeHandler,
  ingestTraces,
  ORGANIZATION_ID,
  PROJECT_ID,
  persistDeps,
  setupDeployment,
  testQueue,
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
  const queue = testQueue();
  await ingestTraces(deployment, bodies, queue);
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

test("ADR-0009's lane stores a held organization's batches too, and their jobs wait", async () => {
  const deployment = await setupDeployment();
  const { client, db } = deployment;
  await setHold(HOLD, db);
  const bodies = loadFixture("vercel-ai");
  for (const body of bodies) {
    await enqueueIngestBatch(
      {
        projectId: PROJECT_ID,
        signal: "traces",
        contentType: body.contentType,
        contentEncoding: null,
        body: body.bytes,
        context: {},
      },
      db,
    );
  }
  let persisted = 0;
  for (;;) {
    const batch = await claimNextIngestBatch(db, { perProject: 1 });
    if (!batch) break;
    assert.equal((await persistIngestBatch(batch, persistDeps(deployment))).kind, "done");
    await markIngestBatchDone(batch.id, batch.attempts, {}, db);
    persisted += 1;
  }
  assert.equal(persisted, bodies.length);
  const { rows } = await client.query<{ spans: number; jobs: number }>(`
    select (select count(*)::int from otel_spans where project_id = '${PROJECT_ID}') as spans,
      (select count(*)::int from jobs where project_id = '${PROJECT_ID}' and status = 'queued') as jobs`);
  assert.ok((rows[0]?.spans ?? 0) > 0 && (rows[0]?.jobs ?? 0) > 0);
  assert.equal(await claimNextQueuedJob(PROJECT_ID, undefined, db), null);
  await clearHold(HOLD, db);
  assert.equal((await claimNextQueuedJob(PROJECT_ID, undefined, db))?.projectId, PROJECT_ID);
  await client.close();
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

test("alerts and scorers of a held project wait, and go on after the hold", async (t) => {
  const { client, db } = await setupDeployment();
  // Each alert rule reads through RQL: run it on this database.
  const sql = metricSeams.sql;
  t.after(() => {
    metricSeams.sql = sql;
  });
  metricSeams.sql = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(client)),
      gate: createRqlGate(),
      observe: async () => {},
    },
    alertGate: createRqlGate(1),
  });
  const query = JSON.stringify(metricQuery("error_rate", "rate"));
  const draft: AlertDraft = {
    name: "Errors",
    query: JSON.parse(query),
    operator: "above",
    threshold: 0.5,
    windowMinutes: 5,
    destinationIds: [],
  };
  assert.ok(await createAlertRule(PROJECT_ID, draft, "user", db));
  await client.exec(`
    insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
    values ('${PROJECT_ID}', 'Fast', 'check', '{"path":"duration_ms","op":"lt","value":10}', 'u', 'u')`);
  const on = async () => true;
  const taken = async () => {
    await client.exec("update alert_rules set last_evaluated_at = null");
    return [
      (await evaluateAlerts({ flagOn: on }, db)).evaluated,
      (await sweepScorers({ flagOn: on }, db)).scorers,
    ];
  };
  assert.deepEqual(await taken(), [1, 1]);
  await setHold(HOLD, db);
  assert.deepEqual(await taken(), [0, 0]);
  await clearHold(HOLD, db);
  assert.deepEqual(await taken(), [1, 1]);
  await client.close();
});

test("held before it exists: what arrives with it is swept by nothing, and its telemetry is stored", async () => {
  const deployment = await setupDeployment();
  const { client, db } = deployment;
  // As before a copy: the organization is not here, its hold is.
  await client.exec(`
    delete from projects where id = '${PROJECT_ID}';
    delete from organizations where id = '${ORGANIZATION_ID}'`);
  await setHold(HOLD, db);
  await client.exec(`begin;
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme'), ('${OTHER_ORG}', 'Globex', 'globex');
    insert into projects (id, organization_id, name, slug, intent_graph_folded_through, trace_turns_built_through) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent', '2026-01-01', '2026-01-01'),
      ('${OTHER}', '${OTHER_ORG}', 'Agent', 'agent', '2026-01-01', '2026-01-01');
    insert into jobs (project_id, kind, status) values ('${PROJECT_ID}', 'x', 'queued');
    commit;`);
  const bodies = loadFixture("vercel-ai");
  const queue = testQueue();
  for (const body of bodies) {
    await queue.publish({
      version: 1,
      id: crypto.randomUUID(),
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      keyId: crypto.randomUUID(),
      keyPolicy: { appendOnlyIngest: false, sharedKeyLimits: false },
      signal: "traces",
      contentType: body.contentType as "application/json",
      contentEncoding: "identity",
      receivedAt: Date.now(),
      body: body.bytes,
    });
  }
  await drain(queue, envelopeHandler(deployment), bodies.length);
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from otel_spans where project_id = '${PROJECT_ID}'`,
  );
  assert.ok((rows[0]?.n ?? 0) > 0, "the consumer stores what arrives");

  assert.equal(await claimNextQueuedJob(undefined, undefined, db), null);
  assert.equal(await claimNextQueuedJob(PROJECT_ID, undefined, db), null);
  await client.exec(`
    update trace_events set type = 'search', query = 'q', ingest_source = 'runtime', occurred_at = now() - interval '1 hour'`);
  const due = async () => {
    const folds = await listProjectsWithUnfoldedEvents(db, { commitLagMs: 0, retentionDays: 400 });
    const builds = await listProjectsDueTraceTurnBuild(db);
    return [folds, builds].map((rows) => rows.some(({ id }) => id === PROJECT_ID));
  };
  assert.deepEqual(await due(), [false, false]);
  assert.deepEqual(await enqueueDueQueryCategorizations(db, 1), { enqueued: 0 });
  await client.exec(`update otel_spans set received_at = now() - interval '90 days'`);
  assert.equal(await pruneExpiredOtelSpans({}, db), 0);

  await client.exec("delete from jobs");
  await clearHold(HOLD, db);
  assert.deepEqual(await due(), [true, true], "only the hold kept them away");
  assert.ok((await pruneExpiredOtelSpans({}, db)) > 0);
});
