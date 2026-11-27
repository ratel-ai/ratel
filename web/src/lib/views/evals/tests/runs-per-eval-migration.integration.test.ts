import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { createDrizzleBaselineStore } from "../adapters/drizzle-baseline-store";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { currentVersion, datasetOf } from "../domain/eval";
import { ORGANIZATION_ID, PROJECT_ID } from "./support";

/**
 * Migration 0068 (decision `runs-per-eval`): each eval version gets the dataset of its eval, and
 * the scorers of an eval stay in it (no scorer joins the project's library). The pin of a project
 * stays as the pin of the suite runs. A run from before still opens.
 */
const MIGRATION = "0068_eval_runs_per_eval.sql";
const REFUNDS = "e0000000-0000-4000-8000-000000000000";
const CASE = "a0000000-0000-4000-8000-000000000000";
const VERSION = "b0000000-0000-4000-8000-000000000000";
const RUN = "c0000000-0000-4000-8000-000000000000";
const SCORERS =
  '[{"id":"s","name":"S","gating":true,"definition":{"kind":"check","config":{"path":"output","op":"exists"}}}]';

test("each eval version gets the dataset of its eval, and its scorers stay in the eval", async () => {
  const { db, client } = await migrated();
  const refunds = await createDrizzleEvalStore(db).get(PROJECT_ID, REFUNDS);
  assert.ok(refunds);
  assert.equal(refunds.versions.length, 2);
  assert.ok(refunds.versions.every((version) => version.datasetId === REFUNDS));
  assert.equal(datasetOf(refunds), REFUNDS);
  const newest = currentVersion(refunds);
  assert.deepEqual([newest.sandboxVersionId, newest.matrix], [null, {}]);
  assert.deepEqual(newest.scorers, JSON.parse(SCORERS));
  const { rows } = await client.query<{ count: number }>(
    "select count(*)::int as count from trace_scorers",
  );
  assert.equal(rows[0]?.count, 0);
  assert.deepEqual(
    (await createDrizzleCaseStore(db).list(PROJECT_ID, REFUNDS)).map(({ id }) => id),
    [CASE],
  );
});

test("the pin of a project stays as the pin of the suite runs, and an old run still opens", async () => {
  const { db } = await migrated();
  const baselines = createDrizzleBaselineStore(db);
  assert.equal((await baselines.get(PROJECT_ID))?.experimentId, RUN);
  assert.equal((await baselines.get(PROJECT_ID))?.evalId, null);
  const experiments = createDrizzleExperimentStore(db);
  const run = await experiments.get(PROJECT_ID, RUN);
  assert.deepEqual(
    [run?.evalId, run?.datasetId, run?.variants, run?.changes],
    [null, null, [], {}],
  );
  const trials = await experiments.trials(RUN);
  assert.deepEqual(
    trials.map(({ variant, result }) => [variant, result]),
    [[0, "pass"]],
  );
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
    insert into eval_datasets (id, project_id, name, kind, created_by) values
      ('${REFUNDS}', '${PROJECT_ID}', 'Refunds', 'fixed', 'u');
    insert into eval_definitions (id, project_id, name, dataset_id, created_by) values
      ('${REFUNDS}', '${PROJECT_ID}', 'Refunds', '${REFUNDS}', 'u');
    insert into eval_definition_versions (eval_id, number, params, trials, scorers, created_by) values
      ('${REFUNDS}', 1, '{}', 1, '[]', 'u'),
      ('${REFUNDS}', 2, '{}', 1, '${SCORERS}', 'u');
    insert into eval_cases (id, project_id, dataset_id, eval_id, name, created_by) values
      ('${CASE}', '${PROJECT_ID}', '${REFUNDS}', '${REFUNDS}', 'ask', 'u');
    insert into eval_case_versions (id, case_id, number, input, earlier_turns, tool_fixtures) values
      ('${VERSION}', '${CASE}', 1, '{"value":"refund A200"}', '[]', '[]');
    insert into eval_experiments (id, project_id, organization_id, sandbox_version_id, sandbox_name,
      git_commit, git_dirty, params, trials_per_case, case_versions, scorer_snapshots, started_by, state)
    values ('${RUN}', '${PROJECT_ID}', '${ORGANIZATION_ID}', gen_random_uuid(), 'demo', '', false, '{}', 1,
      '[{"caseId":"${CASE}","versionId":"${VERSION}","number":1,"name":"ask"}]', '{}', 'u', 'completed');
    insert into eval_trials (experiment_id, case_version_id, position, index, state, result)
      values ('${RUN}', '${VERSION}', 0, 0, 'done', 'pass');
    insert into eval_baselines (project_id, experiment_id, pinned_by, pinned_at)
      values ('${PROJECT_ID}', '${RUN}', 'u', now());
  `);
  for (const file of files.filter((name) => name >= MIGRATION)) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  return { client, db: drizzle(client) as any };
}
