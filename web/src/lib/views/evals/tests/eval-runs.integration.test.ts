import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import type { Scorer } from "@/lib/views/scorers/types";
import { createDrizzleBaselineStore } from "../adapters/drizzle-baseline-store";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { compareWithBaseline, pinBaseline } from "../baseline";
import { datasetOf, type EvalScorer } from "../domain/eval";
import { paramsOfTrial } from "../domain/experiment";
import { startEachEvalRun, startEvalRun } from "../eval-runs";
import { type ExperimentDeps, startExperiment } from "../experiments";
import {
  content,
  createEvalsDb,
  fakeLibrary,
  fakeTraceSource,
  NO_REFUND,
  ORGANIZATION_ID,
  PROJECT_ID,
  seedEval,
} from "./support";

const SUBJECT = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
const PROJECT_SCORER = "c0000000-0000-4000-8000-000000000001";
const PARAMS: SandboxVersionSummary["params"] = [
  { name: "model", type: "string", default: null, description: null, options: [] },
  { name: "depth", type: "number", default: 1, description: null, options: [] },
];
const NEWEST = version("66666666-6666-4666-8666-666666666661", "support-demo", 3);
const OLDER = version("66666666-6666-4666-8666-666666666662", "support-demo", 2);
const OTHER = version("66666666-6666-4666-8666-666666666663", "billing", 1);

function version(id: string, name: string, minute: number): SandboxVersionSummary {
  return {
    id,
    projectId: PROJECT_ID,
    sandboxId: `${id.slice(0, -1)}9`,
    name,
    git: { commit: String(minute).repeat(40).slice(0, 40), dirty: false },
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 10, 27, 10, minute)),
    tools: [],
    params: PARAMS,
  };
}

const LIBRARY_SCORER = {
  id: PROJECT_SCORER,
  projectId: PROJECT_ID,
  name: "Short answer",
  kind: "check",
  config: { path: "output_tokens", op: "lte", value: 200 },
  filter: {},
  tasks: null,
  sampleRate: 100,
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as Scorer;

const FROM_LIBRARY: EvalScorer = {
  id: "short",
  name: "Short answer",
  gating: false,
  // The copy of the save. The run reads the library again.
  definition: { kind: "check", config: { path: "output_tokens", op: "lte", value: 999 } },
  ref: { source: "project", scorerId: PROJECT_SCORER },
};
const PREDEFINED: EvalScorer = {
  id: "lookup",
  name: "Tool was called",
  gating: false,
  definition: { kind: "check", config: { path: "tools", op: "contains", value: "x" } },
  ref: { source: "predefined", key: "expected_tool", settings: { tool: "lookup_order" } },
};

async function setup() {
  const { db, client } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const cases = createDrizzleCaseStore(db);
  const deps: ExperimentDeps = {
    cases,
    evals: createDrizzleEvalStore(db),
    datasets,
    traces: fakeTraceSource(),
    library: fakeLibrary({ projectScorers: async () => [LIBRARY_SCORER] }),
    experiments: createDrizzleExperimentStore(db),
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => [NEWEST, OLDER, OTHER],
      getVersion: async (_, id) => [NEWEST, OLDER, OTHER].find((one) => one.id === id) ?? null,
      startRun: async () => {
        throw new Error("no trial starts in these tests");
      },
      getRun: async () => null,
    },
    judge: {} as ExperimentDeps["judge"],
    now: () => new Date(),
  };
  const refunds = await seedEval(db, {
    content: { sandboxName: "support-demo", scorers: [NO_REFUND, FROM_LIBRARY, PREDEFINED] },
  });
  for (const name of ["a", "b"]) {
    await cases.create({
      projectId: PROJECT_ID,
      evalId: refunds.id,
      name,
      labels: [],
      content: content({ input: { message: name } }),
      createdBy: "user_1",
    });
  }
  const start = (changes: Parameters<typeof startEvalRun>[1]["changes"] = {}) =>
    startEvalRun(SUBJECT, { eval: "Refunds", startedBy: "user_1", changes }, deps);
  return { db, client, deps, datasets, cases, refunds, start };
}

test("a run of one eval freezes its version, its rows, a snapshot of each scorer and its runtime", async () => {
  const { deps, refunds, start } = await setup();
  const result = await start();
  assert.ok(result.ok, result.ok ? "" : result.message);
  const run = result.experiment;
  assert.equal(run.evalId, refunds.id);
  assert.equal(run.datasetId, datasetOf(refunds));
  assert.equal(run.sandboxVersionId, NEWEST.id);
  assert.deepEqual(run.variants, []);
  assert.deepEqual(
    run.evalVersions.map(({ evalId, number, trials }) => [evalId, number, trials]),
    [[refunds.id, 1, 3]],
  );
  assert.equal(run.caseVersions.length, 2);
  const snapshots = run.scorerSnapshots[run.caseVersions[0]?.versionId ?? ""] ?? [];
  assert.deepEqual(
    snapshots.map(({ id, definition }) => [id, definition.config]),
    [
      ["no-refund", NO_REFUND.definition.config],
      ["short", { path: "output_tokens", op: "lte", value: 200 }],
      ["lookup", { path: "tools", op: "contains", value: "lookup_order" }],
    ],
  );
  assert.ok(snapshots.every(({ hash }) => hash.length === 64));
  assert.equal((await deps.experiments.trials(run.id)).length, 6);
});

test("the eval can pin a runtime version, and a run can choose another one of its sandbox", async () => {
  const { db, refunds, start } = await setup();
  await createDrizzleEvalStore(db).update(
    PROJECT_ID,
    refunds.id,
    {
      name: "Refunds",
      taskId: null,
      content: { ...refunds.versions[0], sandboxVersionId: OLDER.id } as never,
    },
    refunds.versions[0]?.id ?? "",
    { userId: "user_1", now: new Date() },
  );
  const pinned = await start();
  assert.equal(pinned.ok && pinned.experiment.sandboxVersionId, OLDER.id);
  const chosen = await start({ sandboxVersion: NEWEST.id });
  assert.equal(chosen.ok && chosen.experiment.sandboxVersionId, NEWEST.id);
  assert.deepEqual(chosen.ok && chosen.experiment.changes, { sandboxVersionId: NEWEST.id });
  const wrong = await start({ sandboxVersion: OTHER.id });
  assert.equal(wrong.ok ? null : wrong.reason, "wrong_sandbox");
});

test("a run changes the dataset, the rows, the scorers, the params and the trials for itself only", async () => {
  const { deps, datasets, refunds, start } = await setup();
  const other = await datasets.create({
    projectId: PROJECT_ID,
    name: "Typed asks",
    description: null,
    query: { kind: "fixed" },
    createdBy: "user_1",
  });
  if (other === "name_taken") throw new Error("taken");
  await datasets.addRows(
    PROJECT_ID,
    other.id,
    [{ kind: "values", name: "v", row: { values: { order: "A1" }, expectedOutput: null } }],
    "user_1",
  );
  const result = await start({
    dataset: "Typed asks",
    rows: [
      { kind: "values", name: "extra", row: { values: { order: "B2" }, expectedOutput: null } },
    ],
    scorers: [NO_REFUND],
    params: { model: "small" },
    trials: 1,
  });
  assert.ok(result.ok, result.ok ? "" : result.message);
  const run = result.experiment;
  assert.equal(run.datasetId, other.id);
  assert.deepEqual(run.caseVersions.map(({ name }) => name).sort(), ["extra", "v"]);
  assert.deepEqual(run.params, { model: "small" });
  assert.equal(run.trialsPerCase, 1);
  assert.deepEqual(
    Object.values(run.scorerSnapshots)[0]?.map(({ id }) => id),
    ["no-refund"],
  );
  assert.deepEqual(run.changes, {
    datasetId: other.id,
    addedRows: 1,
    scorers: true,
    params: { model: "small" },
    trials: 1,
  });
  // The extra row is not a row of the dataset, and the eval did not change.
  assert.deepEqual(
    (await datasets.rows(PROJECT_ID, other.id)).map(({ name }) => name),
    ["v"],
  );
  const [same] = await deps.evals.list(PROJECT_ID);
  assert.equal(same?.versions.length, refunds.versions.length);
});

test("a matrix run stores one variant for each combination, and each trial gets the params of its variant", async () => {
  const { deps, start } = await setup();
  const result = await start({ matrix: { model: ["small", "large"], depth: [1, 2] }, trials: 1 });
  assert.ok(result.ok, result.ok ? "" : result.message);
  const run = result.experiment;
  assert.deepEqual(
    run.variants.map(({ index, params }) => [index, params]),
    [
      [0, { model: "small", depth: 1 }],
      [1, { model: "small", depth: 2 }],
      [2, { model: "large", depth: 1 }],
      [3, { model: "large", depth: 2 }],
    ],
  );
  const trials = await deps.experiments.trials(run.id);
  assert.equal(trials.length, 2 * 4);
  const last = trials.find(({ variant }) => variant === 3);
  assert.deepEqual(last && paramsOfTrial(run, last), { model: "large", depth: 2 });
});

test("a matrix over 12 combinations, or with a param that the runtime does not declare, is refused", async () => {
  const { start } = await setup();
  const big = await start({ matrix: { depth: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] } });
  assert.equal(big.ok ? null : big.reason, "invalid_params");
  assert.match(big.ok ? "" : big.message, /13 combinations.*at most 12/);
  const unknown = await start({ matrix: { temperature: [0, 1] } });
  assert.match(unknown.ok ? "" : unknown.message, /does not declare the param temperature/);
  const typed = await start({ matrix: { depth: ["deep"] } });
  assert.match(typed.ok ? "" : typed.message, /depth must be a number/);
});

test("a scorer reference that the library does not have refuses the run", async () => {
  const { deps, start } = await setup();
  deps.library = fakeLibrary();
  const result = await start();
  assert.equal(result.ok ? null : result.reason, "invalid_scorers");
  assert.match(result.ok ? "" : result.message, /"Short answer".*not in the library/);
});

test("the baseline is pinned for each eval, and the suite pin stays for the runs from before", async () => {
  const { db, client, deps, cases, start } = await setup();
  const status = await seedEval(db, { name: "Status", content: { sandboxName: "support-demo" } });
  await cases.create({
    projectId: PROJECT_ID,
    evalId: status.id,
    name: "s",
    labels: [],
    content: content(),
    createdBy: "user_1",
  });
  const first = await start();
  const second = await start();
  const ofStatus = await startEvalRun(SUBJECT, { eval: "Status", startedBy: "user_1" }, deps);
  assert.ok(first.ok && second.ok && ofStatus.ok);
  await client.query("update eval_experiments set state = 'completed'");
  const baselines = createDrizzleBaselineStore(db);
  const baselineDeps = { baselines, experiments: deps.experiments, now: () => new Date() };
  const pinned = await pinBaseline(PROJECT_ID, first.experiment.id, "user_1", baselineDeps);
  assert.ok(pinned.ok);
  await pinBaseline(PROJECT_ID, ofStatus.experiment.id, "user_1", baselineDeps);
  assert.equal(
    (await baselines.get(PROJECT_ID, first.experiment.evalId))?.experimentId,
    first.experiment.id,
  );
  assert.equal((await baselines.get(PROJECT_ID, status.id))?.experimentId, ofStatus.experiment.id);
  assert.equal(await baselines.get(PROJECT_ID), null);
  const compared = await compareWithBaseline(PROJECT_ID, second.experiment.id, baselineDeps);
  assert.ok(compared.ok, compared.ok ? "" : compared.refusal.message);
  assert.equal(compared.baseline.experiment.id, first.experiment.id);
  // A new pin of the same eval replaces the pin before it.
  await pinBaseline(PROJECT_ID, second.experiment.id, "user_1", baselineDeps);
  assert.equal((await baselines.get(PROJECT_ID, status.id))?.experimentId, ofStatus.experiment.id);
  assert.equal(
    (await baselines.get(PROJECT_ID, first.experiment.evalId))?.experimentId,
    second.experiment.id,
  );
});

test("a start of each eval makes one run for each eval, and a version of another sandbox does not apply", async () => {
  const { db, deps, cases } = await setup();
  const billing = await seedEval(db, { name: "Billing", content: { sandboxName: "billing" } });
  await cases.create({
    projectId: PROJECT_ID,
    evalId: billing.id,
    name: "b",
    labels: [],
    content: content(),
    createdBy: "user_1",
  });
  await seedEval(db, { name: "No gate", content: { scorers: [] } });
  const result = await startEachEvalRun(
    SUBJECT,
    { startedBy: "user_1", changes: { sandboxVersion: OLDER.id, params: { model: "m" } } },
    deps,
  );
  assert.ok(result.ok, result.ok ? "" : result.message);
  const [refunds, ofBilling, noGate] = result.runs;
  assert.ok(refunds?.ok && ofBilling?.ok);
  assert.equal(refunds.experiment.sandboxVersionId, OLDER.id);
  assert.equal(refunds.note, null);
  assert.equal(ofBilling.experiment.sandboxVersionId, OTHER.id);
  assert.match(ofBilling.note ?? "", /sandbox support-demo.*runs on billing/);
  assert.deepEqual(ofBilling.experiment.params, { model: "m" });
  // A refusal of one eval does not stop the others.
  assert.equal(noGate?.ok, false);
  assert.equal(noGate && !noGate.ok && noGate.reason, "invalid_scorers");
  const named = await startEachEvalRun(SUBJECT, { evals: ["Billing"], startedBy: "user_1" }, deps);
  assert.deepEqual(named.ok && named.runs.map(({ eval: one }) => one), ["Billing"]);
  const unknown = await startEachEvalRun(SUBJECT, { evals: ["Nope"], startedBy: "u" }, deps);
  assert.equal(unknown.ok ? null : unknown.reason, "not_found");
});

test("review fixes: a suite of two evals on one dataset is refused, an edit keeps the pin and the matrix, and runs of one eval pass the suite limit", async () => {
  const { db, client, deps, refunds, start } = await setup();
  const evals = createDrizzleEvalStore(db);
  // An edit that does not give the pinned version or the matrix keeps them.
  const version = refunds.versions[0];
  assert.ok(version);
  const pinned = await evals.update(
    PROJECT_ID,
    refunds.id,
    {
      name: "Refunds",
      taskId: null,
      content: {
        ...version,
        datasetId: null,
        sandboxVersionId: OLDER.id,
        matrix: { depth: [1, 2] },
      },
    },
    version.id,
    { userId: "u", now: new Date() },
  );
  assert.ok(typeof pinned !== "string");
  const { sandboxVersionId: _, matrix: __, ...rest } = pinned.versions[0] ?? version;
  const kept = await evals.update(
    PROJECT_ID,
    refunds.id,
    { name: "Refunds", taskId: null, content: { ...rest, datasetId: null, trials: 2 } },
    pinned.versions[0]?.id ?? "",
    { userId: "u", now: new Date() },
  );
  assert.ok(typeof kept !== "string");
  assert.deepEqual(
    [kept.versions[0]?.sandboxVersionId, kept.versions[0]?.matrix, kept.versions[0]?.trials],
    [OLDER.id, { depth: [1, 2] }, 2],
  );
  // Two evals that read one dataset cannot share a suite run: they would score the same trials.
  const other = await seedEval(db, { name: "Same rows", content: { sandboxName: "support-demo" } });
  await client.query("update eval_definition_versions set dataset_id = $1 where eval_id = $2", [
    datasetOf(refunds),
    other.id,
  ]);
  const suite = await startExperiment(
    SUBJECT,
    { sandboxVersion: "latest", params: {}, startedBy: "u" },
    deps,
  );
  assert.equal(suite.ok ? null : suite.reason, "shared_dataset");
  assert.match(suite.ok ? "" : suite.message, /"Refunds" and "Same rows" read the same dataset/);
  // More than the 10 running suite runs: each eval gets its run.
  for (let n = 0; n < 11; n++) {
    const run = await start({ matrix: {}, trials: 1 });
    assert.ok(run.ok, run.ok ? "" : run.message);
  }
});
