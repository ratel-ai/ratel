import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import {
  claimNextQueuedJob,
  enqueueJob,
  enqueueJobOnce,
  findInFlightJob,
  type JobsDb,
} from "@/lib/jobs/queries";
import { isUniqueViolation } from "@/lib/platform/db/errors";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

/**
 * The coalescing the partial unique indexes give against real PGlite: proof that the indexes
 * reached the generated migration, and that `enqueueJobOnce` turns the conflict into `null`.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";

type Db = JobsDb & Parameters<typeof claimNextQueuedJob>[2];

async function setup(): Promise<Db> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a');
  `);
  return drizzle(client, { schema }) as unknown as Db;
}

test("a coalesced kind queues once per project; a running job does not block a new queued one", async () => {
  const db = await setup();
  const first = await enqueueJobOnce({ projectId: PROJ, kind: "cluster_intents" }, db);
  assert.ok(first, "the first enqueue lands");
  assert.equal(
    await enqueueJobOnce({ projectId: PROJ, kind: "cluster_intents" }, db),
    null,
    "the second coalesces",
  );
  assert.equal((await findInFlightJob(PROJ, "cluster_intents", db))?.id, first?.id);

  const claimed = await claimNextQueuedJob(PROJ, undefined, db);
  assert.equal(claimed?.id, first?.id);
  const followUp = await enqueueJobOnce({ projectId: PROJ, kind: "cluster_intents" }, db);
  assert.ok(followUp, "a batch that lands mid-run still gets a follow-up");
});

test("a plain enqueue of a coalesced kind surfaces the conflict instead of hiding it", async () => {
  const db = await setup();
  await enqueueJob({ projectId: PROJ, kind: "fold_intent_graph" }, db);
  await assert.rejects(enqueueJob({ projectId: PROJ, kind: "fold_intent_graph" }, db), (error) =>
    isUniqueViolation(error),
  );
});

test("a kind without a coalescing index may queue several times", async () => {
  const db = await setup();
  const a = await enqueueJob(
    { projectId: PROJ, kind: "match_quality_run", payload: { run: 1 } },
    db,
  );
  const b = await enqueueJob(
    { projectId: PROJ, kind: "match_quality_run", payload: { run: 2 } },
    db,
  );
  assert.notEqual(a.id, b.id);
});
