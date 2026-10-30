import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { claimNextQueuedJob, readJobQueueClock } from "@/lib/jobs/queries";
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

  const first = await claimNextQueuedJob(PROJ, createdBefore, db);
  assert.equal(first?.id, JOB_OLD);
  assert.equal(
    await claimNextQueuedJob(PROJ, createdBefore, db),
    null,
    "the newer job waits for the next drain",
  );
  const unbounded = await claimNextQueuedJob(PROJ, undefined, db);
  assert.equal(unbounded?.id, JOB_NEW, "without a bound it is claimed");
});
