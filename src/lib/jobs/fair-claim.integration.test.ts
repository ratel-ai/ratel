import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { claimNextQueuedJob, jobsRunningPerProject, markJobDone } from "@/lib/jobs/queries";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

/** RC-33 against real PGlite: one busy project cannot take every drain, and a drain takes turns. */

const ORG = "22222222-2222-4222-8222-222222222222";
const BUSY = "11111111-1111-4111-8111-111111111111";
const QUIET = "33333333-3333-4333-8333-333333333333";
type Db = ReturnType<typeof getDb>;

async function setup(): Promise<Db> {
  const client = await createMigratedPGlite();
  // BUSY queued five jobs before QUIET queued its one.
  const busyJobs = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `('aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}', '${BUSY}', 'match_quality_run', 'queued', now() - interval '${10 - n} minutes')`,
    )
    .join(",\n");
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${BUSY}', '${ORG}', 'Busy', 'busy'), ('${QUIET}', '${ORG}', 'Quiet', 'quiet');
    insert into jobs (id, project_id, kind, status, created_at) values
      ${busyJobs},
      -- The same tier as BUSY's jobs, so only fairness decides (tiers: lib/jobs/policy.ts).
      ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', '${QUIET}', 'match_quality_run', 'queued', now() - interval '1 minute');
  `);
  return drizzle(client, { schema }) as unknown as Db;
}

test("the cap defaults to one running job per project and reads JOBS_RUNNING_PER_PROJECT", () => {
  assert.equal(jobsRunningPerProject({}), 1);
  assert.equal(jobsRunningPerProject({ JOBS_RUNNING_PER_PROJECT: "3" }), 3);
  assert.equal(jobsRunningPerProject({ JOBS_RUNNING_PER_PROJECT: "0" }), 0);
  assert.equal(jobsRunningPerProject({ JOBS_RUNNING_PER_PROJECT: "lots" }), 1);
});

test("while a busy project runs a job, a second drain gets the quiet project's job, not the busy one's next", async () => {
  const db = await setup();
  const first = await claimNextQueuedJob(undefined, undefined, db, { runningPerProject: 1 });
  assert.equal(first?.projectId, BUSY, "oldest job first");
  const second = await claimNextQueuedJob(undefined, undefined, db, { runningPerProject: 1 });
  assert.equal(second?.projectId, QUIET, "the busy project is at its cap");
  assert.equal(
    await claimNextQueuedJob(undefined, undefined, db, { runningPerProject: 1 }),
    null,
    "both at their cap",
  );
});

test("a drain takes turns: a project it just served goes behind the others", async () => {
  const db = await setup();
  const first = await claimNextQueuedJob(undefined, undefined, db);
  assert.equal(first?.projectId, BUSY);
  await markJobDone(first!.id, null, db);
  const next = await claimNextQueuedJob(undefined, undefined, db, { avoidProjects: [BUSY] });
  assert.equal(
    next?.projectId,
    QUIET,
    "the quiet project's newer job before the busy project's older ones",
  );
  await markJobDone(next!.id, null, db);
  const after = await claimNextQueuedJob(undefined, undefined, db, {
    avoidProjects: [BUSY, QUIET],
  });
  assert.equal(after?.projectId, BUSY, "when only served projects have work, it still runs");
});

test("a running import does not count against the project's cap, and a kind filter picks the lane", async () => {
  const db = await setup();
  const client = (db as unknown as { $client: { exec: (sql: string) => Promise<unknown> } })
    .$client;
  await client.exec(`
    insert into jobs (project_id, kind, status, payload, started_at) values ('${QUIET}', 'run_import', 'running', '{"importId":"x"}', now());
    insert into jobs (project_id, kind, status, payload, created_at) values ('${QUIET}', 'run_import', 'queued', '{"importId":"y"}', now() - interval '1 hour');
  `);
  const analysis = await claimNextQueuedJob(undefined, undefined, db, {
    runningPerProject: 1,
    kinds: { except: ["run_import"] },
    avoidProjects: [BUSY],
  });
  assert.equal(
    analysis?.projectId,
    QUIET,
    "the quiet project's analysis runs while its import does",
  );
  assert.notEqual(analysis?.kind, "run_import");
  const imported = await claimNextQueuedJob(undefined, undefined, db, {
    runningPerProject: 1,
    kinds: { only: ["run_import"] },
  });
  assert.equal(imported?.kind, "run_import", "the import lane takes only imports");
});

test("work someone waits on is claimed before fresh data, and sweeps come last (RC-212)", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${BUSY}', '${ORG}', 'Busy', 'busy'), ('${QUIET}', '${ORG}', 'Quiet', 'quiet');
    insert into jobs (project_id, kind, status, created_at) values
      ('${BUSY}', 'craft_tools', 'queued', now() - interval '30 minutes'),
      ('${BUSY}', 'build_trace_turns', 'queued', now() - interval '20 minutes'),
      ('${QUIET}', 'simulate_fix_eval', 'queued', now() - interval '1 minute');
  `);
  const db = drizzle(client, { schema }) as unknown as Db;
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    const job = await claimNextQueuedJob(undefined, undefined, db, { runningPerProject: 0 });
    order.push(job!.kind);
    assert.ok(job!.createdAt instanceof Date, "the claim says when the job was queued");
  }
  assert.deepEqual(order, ["simulate_fix_eval", "build_trace_turns", "craft_tools"]);
});
