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
import { currentVersion } from "../domain/eval";
import { evalScores } from "../domain/suite";
import { ORGANIZATION_ID, PROJECT_ID } from "./support";

/**
 * Migration 0068 (decision `datasets-first-class`): each eval gets one fixed dataset with its rows,
 * and the runs from before still open with what they froze.
 */
const MIGRATION = "0068_datasets_and_eval_runs.sql";
const REFUNDS = "e0000000-0000-4000-8000-000000000001";
const TONE = "e0000000-0000-4000-8000-000000000002";
const CASE_A = "a0000000-0000-4000-8000-000000000001";
const CASE_B = "a0000000-0000-4000-8000-000000000002";
const VERSION_A = "b0000000-0000-4000-8000-000000000001";
const VERSION_B = "b0000000-0000-4000-8000-000000000002";
const RUN = "c0000000-0000-4000-8000-000000000001";
const SCORER = {
  id: "s1",
  name: "No refund",
  gating: true,
  definition: { kind: "check", config: { path: "tools", op: "ne", value: "refund_order" } },
};

test("each eval gets a fixed dataset with its name and its rows", async () => {
  const { db } = await migrated();
  const datasets = await createDrizzleDatasetStore(db).list(PROJECT_ID);
  assert.deepEqual(
    datasets.map(({ name, definition }) => [name, definition.kind]),
    [
      ["Refunds", "fixed"],
      ["Tone", "fixed"],
    ],
  );
  const evals = createDrizzleEvalStore(db);
  const refunds = await evals.get(PROJECT_ID, REFUNDS);
  const version = refunds && currentVersion(refunds);
  assert.equal(version?.datasetId, datasets[0]?.id);
  assert.deepEqual(version?.matrix, {});
  assert.equal(version?.sandboxVersionId, null);
  // The scorers stay in the eval: the library shows them as "from this eval".
  assert.deepEqual(version?.scorers, [SCORER]);
  const cases = createDrizzleCaseStore(db);
  assert.deepEqual(
    (await cases.list(PROJECT_ID, REFUNDS)).map(({ id, datasetId, evalId }) => [
      id,
      datasetId,
      evalId,
    ]),
    [[CASE_A, datasets[0]?.id, REFUNDS]],
  );
  assert.deepEqual(
    (await cases.listDataset(PROJECT_ID, datasets[1]?.id ?? "")).map(({ id }) => id),
    [CASE_B],
  );
  const stats = await createDrizzleDatasetStore(db).rowStats(PROJECT_ID);
  assert.equal(stats.get(datasets[0]?.id ?? "")?.rows, 1);
});

test("a run from before still opens: its rows, its trials and its scores", async () => {
  const { db } = await migrated();
  const experiments = createDrizzleExperimentStore(db);
  const run = await experiments.get(PROJECT_ID, RUN);
  assert.ok(run);
  assert.equal(run.evalId, null);
  assert.equal(run.dataset, null);
  assert.deepEqual(run.variants, []);
  assert.deepEqual(run.changes, {});
  const trials = await experiments.trials(RUN);
  assert.deepEqual(
    trials.map(({ variant, result }) => [variant, result]),
    [
      [0, "pass"],
      [0, "fail"],
    ],
  );
  const [frozen] = await experiments.caseVersions([VERSION_A]);
  assert.equal(frozen?.input, "first");
  const scores = evalScores({ experiment: run, trials });
  assert.deepEqual(
    scores.map(({ name, score }) => [name, score]),
    [
      ["Refunds", 1],
      ["Tone", 0],
    ],
  );
});

test("a new row of a migrated eval goes into its dataset", async () => {
  const { db } = await migrated();
  const made = await createDrizzleCaseStore(db).create({
    projectId: PROJECT_ID,
    evalId: TONE,
    name: "new",
    labels: [],
    content: { input: "x", earlierTurns: [], toolFixtures: [], expectedOutput: null },
    createdBy: "u",
  });
  assert.ok(typeof made === "object");
  const tone = await createDrizzleEvalStore(db).get(PROJECT_ID, TONE);
  assert.equal(made.datasetId, tone && currentVersion(tone).datasetId);
});

async function migrated() {
  const client = new PGlite();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files.filter((name) => name < MIGRATION)) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  const scorers = JSON.stringify([SCORER]);
  await client.exec(`
    create table organizations (id uuid primary key, name text not null, slug text not null unique);
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
    insert into eval_definitions (id, project_id, name, created_by, created_at) values
      ('${REFUNDS}', '${PROJECT_ID}', 'Refunds', 'u', '2026-11-01T00:00:00Z'),
      ('${TONE}', '${PROJECT_ID}', 'Tone', 'u', '2026-11-02T00:00:00Z');
    insert into eval_definition_versions (eval_id, number, params, trials, scorers, created_by) values
      ('${REFUNDS}', 1, '{}', 1, '${scorers}', 'u'),
      ('${TONE}', 1, '{}', 1, '${scorers}', 'u');
    insert into eval_cases (id, project_id, eval_id, name, created_by) values
      ('${CASE_A}', '${PROJECT_ID}', '${REFUNDS}', 'a', 'u'),
      ('${CASE_B}', '${PROJECT_ID}', '${TONE}', 'b', 'u');
    insert into eval_case_versions (id, case_id, number, input, earlier_turns, tool_fixtures) values
      ('${VERSION_A}', '${CASE_A}', 1, '{"value":"first"}', '[]', '[]'),
      ('${VERSION_B}', '${CASE_B}', 1, '{"value":"second"}', '[]', '[]');
  `);
  const snapshot = JSON.stringify([{ ...SCORER, hash: "h1" }]);
  await client.query(
    `insert into eval_experiments (id, project_id, organization_id, sandbox_version_id, sandbox_name,
       git_commit, git_dirty, params, trials_per_case, case_versions, eval_versions, scorer_snapshots,
       started_by, state)
     values ($1, $2, $3, gen_random_uuid(), 'support', '', false, '{}', 1, $4, $5, $6, 'u', 'completed')`,
    [
      RUN,
      PROJECT_ID,
      ORGANIZATION_ID,
      JSON.stringify([
        { caseId: CASE_A, versionId: VERSION_A, number: 1, name: "a", evalId: REFUNDS },
        { caseId: CASE_B, versionId: VERSION_B, number: 1, name: "b", evalId: TONE },
      ]),
      JSON.stringify([
        {
          evalId: REFUNDS,
          versionId: VERSION_A,
          number: 1,
          name: "Refunds",
          params: {},
          trials: 1,
        },
        { evalId: TONE, versionId: VERSION_B, number: 1, name: "Tone", params: {}, trials: 1 },
      ]),
      JSON.stringify({ [VERSION_A]: JSON.parse(snapshot), [VERSION_B]: JSON.parse(snapshot) }),
    ],
  );
  const result = (status: string) =>
    JSON.stringify([
      { scorerId: "s1", name: "No refund", kind: "check", gating: true, status, reason: "" },
    ]);
  await client.query(
    `insert into eval_trials (experiment_id, case_version_id, position, index, state, result, scorers)
     values ($1, $2, 0, 0, 'done', 'pass', $3), ($1, $4, 1, 0, 'done', 'fail', $5)`,
    [RUN, VERSION_A, result("pass"), VERSION_B, result("fail")],
  );
  await client.exec(readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8"));
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  return { client, db: drizzle(client) as any };
}
