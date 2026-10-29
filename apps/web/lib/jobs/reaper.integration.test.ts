import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getJobForProject, listInFlightJobs, reapStaleRunningJobs } from "@/lib/jobs/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

/**
 * The zombie-job safety net against real PGlite: a job left stuck in `running` (a
 * crashed/timed-out handler) is reaped to `error` and no longer reported as in-flight,
 * so MCP `get_job_status` can't report it as running forever. A fresh running job is
 * untouched.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const JOB_STALE = "77777777-7777-4777-8777-777777777777";
const JOB_FRESH = "88888888-8888-4888-8888-888888888888";

type Db = NonNullable<Parameters<typeof reapStaleRunningJobs>[1]>;

async function setup(): Promise<Db> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a');
    insert into jobs (id, project_id, kind, status, payload, created_at, started_at) values
      ('${JOB_STALE}', '${PROJ}', 'match_quality_run', 'running',
        null, now() - interval '30 minutes', now() - interval '30 minutes'),
      ('${JOB_FRESH}', '${PROJ}', 'match_quality_run', 'running',
        null, now(), now());
  `);
  return drizzle(client, { schema }) as unknown as Db;
}

test("a stale running job is not reported as in-flight; a fresh one is", async () => {
  const db = await setup();
  const inFlight = await listInFlightJobs(PROJ, db);
  assert.deepEqual(
    inFlight,
    [{ jobId: JOB_FRESH, kind: "match_quality_run", status: "running" }],
    "only the fresh job counts as still running",
  );
});

test("reapStaleRunningJobs errors the zombie and leaves the fresh job running", async () => {
  const db = await setup();
  const reaped = await reapStaleRunningJobs(new Date(Date.now() - 10 * 60 * 1000), db);
  assert.equal(reaped, 1);

  const rows = await db.select().from(schema.jobs);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(JOB_STALE)?.status, "error");
  assert.ok(byId.get(JOB_STALE)?.finishedAt, "a reaped job is stamped finished");
  assert.equal(byId.get(JOB_FRESH)?.status, "running", "the fresh job is untouched");
});

test("a queued (never-started) job is not reaped — it's still waiting to run", async () => {
  const db = await setup();
  await db
    .update(schema.jobs)
    .set({ status: "queued", startedAt: null })
    .where(eq(schema.jobs.id, JOB_STALE));
  const reaped = await reapStaleRunningJobs(new Date(Date.now() - 10 * 60 * 1000), db);
  assert.equal(reaped, 0, "queued jobs are valid work, never zombies");
});

test("getJobForProject returns the job only to its owning project (Bearer isolation)", async () => {
  const db = await setup();
  const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
  const own = await getJobForProject(PROJ, JOB_FRESH, db);
  assert.equal(own?.id, JOB_FRESH);
  // A different project's key must not be able to poll this job.
  assert.equal(await getJobForProject(OTHER_PROJECT, JOB_FRESH, db), null);
  // A missing job id is a clean null, not a throw.
  assert.equal(await getJobForProject(PROJ, "00000000-0000-4000-8000-000000000000", db), null);
});
