import assert from "node:assert/strict";
import { test } from "node:test";
import { createDrizzleBaselineStore } from "../adapters/drizzle-baseline-store";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { pinBaseline, pinnedRun } from "../baseline";
import type { DatasetDefinition } from "../domain/dataset";
import { currentVersion } from "../domain/eval";
import { type Experiment, unscored } from "../domain/experiment";
import { advanceExperiment, startEachEval } from "../experiments";
import { BILLING, SUBJECT, SUPPORT, SUPPORT_OLD, setup, TURN } from "./model-support";
import { content, evalContent, NO_REFUND, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

/**
 * Datasets of each kind resolved and frozen at the start of a run, and runs of one eval with their
 * changes and their matrix (decisions `datasets-first-class`, `runs-per-eval`).
 */
test("a fixed dataset gives its trace rows and its value rows, and a run freezes their versions", async () => {
  const t = await setup();
  const refunds = await t.evalOn("Refunds");
  const cases = createDrizzleCaseStore(t.db);
  const fromTurn = await cases.create({
    projectId: PROJECT_ID,
    evalId: refunds.id,
    name: "from a turn",
    labels: [],
    content: content(),
    createdBy: "u",
    source: { turnId: TURN(1), output: "recorded" },
  });
  const typed = await cases.create({
    projectId: PROJECT_ID,
    datasetId: currentVersion(refunds).datasetId ?? "",
    name: "typed values",
    labels: [],
    content: content({ input: { orderId: "A200", amount: 12 }, expectedOutput: "No refund." }),
    createdBy: "u",
  });
  assert.ok(typeof fromTurn === "object" && typeof typed === "object");
  const experiment = await t.start({ eval: "Refunds" });
  assert.equal(experiment.evalId, refunds.id);
  assert.deepEqual(experiment.dataset && [experiment.dataset.kind, experiment.dataset.rows], [
    "fixed",
    2,
  ]);
  assert.deepEqual(
    experiment.caseVersions.map(({ caseId }) => caseId).sort(),
    [fromTurn.id, typed.id].sort(),
  );
  const frozen = await t.deps.experiments.caseVersions(
    experiment.caseVersions.map(({ versionId }) => versionId),
  );
  assert.deepEqual(frozen.map(({ sourceTurnId }) => sourceTurnId).sort(), [null, TURN(1)].sort());
});

test("each query kind is resolved through the port when a run starts", async () => {
  const t = await setup();
  const kinds: Array<[string, DatasetDefinition, string[]]> = [
    ["last", { kind: "last_traces", limit: 2 }, [TURN(1), TURN(2)]],
    ["task", { kind: "task_traces", taskId: "wf-1", limit: 5 }, [TURN(3)]],
    [
      "rql",
      { kind: "rql", text: "select trace_id from traces", days: 7, limit: 5 },
      [TURN(10), TURN(11)],
    ],
    ["choose", { kind: "choose", taskId: null, limit: 5 }, [TURN(21), TURN(20)]],
    ["choose task", { kind: "choose", taskId: "wf-1", limit: 5 }, [TURN(30)]],
  ];
  for (const [name, definition, turns] of kinds) {
    const dataset = await t.dataset(name, definition);
    await t.evalOn(`eval ${name}`, { datasetId: dataset.id });
    const experiment = await t.start({ eval: `eval ${name}` });
    assert.deepEqual(experiment.dataset?.kind, definition.kind, name);
    assert.deepEqual(
      experiment.caseVersions.map(({ caseId, row }) => [caseId, row]),
      turns.map((turnId) => [turnId, "run"]),
      name,
    );
    const [first] = await t.deps.experiments.caseVersions([
      experiment.caseVersions[0]?.versionId ?? "",
    ]);
    assert.equal(first?.sourceTurnId, turns[0], name);
  }
  assert.deepEqual(t.calls, [
    ["newestTurns", PROJECT_ID, 2],
    ["taskTurns", PROJECT_ID, "wf-1", 5],
    ["rqlTraces", PROJECT_ID, "select trace_id from traces"],
    ["chooseForTask", "wf-1", 5],
  ]);
});

test("a run keeps the rows that it resolved: a later run of the same query can get others", async () => {
  let turns = [TURN(1), TURN(2)];
  const t = await setup({ newestTurns: async () => turns });
  const dataset = await t.dataset("last", { kind: "last_traces", limit: 5 });
  await t.evalOn("Live", { datasetId: dataset.id });
  const first = await t.start({ eval: "Live" });
  turns = [TURN(3)];
  const second = await t.start({ eval: "Live" });
  const rowsOf = async (experiment: Experiment) =>
    (
      await t.deps.experiments.caseVersions(
        experiment.caseVersions.map(({ versionId }) => versionId),
      )
    )
      .map(({ sourceTurnId }) => sourceTurnId)
      .sort();
  assert.deepEqual(await rowsOf(first), [TURN(1), TURN(2)]);
  assert.deepEqual(await rowsOf(second), [TURN(3)]);
});

test("a resolved set over its limit is refused with the reason, and a turn with no input is left out", async () => {
  const over = await setup({
    rqlTraces: async () => ({ ok: true, traceIds: ["a", "b", "c"], truncated: false }),
  });
  const rql = await over.dataset("rql", {
    kind: "rql",
    text: "select trace_id from traces",
    days: 7,
    limit: 2,
  });
  await over.evalOn("Q", { datasetId: rql.id });
  const refused = await over.run({ eval: "Q" });
  assert.deepEqual(refused.ok ? null : refused.reason, "too_many_rows");
  assert.match(refused.ok ? "" : refused.message, /gives 3 traces\. The dataset takes at most 2/);

  const cut = await setup({
    rqlTraces: async () => ({ ok: true, traceIds: ["a"], truncated: true }),
  });
  const cutSet = await cut.dataset("rql", {
    kind: "rql",
    text: "select trace_id from traces",
    days: 7,
    limit: 2,
  });
  await cut.evalOn("Q", { datasetId: cutSet.id });
  const truncated = await cut.run({ eval: "Q" });
  assert.deepEqual(truncated.ok ? null : truncated.reason, "too_many_rows");

  const wrong = await setup({
    rqlTraces: async () => ({ ok: false, message: "RQL: no trace_id" }),
  });
  const bad = await wrong.dataset("rql", { kind: "rql", text: "select 1", days: 7, limit: 2 });
  await wrong.evalOn("Q", { datasetId: bad.id });
  const invalid = await wrong.run({ eval: "Q" });
  assert.deepEqual(invalid.ok ? null : [invalid.reason, invalid.message], [
    "invalid_query",
    "RQL: no trace_id",
  ]);

  const greedy = await setup({ newestTurns: async () => [TURN(1), TURN(2), TURN(3)] });
  const last = await greedy.dataset("last", { kind: "last_traces", limit: 2 });
  await greedy.evalOn("L", { datasetId: last.id });
  const tooMany = await greedy.run({ eval: "L" });
  assert.deepEqual(tooMany.ok ? null : tooMany.reason, "too_many_rows");

  const empty = await setup({ newestTurns: async () => [TURN(99), TURN(1)] });
  const some = await empty.dataset("last", { kind: "last_traces", limit: 5 });
  await empty.evalOn("L", { datasetId: some.id });
  const kept = await empty.start({ eval: "L" });
  assert.deepEqual(
    kept.caseVersions.map(({ caseId }) => caseId),
    [TURN(1)],
  );
});

test("a project that does not store content cannot build rows from traces, and the refusal says so", async () => {
  const t = await setup({ readContent: async () => false });
  const last = await t.dataset("last", { kind: "last_traces", limit: 5 });
  await t.evalOn("L", { datasetId: last.id });
  const refused = await t.run({ eval: "L" });
  assert.deepEqual(refused.ok ? null : refused.reason, "no_content_access");
  assert.match(refused.ok ? "" : refused.message, /does not let Ratel read the captured text/);
  assert.deepEqual(t.calls, []);
});

test("a run takes changes for itself only: dataset, added rows, scorers, runtime version, params", async () => {
  const t = await setup();
  const golden = await t.dataset("Golden", { kind: "last_traces", limit: 1 });
  const refunds = await t.evalOn("Refunds", { params: { tone: "warm" }, trials: 2 });
  const experiment = await t.start({
    eval: "Refunds",
    changes: {
      dataset: "Golden",
      rows: [{ name: "typed", input: { message: "hi" }, expectedOutput: "Hello." }],
      scorers: [{ source: "predefined", key: "output_contains", gating: true, value: "refund" }],
      sandboxVersion: SUPPORT_OLD.id,
      params: { model: "small" },
      trials: 1,
    },
  });
  assert.equal(experiment.dataset?.datasetId, golden.id);
  assert.equal(experiment.dataset?.rows, 1);
  assert.equal(experiment.caseVersions.length, 2);
  assert.equal(experiment.sandboxVersionId, SUPPORT_OLD.id);
  assert.deepEqual(experiment.params, { tone: "warm", model: "small" });
  assert.equal(experiment.trialsPerCase, 1);
  const [snapshot] = Object.values(experiment.scorerSnapshots)[0] ?? [];
  assert.deepEqual(
    [snapshot?.id, snapshot?.name],
    ["predefined:output_contains:refund", "Output contains: refund"],
  );
  assert.deepEqual(experiment.changes, {
    datasetId: golden.id,
    extraRows: 1,
    scorers: [{ source: "predefined", key: "output_contains", gating: true, value: "refund" }],
    sandboxVersionId: SUPPORT_OLD.id,
    params: { model: "small" },
    trials: 1,
  });
  // The eval does not change.
  const after = await createDrizzleEvalStore(t.db).get(PROJECT_ID, refunds.id);
  assert.deepEqual(after?.versions.length, 1);
  assert.deepEqual(after && currentVersion(after).scorers, [NO_REFUND]);
  assert.equal(after && currentVersion(after).datasetId, currentVersion(refunds).datasetId);

  const wrong = await t.run({ eval: "Refunds", changes: { sandboxVersion: BILLING.id } });
  assert.deepEqual(wrong.ok ? null : wrong.reason, "wrong_sandbox");
  const missing = await t.run({ eval: "Refunds", changes: { dataset: "Nope" } });
  assert.deepEqual(missing.ok ? null : missing.reason, "not_found");
});

test("an eval pins a runtime version, else its runs take the newest ready version of its sandbox", async () => {
  const t = await setup();
  await t
    .dataset("rows", { kind: "last_traces", limit: 1 })
    .then((dataset) =>
      Promise.all([
        t.evalOn("Pinned", { datasetId: dataset.id, sandboxVersionId: SUPPORT_OLD.id }),
        t.evalOn("Newest", { datasetId: dataset.id }),
      ]),
    );
  assert.equal((await t.start({ eval: "Pinned" })).sandboxVersionId, SUPPORT_OLD.id);
  assert.equal((await t.start({ eval: "Newest" })).sandboxVersionId, SUPPORT.id);
  assert.equal(
    (await t.start({ eval: "Pinned", changes: { sandboxVersion: "latest" } })).sandboxVersionId,
    SUPPORT.id,
  );
});

test("a matrix run stores one variant for each combination, and each trial gets the params of its variant", async () => {
  const t = await setup();
  const dataset = await t.dataset("rows", { kind: "last_traces", limit: 2 });
  await t.evalOn("Tone", {
    datasetId: dataset.id,
    params: { model: "big" },
    trials: 1,
    matrix: { tone: ["dry", "warm"] },
  });
  const experiment = await t.start({ eval: "Tone" });
  assert.deepEqual(experiment.variants, [
    { index: 0, values: { tone: "dry" }, params: { model: "big", tone: "dry" } },
    { index: 1, values: { tone: "warm" }, params: { model: "big", tone: "warm" } },
  ]);
  const trials = await t.deps.experiments.trials(experiment.id);
  assert.deepEqual(
    trials.map(({ variant }) => variant),
    [0, 1, 0, 1],
  );
  await advanceExperiment(experiment, t.deps);
  assert.deepEqual(
    t.started.map(({ params }) => params),
    [
      { model: "big", tone: "dry" },
      { model: "big", tone: "warm" },
      { model: "big", tone: "dry" },
      { model: "big", tone: "warm" },
    ],
  );
  const changed = await t.start({
    eval: "Tone",
    changes: { matrix: { model: ["a", "b", "c"], tone: ["dry", "warm"] } },
  });
  assert.equal(changed.variants.length, 6);
  const none = await t.start({ eval: "Tone", changes: { matrix: {} } });
  assert.deepEqual(none.variants, [{ index: 0, values: {}, params: { model: "big" } }]);
  const unknown = await t.run({ eval: "Tone", changes: { matrix: { temperature: ["0", "1"] } } });
  assert.deepEqual(unknown.ok ? null : unknown.reason, "invalid_matrix");
  assert.match(unknown.ok ? "" : unknown.message, /does not declare the param temperature/);
  const tooMany = await t.run({
    eval: "Tone",
    changes: { matrix: { model: ["a", "b", "c", "d", "e"], tone: ["1", "2", "3"] } },
  });
  assert.deepEqual(tooMany.ok ? null : tooMany.reason, "invalid_matrix");
});

test("a run of each eval: a version of one sandbox applies only to the evals of that sandbox", async () => {
  const t = await setup();
  const dataset = await t.dataset("rows", { kind: "last_traces", limit: 1 });
  await t.evalOn("Support", { datasetId: dataset.id });
  await t.evalOn("Billing", { datasetId: dataset.id, sandboxName: "billing-demo" });
  await t.evalOn("Empty");
  const result = await startEachEval(
    SUBJECT,
    { startedBy: "u", changes: { sandboxVersion: SUPPORT_OLD.id } },
    t.deps,
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.ok &&
      result.runs.map(({ name, result: one, note }) => [
        name,
        one.ok ? one.experiment.sandboxVersionId : one.reason,
        note !== null,
      ]),
    [
      ["Support", SUPPORT_OLD.id, false],
      ["Billing", BILLING.id, true],
    ],
  );
  // An eval with no row is left out when no eval is named.
  assert.deepEqual(result.ok && result.skipped.map(({ name }) => name), ["Empty"]);
  const named = await startEachEval(SUBJECT, { startedBy: "u", evals: ["Empty"] }, t.deps);
  assert.ok(named.ok);
  assert.deepEqual(named.ok && named.runs.map(({ result: one }) => (one.ok ? "ok" : one.reason)), [
    "no_cases",
  ]);
  const ofSandbox = await startEachEval(
    SUBJECT,
    { startedBy: "u", sandbox: "billing-demo" },
    t.deps,
  );
  assert.deepEqual(ofSandbox.ok && ofSandbox.runs.map(({ name }) => name), ["Billing"]);
});

test("the baseline is pinned for each eval, and a suite run keeps the pin of the project", async () => {
  const t = await setup();
  const dataset = await t.dataset("rows", { kind: "last_traces", limit: 1 });
  const support = await t.evalOn("Support", { datasetId: dataset.id });
  const other = await t.evalOn("Other", { datasetId: dataset.id });
  const experiment = await t.start({ eval: "Support" });
  for (const trial of await t.deps.experiments.trials(experiment.id)) {
    await t.deps.experiments.finish(trial.id, unscored("pass", ""));
  }
  await t.deps.experiments.close(experiment.id, new Date());
  const baselines = {
    baselines: createDrizzleBaselineStore(t.db),
    experiments: t.deps.experiments,
    now: () => new Date(),
  };
  const pinned = await pinBaseline(PROJECT_ID, experiment.id, "u", baselines);
  assert.ok(pinned.ok);
  assert.equal((await pinnedRun(PROJECT_ID, baselines, support.id))?.experiment.id, experiment.id);
  assert.equal(await pinnedRun(PROJECT_ID, baselines, other.id), null);
  assert.equal(await pinnedRun(PROJECT_ID, baselines), null);
  assert.equal(await createDrizzleBaselineStore(t.db).get(OTHER_PROJECT_ID, support.id), null);
});

test("a dataset or an eval of another project is not found", async () => {
  const t = await setup();
  const foreign = await t.dataset("foreign", { kind: "last_traces", limit: 1 }, OTHER_PROJECT_ID);
  const made = await createDrizzleEvalStore(t.db).create({
    projectId: PROJECT_ID,
    name: "X",
    taskId: null,
    content: evalContent({ datasetId: foreign.id }),
    createdBy: "u",
  });
  assert.equal(made, "dataset_not_found");
  await t.evalOn("Mine");
  const run = await t.run({ eval: "Mine", changes: { dataset: foreign.id } });
  assert.deepEqual(run.ok ? null : run.reason, "not_found");
  const row = await createDrizzleCaseStore(t.db).create({
    projectId: PROJECT_ID,
    datasetId: foreign.id,
    name: "x",
    labels: [],
    content: content(),
    createdBy: "u",
  });
  assert.equal(row, "eval_not_found");
});

test("a query dataset has no rows of its own", async () => {
  const t = await setup();
  const last = await t.dataset("last", { kind: "last_traces", limit: 1 });
  const row = await createDrizzleCaseStore(t.db).create({
    projectId: PROJECT_ID,
    datasetId: last.id,
    name: "x",
    labels: [],
    content: content(),
    createdBy: "u",
  });
  assert.equal(row, "not_fixed");
});
