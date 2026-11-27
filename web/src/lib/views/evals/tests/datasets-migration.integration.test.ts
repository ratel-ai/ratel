import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { datasetOf } from "../domain/eval";
import { freezeSuite } from "../domain/experiment";
import { ORGANIZATION_ID, PROJECT_ID } from "./support";

/**
 * Migration 0067 (decision `datasets-first-class`): each existing eval gets one fixed dataset, with
 * the id and the name of the eval, and its rows. A run from before still opens.
 */
const MIGRATION = "0068_eval_datasets.sql";
const REFUNDS = "e0000000-0000-4000-8000-000000000000";
const STATUS = "e1000000-0000-4000-8000-000000000000";
const CASE = "a0000000-0000-4000-8000-000000000000";
const VERSION = "b0000000-0000-4000-8000-000000000000";
const RUN = "c0000000-0000-4000-8000-000000000000";

test("each existing eval gets a fixed dataset with its rows", async () => {
  const { db } = await migrated();
  const evals = createDrizzleEvalStore(db);
  const datasets = createDrizzleDatasetStore(db);
  const refunds = await evals.get(PROJECT_ID, REFUNDS);
  assert.equal(refunds && datasetOf(refunds), REFUNDS);
  const listed = await datasets.list(PROJECT_ID);
  assert.deepEqual(listed.map(({ name, query, rowCount }) => [name, query.kind, rowCount]).sort(), [
    ["Refunds", "fixed", 1],
    ["Status", "fixed", 0],
  ]);
  const [row] = await datasets.rows(PROJECT_ID, REFUNDS);
  assert.equal(row?.id, CASE);
  assert.equal(row?.evalId, REFUNDS);
  const cases = await createDrizzleCaseStore(db).list(PROJECT_ID, REFUNDS);
  assert.deepEqual(
    cases.map(({ id }) => id),
    [CASE],
  );
  assert.deepEqual(await createDrizzleCaseStore(db).list(PROJECT_ID, STATUS), []);
  // The eval runs its rows as before.
  const frozen = freezeSuite(refunds ? [refunds] : [], cases);
  assert.deepEqual(
    frozen.caseVersions.map(({ versionId, evalId }) => [versionId, evalId]),
    [[VERSION, REFUNDS]],
  );
});

test("a run from before the migration still opens, with the versions that it froze", async () => {
  const { db } = await migrated();
  const experiments = createDrizzleExperimentStore(db);
  const run = await experiments.get(PROJECT_ID, RUN);
  assert.equal(run?.caseVersions[0]?.versionId, VERSION);
  const [frozen] = await experiments.caseVersions([VERSION]);
  assert.deepEqual(frozen?.input, "refund A200");
  assert.equal((await experiments.trials(RUN)).length, 1);
});

async function migrated() {
  const client = new PGlite();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files.filter((name) => name < MIGRATION)) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  await client.exec(`
    create table organizations (id uuid primary key, name text not null, slug text not null unique);
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
    insert into eval_definitions (id, project_id, name, created_by) values
      ('${REFUNDS}', '${PROJECT_ID}', 'Refunds', 'u'),
      ('${STATUS}', '${PROJECT_ID}', 'Status', 'u');
    insert into eval_definition_versions (eval_id, number, params, trials, scorers, created_by) values
      ('${REFUNDS}', 1, '{}', 1, '[{"id":"s","name":"S","gating":true,"definition":{"kind":"check","config":{"path":"output","op":"exists"}}}]', 'u'),
      ('${STATUS}', 1, '{}', 1, '[]', 'u');
    insert into eval_cases (id, project_id, eval_id, name, created_by) values
      ('${CASE}', '${PROJECT_ID}', '${REFUNDS}', 'ask', 'u');
    insert into eval_case_versions (id, case_id, number, input, earlier_turns, tool_fixtures) values
      ('${VERSION}', '${CASE}', 1, '{"value":"refund A200"}', '[]', '[]');
    insert into eval_experiments (id, project_id, organization_id, sandbox_version_id, sandbox_name,
      git_commit, git_dirty, params, trials_per_case, case_versions, scorer_snapshots, started_by, state)
    values ('${RUN}', '${PROJECT_ID}', '${ORGANIZATION_ID}', gen_random_uuid(), 'demo', '', false, '{}', 1,
      '[{"caseId":"${CASE}","versionId":"${VERSION}","number":1,"name":"ask"}]', '{}', 'u', 'completed');
    insert into eval_trials (experiment_id, case_version_id, position, index, state, result)
      values ('${RUN}', '${VERSION}', 0, 0, 'done', 'pass');
  `);
  for (const file of files.filter((name) => name >= MIGRATION)) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  return { client, db: drizzle(client) as any };
}
