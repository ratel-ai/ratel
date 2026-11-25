import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  claimNextQueuedJob,
  oldestQueuedJobAgeQuery,
  readJobQueueClock,
  readOldestQueuedJobAgeMs,
} from "@/lib/jobs/queries";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

/**
 * The drain's claim bound against real PGlite: a job queued after the drain read
 * the queue clock is left for the next drain, and one queued before it is claimed.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const JOB_OLD = "77777777-7777-4777-8777-777777777777";
const JOB_NEW = "88888888-8888-4888-8888-888888888888";

type Db = ReturnType<typeof getDb>;

async function setup(): Promise<Db> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a');
    insert into jobs (id, project_id, kind, status, created_at) values
      ('${JOB_OLD}', '${PROJ}', 'explore_tool_usage', 'queued', now() - interval '1 minute');
  `);
  return drizzle(client, { schema }) as unknown as Db;
}

test("the queue clock reads the database's time", async () => {
  const db = await setup();
  const before = Date.now();
  const at = await readJobQueueClock(db);
  assert.ok(Math.abs(at.getTime() - before) < 60_000, "close to now");
});

test("a job queued after the bound is not claimed; one queued before it is", async () => {
  const db = await setup();
  const createdBefore = await readJobQueueClock(db);
  await db.insert(jobs).values({
    id: JOB_NEW,
    projectId: PROJ,
    kind: "craft_tools",
    status: "queued",
    createdAt: new Date(createdBefore.getTime() + 1000),
  });

  // The per-project running cap is not what this test is about.
  const noCap = { runningPerProject: 0 };
  const first = await claimNextQueuedJob(PROJ, createdBefore, db, noCap);
  assert.equal(first?.id, JOB_OLD);
  assert.equal(
    await claimNextQueuedJob(PROJ, createdBefore, db, noCap),
    null,
    "the newer job waits for the next drain",
  );
  const unbounded = await claimNextQueuedJob(PROJ, undefined, db, noCap);
  assert.equal(unbounded?.id, JOB_NEW, "without a bound it is claimed");
});

test("the oldest queued job's age is measured on the database clock, and null once nothing waits", async () => {
  const db = await setup();
  await db.execute(sql`update jobs set kind = 'build_trace_turns' where id = ${JOB_OLD}`);
  const age = await readOldestQueuedJobAgeMs(db);
  assert.ok(age !== null && age >= 59_000 && age < 120_000, `about a minute, got ${age}`);

  await claimNextQueuedJob(PROJ, undefined, db);
  assert.equal(await readOldestQueuedJobAgeMs(db), null, "a running job is not queue lag");
});

test("queue lag leaves out the jobs that wait on purpose: tier 2 sweeps, kinds it does not know, and imports", async () => {
  const db = await setup(); // explore_tool_usage (tier 2), a minute old.
  await db.execute(sql`
    insert into jobs (project_id, kind, status, created_at) values
      (${PROJ}, 'categorize_queries', 'queued', now() - interval '3 hours'),
      (${PROJ}, 'kind_of_a_newer_deploy', 'queued', now() - interval '3 hours'),
      (${PROJ}, 'run_import', 'queued', now() - interval '3 hours')`);
  assert.equal(await readOldestQueuedJobAgeMs(db), null);

  await db.execute(
    sql`insert into jobs (project_id, kind, status, created_at) values (${PROJ}, 'draft_fix', 'queued', now() - interval '2 minutes')`,
  );
  const tier0 = await readOldestQueuedJobAgeMs(db);
  assert.ok(
    tier0 !== null && tier0 >= 119_000 && tier0 < 180_000,
    `tier 0, about two minutes, got ${tier0}`,
  );

  await db.execute(
    sql`insert into jobs (project_id, kind, status, created_at) values (${PROJ}, 'build_trace_turns', 'queued', now() - interval '5 minutes')`,
  );
  const tier1 = await readOldestQueuedJobAgeMs(db);
  assert.ok(
    tier1 !== null && tier1 >= 299_000 && tier1 < 360_000,
    `tier 1, about five minutes, got ${tier1}`,
  );
});

test("queue lag still counts a job that a per-project cap holds back: no column says why a job waits", async () => {
  const db = await setup();
  await db.execute(sql`
    insert into jobs (project_id, kind, status, started_at, created_at) values (${PROJ}, 'label_workflows', 'running', now(), now());
    `);
  await db.execute(
    sql`insert into jobs (project_id, kind, status, created_at) values (${PROJ}, 'assign_topics', 'queued', now() - interval '4 minutes')`,
  );
  assert.equal(
    await claimNextQueuedJob(PROJ, undefined, db, { runningPerProject: 1 }),
    null,
    "the cap holds it",
  );
  const age = await readOldestQueuedJobAgeMs(db);
  assert.ok(age !== null && age >= 239_000, `the held job counts, got ${age}`);
});

// The planner picks the index from the table statistics: the same query reads
// `jobs_status_created_idx` at the first size and `jobs_project_status_idx` at the
// second. So the test pins what stays true, and no planner setting is forced.
for (const finished of [20_000, 100_000]) {
  test(`the queue lag read reaches the queued rows through an index on status, with ${finished} finished jobs and no planner setting forced`, async () => {
    const db = await setup();
    await db.execute(sql`
      insert into jobs (project_id, kind, status, created_at)
      select ${PROJ}, 'explore_tool_usage', 'done', now() - (g || ' seconds')::interval from generate_series(1, ${finished}::int) g`);
    await db.execute(sql`
      insert into jobs (project_id, kind, status, created_at)
      select ${PROJ}, 'categorize_queries', 'queued', now() - (g || ' seconds')::interval from generate_series(1, 3000) g`);
    await db.execute(
      sql`insert into jobs (project_id, kind, status, created_at) values (${PROJ}, 'label_workflows', 'queued', now() - interval '1 minute')`,
    );
    await db.execute(sql`analyze jobs`);

    const plan = await db.execute(sql`explain ${oldestQueuedJobAgeQuery()}`);
    const text = (plan.rows as Array<{ "QUERY PLAN": string }>)
      .map((row) => row["QUERY PLAN"])
      .join("\n");

    assert.doesNotMatch(text, /Seq Scan/);
    assert.match(text, /Index Scan (on|using) jobs_(project_status|status_created)_idx/);
    assert.match(text, /Index Cond: \(status = 'queued'::text\)/);
    assert.match(text, /Filter: \(kind = ANY/, "no index holds the kind");
  });
}
