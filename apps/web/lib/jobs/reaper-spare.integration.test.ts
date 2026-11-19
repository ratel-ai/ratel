import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { reapStaleRunningJobs } from "@/lib/jobs/queries";
import { jobs } from "@/lib/jobs/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

/**
 * The reaper's spare list against real PGlite: upstream spares a running import whose own
 * heartbeat is fresh (`reapStaleRunningJobs`, `lib/db/queries.ts`); here the edition names such
 * jobs (`Registration.liveJobs`) and the reaper leaves them running.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const JOB_LIVE = "66666666-6666-4666-8666-666666666666";
const JOB_DEAD = "77777777-7777-4777-8777-777777777777";

type Db = NonNullable<Parameters<typeof reapStaleRunningJobs>[1]>;

async function setup(): Promise<Db> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a');
    insert into jobs (id, project_id, kind, status, payload, created_at, started_at) values
      ('${JOB_LIVE}', '${PROJ}', 'run_import', 'running',
        null, now() - interval '30 minutes', now() - interval '30 minutes'),
      ('${JOB_DEAD}', '${PROJ}', 'run_import', 'running',
        null, now() - interval '30 minutes', now() - interval '30 minutes');
  `);
  return drizzle(client, { schema }) as unknown as Db;
}

test("a stale running job named as alive is spared; the other is reaped", async () => {
  const db = await setup();
  const reaped = await reapStaleRunningJobs(new Date(Date.now() - 10 * 60 * 1000), db, [JOB_LIVE]);
  assert.equal(reaped, 1);
  const status = new Map((await db.select().from(jobs)).map((row) => [row.id, row.status]));
  assert.equal(status.get(JOB_LIVE), "running");
  assert.equal(status.get(JOB_DEAD), "error");
});

test("with nothing to spare, every stale running job is reaped", async () => {
  const db = await setup();
  assert.equal(await reapStaleRunningJobs(new Date(Date.now() - 10 * 60 * 1000), db), 2);
});
