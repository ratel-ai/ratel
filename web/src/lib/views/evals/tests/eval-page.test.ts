import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalDefinition } from "../domain/eval";
import { evalPageModel, MEAN_SERIES } from "../eval-page";
import type { EvalHistory, EvalRunRow } from "../history-view";
import { evalContent, NO_REFUND } from "./support";

const P = "11111111-1111-4111-8111-111111111111";
const DATASET = "d1111111-1111-4111-8111-111111111111";
const OTHER_DATASET = "d2222222-2222-4222-8222-222222222222";
const PINNED = "66666666-6666-4666-8666-666666666662";

const definition: EvalDefinition = {
  id: "e1",
  projectId: P,
  name: "Orders",
  taskId: "wf-orders",
  createdAt: new Date(0),
  versions: [
    {
      ...evalContent({
        sandboxName: "support-demo",
        params: { model: "small" },
        matrix: { style: ["plain", "shout"] },
        trials: 2,
      }),
      datasetId: DATASET,
      id: "v1",
      evalId: "e1",
      number: 1,
      createdBy: "u",
      createdAt: new Date(0),
    },
  ],
};

function run(id: string, minute: number, over: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    experimentId: id,
    name: null,
    at: new Date(Date.UTC(2026, 10, 27, 10, minute)).toISOString(),
    state: "completed",
    datasetId: DATASET,
    rows: 4,
    sandboxVersionId: "66666666-6666-4666-8666-666666666661",
    sandboxName: "support-demo",
    gitCommit: "a".repeat(40),
    scorers: ["No refund"],
    params: { model: "small" },
    variants: [],
    score: 0.5,
    delta: null,
    deltaRefusal: null,
    isBaseline: false,
    invalid: 0,
    changes: {},
    ...over,
  };
}

const history: EvalHistory = {
  evalId: "e1",
  name: "Orders",
  datasetId: DATASET,
  baselineId: "r1",
  rule: "",
  // The newest first.
  runs: [
    run("r3", 3, {
      name: "Pinned run",
      state: "running",
      score: null,
      sandboxVersionId: PINNED,
      variants: [
        { index: 0, params: { style: "plain" } },
        { index: 1, params: { style: "shout" } },
      ],
      changes: { sandboxVersionId: PINNED, addedRows: 2, matrix: { style: ["plain", "shout"] } },
    }),
    run("r2", 2, {
      score: 0.75,
      delta: { score: 0.25 },
      invalid: 1,
      datasetId: OTHER_DATASET,
      changes: { datasetId: OTHER_DATASET, scorers: true, trials: 1 },
    }),
    run("r1", 1, { isBaseline: true }),
  ],
  scorerSeries: [
    {
      scorerId: "no-refund",
      name: "No refund",
      gating: true,
      points: [
        { experimentId: "r1", at: run("r1", 1).at, passRate: 0.5 },
        { experimentId: "r2", at: run("r2", 2).at, passRate: 1 },
      ],
    },
    { scorerId: "short", name: "Short", gating: false, points: [] },
  ],
};

const model = evalPageModel({
  projectId: P,
  definition,
  history,
  datasets: [
    { id: DATASET, name: "Order asks", kind: "fixed" },
    { id: OTHER_DATASET, name: "Failing traces", kind: "rql" },
  ],
});

test("the header shows the dataset, the runtime, the scorers, the trials and the matrix", () => {
  assert.deepEqual(model.definition, {
    dataset: { name: "Order asks", kindLabel: "Fixed", href: `/project/${P}/datasets/${DATASET}` },
    runtime: "support-demo · newest ready version",
    scorers: [NO_REFUND.name],
    trials: 2,
    params: ["model=small"],
    matrix: "matrix (2)",
  });
  assert.equal(model.taskId, "wf-orders");
});

test("the chart has the mean of each completed run, then one line for each scorer", () => {
  assert.deepEqual(
    model.chart.series.map(({ id, name, slot, points }) => [
      id,
      name,
      slot,
      points.map((p) => p.score),
    ]),
    [
      [MEAN_SERIES, "Score (mean)", 0, [0.5, 0.75]],
      ["no-refund", "No refund", 1, [0.5, 1]],
      ["short", "Short (advisory)", 2, []],
    ],
  );
  assert.equal(model.chart.runs, 2);
  assert.equal(model.chart.series[0]?.points[0]?.href, `/project/${P}/evals/experiments/r1`);
});

test("each run row says what it used, how it scored against the baseline, and what it changed", () => {
  const [pinned, changed, baseline] = model.runs;
  assert.equal(pinned?.title, "Pinned run");
  assert.equal(pinned?.running, true);
  assert.equal(pinned?.params, "matrix (2)");
  assert.deepEqual(pinned?.runtime, {
    sandbox: "support-demo",
    version: "66666666",
    commit: "aaaaaaaaaaaa",
  });
  assert.deepEqual(pinned?.changed, ["2 rows added", "pinned 66666666", "matrix (2)"]);
  assert.deepEqual(changed?.dataset, {
    name: "Failing traces",
    rows: 4,
    href: `/project/${P}/datasets/${OTHER_DATASET}`,
  });
  assert.equal(changed?.title, run("r2", 2).at);
  assert.equal(changed?.params, "model=small");
  assert.equal(changed?.delta, 0.25);
  assert.equal(changed?.deltaNote, null);
  assert.equal(changed?.invalid, 1);
  assert.deepEqual(changed?.changed, ["dataset Failing traces", "other scorers", "1 trial"]);
  assert.equal(baseline?.isBaseline, true);
  assert.equal(baseline?.deltaNote, null);
  assert.equal(model.baselineId, "r1");
});
