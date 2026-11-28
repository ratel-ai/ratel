import assert from "node:assert/strict";
import { test } from "node:test";
import type { Compared } from "../baseline";
import { datasetQuerySchema } from "../domain/dataset";
import type { EvalDefinition, EvalScorer } from "../domain/eval";
import type { TrialResult } from "../domain/score";
import { RUN_SCORE_RULE } from "../domain/suite";
import { datasetsView, evalHistory, evalsOverview, withPinnedRuns } from "../history-view";
import type { DatasetSummary } from "../ports/dataset-store";
import { POLITE, run } from "./runs";
import { evalContent, NO_REFUND, PROJECT_ID } from "./support";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 10, minute));

/** A completed run of one eval, at this minute. */
function evalRun(
  id: string,
  evalId: string,
  minute: number,
  results: TrialResult[],
  scorers: EvalScorer[] = [NO_REFUND],
): Compared {
  const made = run(id, { [evalId]: { scorers, cases: { a: results } } });
  made.experiment.evalId = evalId;
  made.experiment.datasetId = `${evalId}-data`;
  made.experiment.createdAt = at(minute);
  return made;
}

function definition(id: string, scorers: EvalScorer[] = [NO_REFUND]): EvalDefinition {
  return {
    id,
    projectId: PROJECT_ID,
    name: id,
    taskId: null,
    createdAt: at(0),
    versions: [
      {
        ...evalContent({ scorers }),
        datasetId: `${id}-data`,
        id: `${id}-v1`,
        evalId: id,
        number: 1,
        createdBy: "u",
        createdAt: at(0),
      },
    ],
  };
}

test("the overview has each eval with its cases, scorers, baseline score, newest score and a series in run time order", () => {
  const second = evalRun("r2", "refunds", 20, ["pass", "pass"]);
  const first = evalRun("r1", "refunds", 10, ["pass", "fail"]);
  const running = evalRun("r3", "refunds", 30, ["pass"]);
  running.experiment.state = "running";
  const other = evalRun("s1", "status", 15, ["fail"]);
  const rows = evalsOverview({
    evals: [definition("refunds", [NO_REFUND, POLITE]), definition("status")],
    rowCounts: new Map([["refunds-data", 4]]),
    // Not in time order: the series is.
    runs: [second, other, running, first],
    baselines: new Map([["refunds", "r1"]]),
  });
  assert.deepEqual(rows[0], {
    evalId: "refunds",
    name: "refunds",
    cases: 4,
    scorers: 2,
    baselineScore: 0.5,
    newestScore: 1,
    series: [
      { experimentId: "r1", at: at(10).toISOString(), score: 0.5 },
      { experimentId: "r2", at: at(20).toISOString(), score: 1 },
    ],
  });
  assert.deepEqual([rows[1]?.cases, rows[1]?.baselineScore, rows[1]?.newestScore], [0, null, 0]);
});

test("a suite run from before counts for each eval that it ran", () => {
  const suite = run("old", {
    refunds: { cases: { a: ["pass"] } },
    status: { cases: { s: ["fail"] } },
  });
  suite.experiment.createdAt = at(5);
  const rows = evalsOverview({
    evals: [definition("refunds"), definition("status")],
    rowCounts: new Map(),
    runs: [suite],
    baselines: new Map(),
  });
  assert.deepEqual(
    rows.map(({ series }) => series.map(({ score }) => score)),
    [[1], [0]],
  );
});

test("one eval has its runs, the newest first, with the delta against its baseline and a series for each scorer", () => {
  const base = evalRun("r1", "refunds", 10, ["pass", "fail"]);
  const next = evalRun("r2", "refunds", 20, ["pass", "pass"]);
  next.experiment.params = { model: "large" };
  const changed = evalRun("r3", "refunds", 30, ["pass"], [NO_REFUND, POLITE]);
  const history = evalHistory({
    definition: definition("refunds"),
    runs: [changed, base, next],
    baseline: base,
  });
  assert.equal(history.rule, RUN_SCORE_RULE);
  assert.equal(history.baselineId, "r1");
  assert.deepEqual(
    history.runs.map(({ experimentId, score, delta, isBaseline }) => [
      experimentId,
      score,
      delta,
      isBaseline,
    ]),
    [
      ["r3", 1, null, false],
      ["r2", 1, { score: 0.5 }, false],
      ["r1", 0.5, null, true],
    ],
  );
  assert.equal(history.runs[0]?.deltaRefusal?.reason, "scorers_differ");
  assert.deepEqual(history.runs[1]?.params, { model: "large" });
  assert.deepEqual(history.runs[1]?.scorers, ["No refund"]);
  assert.equal(history.runs[1]?.datasetId, "refunds-data");
  assert.deepEqual(
    history.scorerSeries.map(({ name, points }) => [name, points.map(({ passRate }) => passRate)]),
    [
      ["No refund", [0.5, 1, 1]],
      ["Polite", [1]],
    ],
  );
  assert.deepEqual(
    history.scorerSeries[0]?.points.map(({ at: when }) => when),
    [at(10), at(20), at(30)].map((date) => date.toISOString()),
  );
});

test("a matrix run has one score in its row and in the chart: the pass rate over all its valid trials", () => {
  // Variant 0: 1 pass, 3 invalid. Variant 1: 4 fails.
  const results: TrialResult[] = ["pass", "invalid", "invalid", "invalid"];
  const matrix = evalRun("m1", "refunds", 10, [...results, "fail", "fail", "fail", "fail"]);
  matrix.experiment.variants = [
    { index: 0, params: { model: "small" } },
    { index: 1, params: { model: "large" } },
  ];
  matrix.trials.forEach((trial, index) => {
    trial.variant = index < results.length ? 0 : 1;
  });
  const history = evalHistory({
    definition: definition("refunds"),
    runs: [matrix],
    baseline: null,
  });
  assert.equal(history.runs[0]?.score, 0.2);
  assert.deepEqual(
    history.scorerSeries.map(({ points }) => points.map(({ passRate }) => passRate)),
    [[0.2]],
  );
});

test("the datasets list has the kind, the rows or the query, the update time and the evals that read it", () => {
  const summary = (id: string, query: unknown, rowCount = 0): DatasetSummary => ({
    id,
    projectId: PROJECT_ID,
    name: id,
    description: null,
    query: datasetQuerySchema.parse(query),
    createdBy: "u",
    createdAt: at(0),
    updatedAt: at(1),
    rowCount,
  });
  const rows = datasetsView(
    [
      summary("refunds-data", { kind: "fixed" }, 3),
      summary("errors", { kind: "rql", text: "select trace_id from traces where has_error" }),
      summary("recent", { kind: "last_traces", limit: 20 }),
      summary("task", { kind: "task_traces", taskId: "wf-refunds" }),
      summary("chosen", { kind: "auto" }),
    ],
    [definition("refunds"), definition("refunds-2")],
  );
  assert.deepEqual(rows[0], {
    datasetId: "refunds-data",
    name: "refunds-data",
    kind: "fixed",
    rows: 3,
    query: null,
    updatedAt: at(1).toISOString(),
    evals: [{ evalId: "refunds", name: "refunds" }],
  });
  assert.deepEqual(
    rows.slice(1).map(({ rows: count, query }) => [count, query]),
    [
      [null, "select trace_id from traces where has_error"],
      [null, "The last 20 traces"],
      [null, "The last 50 traces of the task wf-refunds"],
      [null, "Ratel chooses 50 traces"],
    ],
  );
});

test("a pinned baseline older than the newest runs is loaded and kept", async () => {
  const recent = [evalRun("r2", "refunds", 20, ["pass"])];
  const old = evalRun("r0", "refunds", 1, ["fail"]);
  const loaded: string[] = [];
  const runs = await withPinnedRuns(recent, ["r0", "r2", null], async (id) => {
    loaded.push(id);
    return id === "r0" ? old : null;
  });
  assert.deepEqual(loaded, ["r0"]);
  const history = evalHistory({ definition: definition("refunds"), runs, baseline: old });
  assert.equal(history.baselineId, "r0");
  assert.deepEqual(history.runs[0]?.delta, { score: 1 });
});
