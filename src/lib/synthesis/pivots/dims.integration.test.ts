import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { insertPivot } from "@/lib/ingest/pivots/store";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { enqueuePivotRefill, refillPivotDims } from "@/lib/synthesis/pivots/refill";
import { addPivot, type PivotSettingsDeps, removePivot } from "@/lib/synthesis/pivots/settings";
import {
  MAX_DIM_VALUE_CHARS,
  recomputeTraceSummaries,
} from "@/lib/synthesis/traces/summary-refresh";

/** RC-884: trace summaries carry the pivot values in `dims`; a pivot change refills them once per project. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BARE = "11111111-1111-4111-8111-111111111112";
const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type Db = ReturnType<typeof getDb>;

let next = 0;
interface SpanInput {
  project?: string;
  trace: string;
  parent?: string | null;
  at?: number;
  received?: number;
  attributes?: Record<string, unknown>;
}

async function span(client: PGlite, input: SpanInput): Promise<void> {
  next += 1;
  const at = new Date(input.at ?? NOW - 10 * MINUTE).toISOString();
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes, received_at)
     values ($1, $2, $3, $4, $5, 'step', 1, 'other', $6, $6, 1, 0, $7, $8)`,
    [
      `c0000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
      input.project ?? PROJECT,
      input.trace,
      `span${next}`,
      input.parent === undefined ? null : input.parent,
      at,
      JSON.stringify(input.attributes ?? {}),
      new Date(input.received ?? NOW - 5 * MINUTE).toISOString(),
    ],
  );
}

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${BARE}', '${ORG}', 'B', 'b');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

async function dims(client: PGlite, project = PROJECT): Promise<Record<string, unknown>> {
  const result = await client.query<{ trace_id: string; dims: unknown }>(
    `select trace_id, dims from otel_trace_summaries where project_id = $1 order by trace_id`,
    [project],
  );
  return Object.fromEntries(result.rows.map((row) => [row.trace_id, row.dims]));
}

const recompute = (db: Db, traces: string[], project = PROJECT) =>
  recomputeTraceSummaries(
    db,
    traces.map((traceId) => ({ projectId: project, traceId })),
  );

/** Every summary column but `updated_at`, by trace. */
async function summaryRows(client: PGlite, project = PROJECT): Promise<unknown[]> {
  const result = await client.query<{ row: unknown }>(
    `select to_jsonb(s) - 'updated_at' as row from otel_trace_summaries s where project_id = $1 order by trace_id`,
    [project],
  );
  return result.rows.map((entry) => entry.row);
}

/** Spans with `tenant.id`, written the same way into any database. */
async function seedTenantSpans(client: PGlite, project = PROJECT): Promise<void> {
  await span(client, {
    project,
    trace: "f1",
    attributes: { "tenant.id": "acme", "deployment.environment.name": "prod" },
  });
  await span(client, {
    project,
    trace: "f1",
    parent: "x",
    at: NOW - 9 * MINUTE,
    attributes: { "tenant.id": "acme" },
  });
  await span(client, { project, trace: "f2", attributes: { "tenant.id": "globex" } });
}

test("the sweep fills dims: root span first, the preset's key order, then the earliest span, values capped", async () => {
  const { client, db } = await setup();
  await insertPivot(
    PROJECT,
    { key: "client", label: "Client company", presetId: "client", position: 0 },
    db,
  );
  await insertPivot(
    PROJECT,
    { key: "customer.tier", label: "Tier", presetId: null, position: 1 },
    db,
  );

  // Root first: the root's tenant.id beats a child's enduser.org, the preset's first key.
  await span(client, { trace: "t1", attributes: { "tenant.id": "acme" } });
  await span(client, {
    trace: "t1",
    parent: "x",
    at: NOW - 20 * MINUTE,
    attributes: { "enduser.org": "child-org", "customer.tier": "gold" },
  });
  // The preset's key order on the root.
  await span(client, { trace: "t2", attributes: { "tenant.id": "t", "enduser.org": "e" } });
  // No root value: the earliest span that has one; an empty value is skipped.
  await span(client, { trace: "t3", attributes: { "tenant.id": "  " } });
  await span(client, {
    trace: "t3",
    parent: "x",
    at: NOW - 8 * MINUTE,
    attributes: { "tenant.id": "later" },
  });
  await span(client, {
    trace: "t3",
    parent: "x",
    at: NOW - 9 * MINUTE,
    attributes: { "tenant.id": "earlier" },
  });
  // A long value is capped; a trace with no value gets {}.
  await span(client, { trace: "t4", attributes: { "customer.tier": "z".repeat(300) } });
  await span(client, { trace: "t5", attributes: { other: "x" } });

  await recompute(db, ["t1", "t2", "t3", "t4", "t5"]);
  assert.deepEqual(await dims(client), {
    t1: { client: "acme", "customer.tier": "gold" },
    t2: { client: "e" },
    t3: { client: "earlier" },
    t4: { "customer.tier": "z".repeat(MAX_DIM_VALUE_CHARS) },
    t5: {},
  });
});

test("a project with no pivots gets {} and every summary column the no-pivot path writes", async () => {
  const { client, db } = await setup();
  await insertPivot(
    PROJECT,
    { key: "client", label: "Client", presetId: "client", position: 0 },
    db,
  );
  await seedTenantSpans(client, BARE);
  await span(client, { project: PROJECT, trace: "a1", attributes: { "tenant.id": "acme" } });
  // A chunk that holds both projects.
  await recomputeTraceSummaries(db, [
    { projectId: BARE, traceId: "f1" },
    { projectId: BARE, traceId: "f2" },
    { projectId: PROJECT, traceId: "a1" },
  ]);
  assert.deepEqual(await dims(client, PROJECT), { a1: { client: "acme" } });

  const baseline = await setup();
  await seedTenantSpans(baseline.client, BARE);
  await recompute(baseline.db, ["f1", "f2"], BARE);
  const rows = await summaryRows(client, BARE);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows, await summaryRows(baseline.client, BARE));
  assert.deepEqual(await dims(client, BARE), { f1: {}, f2: {} });
});

test("a pivot change queues one refill; the refill fills dims in the retention window, idempotent", async () => {
  const { client, db } = await setup();
  await span(client, { trace: "r1", attributes: { "tenant.id": "acme" } });
  await span(client, { trace: "r2", attributes: { "tenant.id": "globex" } });
  await span(client, {
    trace: "old",
    attributes: { "tenant.id": "gone" },
    received: NOW - 40 * DAY,
  });
  await recompute(db, ["r1", "r2", "old"]);
  assert.deepEqual(await dims(client), { old: {}, r1: {}, r2: {} });

  const deps: PivotSettingsDeps = {
    db,
    getActor: async () => ({ userId: "u1", externalId: "user_1" }),
    findScope: async () => ({ organizationId: ORG }),
    refill: (projectId) => enqueuePivotRefill(projectId, db),
  };
  assert.ok((await addPivot(PROJECT, { presetId: "client" }, deps)).ok);
  assert.ok((await addPivot(PROJECT, { key: "customer.tier" }, deps)).ok);
  const jobs = await client.query<{ id: string }>(
    `select id from jobs where kind = 'refill_pivot_dims' and project_id = $1`,
    [PROJECT],
  );
  assert.equal(jobs.rows.length, 1, "a second change while one is queued queues nothing");
  const jobId = jobs.rows[0]!.id;
  await client.query(`update jobs set status = 'running' where id = $1`, [jobId]);
  assert.ok((await removePivot(PROJECT, "customer.tier", deps)).ok);
  assert.equal(
    (await client.query(`select 1 from jobs where kind = 'refill_pivot_dims'`)).rows.length,
    1,
    "nor while one runs",
  );

  const first = await refillPivotDims(PROJECT, jobId, db);
  assert.deepEqual(
    { traces: first.traces, walks: first.walks, resumed: first.resumed },
    { traces: 2, walks: 1, resumed: false },
  );
  assert.deepEqual(
    await dims(client),
    { old: {}, r1: { client: "acme" }, r2: { client: "globex" } },
    "outside the window: left as is",
  );

  await client.query(`update jobs set status = 'done' where id = $1`, [jobId]);
  const again = await enqueuePivotRefill(PROJECT, db);
  assert.ok(again);
  await refillPivotDims(PROJECT, again.id, db);
  assert.deepEqual(await dims(client), {
    old: {},
    r1: { client: "acme" },
    r2: { client: "globex" },
  });
});

test("the refill resumes where a dead job stopped, and walks again when pivots change during it", async () => {
  const { client, db } = await setup();
  for (const trace of ["r1", "r2", "r3"])
    await span(client, {
      trace,
      attributes: { "tenant.id": `org-${trace}`, "customer.tier": "gold" },
    });
  await recompute(db, ["r1", "r2", "r3"]);
  await insertPivot(
    PROJECT,
    { key: "client", label: "Client", presetId: "client", position: 0 },
    db,
  );

  const dead = (await enqueuePivotRefill(PROJECT, db))!;
  await assert.rejects(
    refillPivotDims(PROJECT, dead.id, db, {
      batchSize: 1,
      onBatch: (progress) => {
        if (progress.batches === 1) throw new Error("worker died");
      },
    }),
  );
  // The first batch's position was not saved before the crash: one more batch to save it.
  await client.query(`update jobs set status = 'error' where id = $1`, [dead.id]);
  assert.deepEqual(await dims(client), { r1: { client: "org-r1" }, r2: {}, r3: {} });

  const stopped = (await enqueuePivotRefill(PROJECT, db))!;
  let batches = 0;
  await assert.rejects(
    refillPivotDims(PROJECT, stopped.id, db, {
      batchSize: 1,
      onBatch: () => {
        batches += 1;
        if (batches === 2) throw new Error("worker died");
      },
    }),
  );
  await client.query(`update jobs set status = 'error' where id = $1`, [stopped.id]);

  const resumed = (await enqueuePivotRefill(PROJECT, db))!;
  const result = await refillPivotDims(PROJECT, resumed.id, db, { batchSize: 1 });
  assert.equal(result.resumed, true);
  assert.equal(result.traces, 1, "only the trace after the saved position");
  assert.deepEqual(await dims(client), {
    r1: { client: "org-r1" },
    r2: { client: "org-r2" },
    r3: { client: "org-r3" },
  });

  // A pivot added during the walk: the job walks again with the new configuration.
  await client.query(`update jobs set status = 'done' where id = $1`, [resumed.id]);
  const changing = (await enqueuePivotRefill(PROJECT, db))!;
  let added = false;
  const rewalk = await refillPivotDims(PROJECT, changing.id, db, {
    batchSize: 1,
    onBatch: () => {
      if (added) return;
      added = true;
      void insertPivot(
        PROJECT,
        { key: "customer.tier", label: "Tier", presetId: null, position: 1 },
        db,
      );
    },
  });
  assert.equal(rewalk.walks, 2);
  assert.deepEqual(await dims(client), {
    r1: { client: "org-r1", "customer.tier": "gold" },
    r2: { client: "org-r2", "customer.tier": "gold" },
    r3: { client: "org-r3", "customer.tier": "gold" },
  });
});
