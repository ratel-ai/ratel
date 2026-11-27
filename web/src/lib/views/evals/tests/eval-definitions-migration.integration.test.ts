import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { currentVersion } from "../domain/eval";
import { experimentPageModel } from "../page-model";
import { NO_REFUND, ORGANIZATION_ID, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

/**
 * Migration 0065 puts each existing case into an eval made from its `task:` label and its scorer
 * set, and moves the scorers from the case version to the eval version. An experiment from before
 * it still reads.
 */
const MIGRATION = "0065_eval_definitions.sql";
const JUDGE = {
  id: "polite",
  name: "Polite",
  gating: false,
  definition: { kind: "judge", config: { prompt: "polite?", output: "boolean" } },
};
const EXPERIMENT_ID = "77777777-7777-4777-8777-777777777777";

type OldCaseArgs = [
  id: string,
  projectId: string,
  labels: string[],
  versions: Array<{ state: "draft" | "approved"; scorers: object[] }>,
  createdAt: string,
];

async function beforeAndAfter() {
  const client = await beforeMigration();
  const oldCase = (...args: OldCaseArgs) => insertOldCase(client, ...args);
  const A = "a0000000-0000-4000-8000-000000000000";
  const B = "b0000000-0000-4000-8000-000000000000";
  const C = "c0000000-0000-4000-8000-000000000000";
  const D = "d0000000-0000-4000-8000-000000000000";
  const E = "e0000000-0000-4000-8000-000000000000";
  // A and B: one label, one scorer set. C: the same label, other scorers. D: no label. E: another project.
  await oldCase(
    A,
    PROJECT_ID,
    ["task: refunds", "smoke"],
    [{ state: "approved", scorers: [NO_REFUND] }],
    "2026-11-01",
  );
  await oldCase(
    B,
    PROJECT_ID,
    ["Task:refunds"],
    // The approved version counts, not the newer draft. Each case made its own scorer ids.
    [
      { state: "approved", scorers: [{ ...NO_REFUND, id: "no-refund-b" }] },
      { state: "draft", scorers: [NO_REFUND, JUDGE] },
    ],
    "2026-11-02",
  );
  await oldCase(
    C,
    PROJECT_ID,
    ["task: refunds"],
    [{ state: "draft", scorers: [NO_REFUND, JUDGE] }],
    "2026-11-03",
  );
  await oldCase(
    D,
    PROJECT_ID,
    ["intent: status"],
    [{ state: "approved", scorers: [JUDGE] }],
    "2026-11-04",
  );
  await oldCase(
    E,
    OTHER_PROJECT_ID,
    [],
    [{ state: "approved", scorers: [NO_REFUND] }],
    "2026-11-05",
  );

  // An experiment of the old shape, with its frozen scorers and one trial.
  const versionA = `${A.slice(0, 35)}0`;
  await client.query(
    `insert into eval_experiments (id, project_id, organization_id, sandbox_version_id, sandbox_name, git_commit,
       git_dirty, params, trials_per_case, case_versions, scorer_snapshots, started_by, state)
     values ($1, $2, $3, $4, 'support-demo', 'abc', false, '{}', 1, $5, $6, 'user_1', 'completed')`,
    [
      EXPERIMENT_ID,
      PROJECT_ID,
      ORGANIZATION_ID,
      "66666666-6666-4666-8666-666666666666",
      JSON.stringify([{ caseId: A, versionId: versionA, number: 1, name: "case a" }]),
      JSON.stringify({ [versionA]: [{ ...NO_REFUND, hash: "h" }] }),
    ],
  );
  await client.query(
    `insert into eval_trials (experiment_id, case_version_id, position, index, state, result, scorers)
     values ($1, $2, 0, 0, 'done', 'pass', $3)`,
    [
      EXPERIMENT_ID,
      versionA,
      JSON.stringify([
        {
          scorerId: "no-refund",
          name: "No refund",
          kind: "check",
          gating: true,
          status: "pass",
          reason: "ok",
        },
      ]),
    ],
  );

  await migrate(client);
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  const db = drizzle(client) as any;
  return { client, db, ids: { A, B, C, D, E }, versionA };
}

test("the migration puts each case into an eval of its task label and its scorer set", async () => {
  const { db, ids } = await beforeAndAfter();
  const evals = await createDrizzleEvalStore(db).list(PROJECT_ID);
  assert.deepEqual(
    evals.map((one) => [one.name, one.taskId, currentVersion(one).scorers.map(({ id }) => id)]),
    [
      ["refunds", null, ["no-refund"]],
      ["refunds #2", null, ["no-refund", "polite"]],
      ["Evals", null, ["polite"]],
    ],
  );
  for (const one of evals) {
    assert.deepEqual(
      [currentVersion(one).number, currentVersion(one).trials, currentVersion(one).params],
      [1, 3, {}],
    );
  }
  const [refunds, refunds2, rest] = evals;
  const cases = createDrizzleCaseStore(db);
  const members = async (evalId = "") =>
    (await cases.list(PROJECT_ID, evalId)).map(({ id }) => id).sort();
  assert.deepEqual(await members(refunds?.id), [ids.A, ids.B]);
  assert.deepEqual(await members(refunds2?.id), [ids.C]);
  assert.deepEqual(await members(rest?.id), [ids.D]);
  const [theirs] = await createDrizzleEvalStore(db).list(OTHER_PROJECT_ID);
  assert.equal(theirs?.name, "Evals");
  assert.deepEqual(
    (await cases.list(OTHER_PROJECT_ID)).map(({ evalId }) => evalId),
    [theirs?.id],
  );
  // The versions of the cases keep their content and their states.
  const b = await cases.get(PROJECT_ID, ids.B);
  assert.deepEqual(
    b?.versions.map(({ number, state, input }) => [number, state, input]),
    [
      [2, "draft", { message: "refund A200" }],
      [1, "approved", { message: "refund A200" }],
    ],
  );
});

test("no scorer is left on a case version after the migration", async () => {
  const { client } = await beforeAndAfter();
  const { rows } = await client.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_name = 'eval_case_versions'",
  );
  assert.ok(!rows.some(({ column_name }) => column_name === "scorers"));
  const { rows: nulls } = await client.query("select id from eval_cases where eval_id is null");
  assert.deepEqual(nulls, []);
});

test("an experiment created before the change still opens", async () => {
  const { db, versionA } = await beforeAndAfter();
  const experiments = createDrizzleExperimentStore(db);
  const experiment = await experiments.get(PROJECT_ID, EXPERIMENT_ID);
  assert.ok(experiment);
  assert.deepEqual(experiment.evalVersions, []);
  assert.deepEqual(
    experiment.scorerSnapshots[versionA]?.map(({ id }) => id),
    ["no-refund"],
  );
  const trials = await experiments.trials(EXPERIMENT_ID);
  const versions = await experiments.caseVersions([versionA]);
  assert.deepEqual(
    versions.map(({ input }) => input),
    [{ message: "refund A200" }],
  );
  const page = experimentPageModel(experiment, trials, { versions });
  assert.equal(page.id, EXPERIMENT_ID);
  assert.deepEqual(
    page.scorers.map(({ name }) => name),
    ["No refund"],
  );
  assert.equal(trials[0]?.result, "pass");
});

test("cases with the same label and the same scorers share an eval, whatever their scorer ids", async () => {
  const client = await beforeMigration();
  for (const n of [1, 2, 3]) {
    await insertOldCase(
      client,
      `a000000${n}-0000-4000-8000-000000000000`,
      PROJECT_ID,
      ["task: refunds"],
      [{ state: "approved", scorers: [{ ...NO_REFUND, id: crypto.randomUUID() }, JUDGE] }],
      `2026-11-0${n}`,
    );
  }
  await migrate(client);
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  const db = drizzle(client) as any;
  const evals = await createDrizzleEvalStore(db).list(PROJECT_ID);
  assert.deepEqual(
    evals.map(({ name }) => name),
    ["refunds"],
  );
  assert.deepEqual(
    (await createDrizzleCaseStore(db).list(PROJECT_ID)).map(({ evalId }) => evalId),
    [evals[0]?.id, evals[0]?.id, evals[0]?.id],
  );
});

test("a numbered name never takes the name of another label", async () => {
  const client = await beforeMigration();
  const other = {
    ...NO_REFUND,
    definition: { kind: "check", config: { path: "output", op: "exists" } },
  };
  const seed: Array<[string, string, object]> = [
    ["b0000001-0000-4000-8000-000000000000", "task: X", NO_REFUND],
    ["b0000002-0000-4000-8000-000000000000", "task: X", other],
    ["b0000003-0000-4000-8000-000000000000", "task: X #2", NO_REFUND],
  ];
  for (const [n, [id, label, scorer]] of seed.entries()) {
    await insertOldCase(
      client,
      id,
      PROJECT_ID,
      [label],
      [{ state: "approved", scorers: [scorer] }],
      `2026-11-0${n + 1}`,
    );
  }
  await migrate(client);
  const { rows } = await client.query<{ name: string }>(
    "select name from eval_definitions order by name",
  );
  assert.deepEqual(
    rows.map(({ name }) => name),
    ["X", "X #2", "X #3"],
  );
});

/** A database with every migration before 0065, an organization and two projects. */
async function beforeMigration() {
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
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return client;
}

async function insertOldCase(
  client: PGlite,
  ...[id, projectId, labels, versions, createdAt]: OldCaseArgs
) {
  await client.query(
    "insert into eval_cases (id, project_id, name, labels, created_by, created_at) values ($1, $2, $3, $4, 'user_1', $5)",
    [id, projectId, `case ${id.slice(0, 1)}`, labels, createdAt],
  );
  for (const [n, { state, scorers }] of versions.entries()) {
    await client.query(
      `insert into eval_case_versions (id, case_id, number, state, input, earlier_turns, tool_fixtures, scorers)
       values ($1, $2, $3, $4, '{"value": {"message": "refund A200"}}', '[]', '[]', $5)`,
      [`${id.slice(0, 35)}${n}`, id, n + 1, state, JSON.stringify(scorers)],
    );
  }
}

async function migrate(client: PGlite) {
  await client.exec(readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8"));
}
