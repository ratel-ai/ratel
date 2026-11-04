import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadAnalysisFreshness, loadSectionProgress } from "@/lib/views/freshness/load";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

async function setup(sqlText: string): Promise<BoundReadDb> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a'), ('${OTHER}', '${ORG}', 'B', 'b');
    ${sqlText}
  `);
  return drizzle(client, { schema }) as unknown as BoundReadDb;
}

test("a project with nothing analyzed reads as no update and idle", async () => {
  const db = await setup("");
  assert.deepEqual(await loadAnalysisFreshness(db, PROJ), {
    updatedAt: null,
    working: false,
    importing: null,
  });
});

test("the latest finished job of this project and its queued work", async () => {
  const db = await setup(`
    insert into jobs (project_id, kind, status, created_at, finished_at) values
      ('${PROJ}', 'match_quality_run', 'done', now() - interval '20 minutes', now() - interval '10 minutes'),
      ('${PROJ}', 'match_quality_run', 'done', now() - interval '9 minutes', now() - interval '3 minutes'),
      ('${PROJ}', 'craft_tools', 'queued', now(), null),
      ('${OTHER}', 'match_quality_run', 'done', now(), now());
  `);
  const freshness = await loadAnalysisFreshness(db, PROJ);
  const age = Date.now() - Date.parse(freshness.updatedAt!);
  assert.ok(
    age > 2.5 * 60_000 && age < 3.5 * 60_000,
    "the newest of this project's jobs, not another project's",
  );
  assert.equal(freshness.working, true);
});

test("only finished jobs read as idle", async () => {
  const db = await setup(`
    insert into jobs (project_id, kind, status, created_at, finished_at) values
      ('${PROJ}', 'match_quality_run', 'done', now() - interval '2 minutes', now() - interval '1 minute');
  `);
  const freshness = await loadAnalysisFreshness(db, PROJ);
  assert.equal(freshness.working, false);
});

test("a page's progress counts only its own kinds and this project's jobs", async () => {
  const db = await setup(`
    insert into jobs (project_id, kind, status, created_at, finished_at) values
      ('${PROJ}', 'cluster_intents', 'done', now() - interval '30 minutes', now() - interval '20 minutes'),
      ('${PROJ}', 'assign_topics', 'done', now() - interval '9 minutes', now() - interval '6 minutes'),
      ('${PROJ}', 'cluster_intents', 'error', now() - interval '3 minutes', now() - interval '2 minutes'),
      ('${PROJ}', 'cluster_intents', 'queued', now(), null),
      ('${PROJ}', 'assign_topics', 'running', now(), null),
      ('${PROJ}', 'match_quality_run', 'done', now(), now()),
      ('${PROJ}', 'match_quality_run', 'queued', now(), null),
      ('${OTHER}', 'cluster_intents', 'done', now(), now()),
      ('${OTHER}', 'cluster_intents', 'queued', now(), null);
  `);
  const progress = await loadSectionProgress(db, PROJ, ["cluster_intents", "assign_topics"]);
  const age = Date.now() - Date.parse(progress.lastDoneAt!);
  assert.ok(
    age > 5.5 * 60_000 && age < 6.5 * 60_000,
    "the newest done job of these kinds, not a failed one or another kind's",
  );
  assert.equal(progress.pending, 2);
});

test("a page whose jobs never ran reads as never done and nothing pending", async () => {
  const db = await setup(`
    insert into jobs (project_id, kind, status, created_at, finished_at) values
      ('${PROJ}', 'match_quality_run', 'done', now(), now());
  `);
  assert.deepEqual(await loadSectionProgress(db, PROJ, ["cluster_intents"]), {
    lastDoneAt: null,
    pending: 0,
  });
  assert.deepEqual(await loadSectionProgress(db, PROJ, []), { lastDoneAt: null, pending: 0 });
});

test("work queued for longer than the pending window is stuck, not on its way", async () => {
  const db = await setup(`
    insert into jobs (project_id, kind, status, created_at, finished_at) values
      ('${PROJ}', 'craft_tools', 'queued', now() - interval '14 days', null),
      ('${PROJ}', 'craft_tools', 'running', now() - interval '7 hours', null);
  `);
  assert.equal((await loadSectionProgress(db, PROJ, ["craft_tools"])).pending, 0);
  assert.equal((await loadAnalysisFreshness(db, PROJ)).working, false);
});
