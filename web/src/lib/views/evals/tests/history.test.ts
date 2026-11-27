import assert from "node:assert/strict";
import { test } from "node:test";
import type { Compared } from "../baseline";
import type { Dataset } from "../domain/dataset";
import type { EvalDefinition, EvalScorer } from "../domain/eval";
import type { Variant } from "../domain/experiment";
import { runScore } from "../domain/history";
import type { TrialResult } from "../domain/score";
import { datasetsList, evalRunsView, evalsOverview } from "../history-view";
import { POLITE, run } from "./runs";
import { evalContent, NO_REFUND, PROJECT_ID } from "./support";

/**
 * The score history (decision `runs-per-eval`): the score of a run is the mean of its variants, a
 * delta is against the same variant of the baseline, and each series is in the order of run time.
 */
const EVAL = "refunds";

/** A run of the eval at this minute, with one variant for each list of trial results. */
function matrixRun(
  id: string,
  minute: number,
  variants: Array<{ values: Record<string, string>; results: TrialResult[] }>,
  scorers: EvalScorer[] = [NO_REFUND],
): Compared {
  const made = run(id, { [EVAL]: { scorers, cases: { a: [] } } });
  const { experiment } = made;
  experiment.evalId = EVAL;
  experiment.createdAt = new Date(Date.UTC(2026, 10, 27, 10, minute));
  experiment.variants = variants.map(
    ({ values }, index): Variant => ({ index, values, params: values }),
  );
  const versionId = `${id}-a`;
  const trials = variants.flatMap(({ results }, variant) =>
    results.map((result, index) => ({
      id: `${id}-${variant}-${index}`,
      experimentId: id,
      caseVersionId: versionId,
      index,
      variant,
      state: "done" as const,
      result,
      reason: null,
      scorers: scorers.map(({ id: scorerId, name, gating, definition }) => ({
        scorerId,
        name,
        kind: definition.kind,
        gating,
        status: result === "invalid" ? ("not_scored" as const) : result,
        reason: "",
      })),
      costUsd: null,
      durationMs: null,
      traceId: null,
      sandboxRunId: null,
    })),
  );
  return { experiment, trials };
}

test("the score of a run is the mean of the scores of its variants", () => {
  const candidate = matrixRun("next", 2, [
    { values: { tone: "dry" }, results: ["pass", "pass"] },
    { values: { tone: "warm" }, results: ["pass", "fail"] },
  ]);
  const score = runScore(candidate, EVAL);
  assert.deepEqual(
    score?.variants.map(({ values, score: one }) => [values, one]),
    [
      [{ tone: "dry" }, 1],
      [{ tone: "warm" }, 0.5],
    ],
  );
  assert.equal(score?.score, 0.75);
  assert.deepEqual(score?.counts, { pass: 3, fail: 1, invalid: 0, open: 0 });
  assert.equal(score?.delta, null);
  assert.equal(runScore(candidate, "other"), null);
});

test("a delta is against the same variant of the baseline, and the run delta against its score", () => {
  const baseline = matrixRun("base", 1, [{ values: { tone: "dry" }, results: ["pass", "fail"] }]);
  const candidate = matrixRun("next", 2, [
    { values: { tone: "dry" }, results: ["pass", "pass"] },
    { values: { tone: "warm" }, results: ["fail", "fail"] },
  ]);
  const score = runScore(candidate, EVAL, baseline);
  assert.deepEqual(score?.variants[0]?.delta, { score: 0.5 });
  assert.deepEqual(score?.variants[1]?.delta && "reason" in score.variants[1].delta, true);
  const missing = score?.variants[1]?.delta;
  assert.match(missing && "message" in missing ? missing.message : "", /did not run these values/);
  assert.deepEqual(score?.delta, { score: 0 });
  assert.equal(runScore(baseline, EVAL, baseline)?.delta, null);
});

test("the delta has no value, with the reason, when the scorer snapshots differ", () => {
  const baseline = matrixRun("base", 1, [{ values: {}, results: ["pass"] }]);
  const candidate = matrixRun("next", 2, [{ values: {}, results: ["pass"] }], [NO_REFUND, POLITE]);
  const score = runScore(candidate, EVAL, baseline);
  assert.equal(score?.delta && "reason" in score.delta && score.delta.reason, "scorers_differ");
  const differ = score?.delta;
  assert.match(differ && "message" in differ ? differ.message : "", /scorers of this eval differ/);
  assert.equal(
    score?.variants[0]?.delta &&
      "reason" in score.variants[0].delta &&
      score.variants[0].delta.reason,
    "scorers_differ",
  );
});

const definition: EvalDefinition = {
  id: EVAL,
  projectId: PROJECT_ID,
  name: "Refunds",
  taskId: null,
  createdAt: new Date(0),
  versions: [
    {
      ...evalContent({ datasetId: "d1" }),
      id: "v1",
      evalId: EVAL,
      number: 1,
      createdBy: "u",
      createdAt: new Date(0),
    },
  ],
};
const fixed: Dataset = {
  id: "d1",
  projectId: PROJECT_ID,
  name: "Refunds",
  definition: { kind: "fixed" },
  createdBy: "u",
  createdAt: new Date(0),
  updatedAt: new Date(Date.UTC(2026, 10, 1)),
};
const query: Dataset = {
  ...fixed,
  id: "d2",
  name: "Live",
  definition: { kind: "rql", text: "select trace_id from traces", days: 7, limit: 50 },
};

test("the overview: each eval with its rows, scorers, baseline and newest score, and a series by run time", () => {
  const one = matrixRun("r1", 1, [{ values: {}, results: ["fail"] }]);
  const second = matrixRun("r2", 2, [{ values: {}, results: ["pass", "fail"] }]);
  const third = matrixRun("r3", 3, [{ values: {}, results: ["pass"] }]);
  const overview = evalsOverview({
    evals: [definition],
    datasets: [fixed, query],
    rowCounts: new Map([["d1", 4]]),
    runs: new Map([[EVAL, [third, one, second]]]),
    baselines: new Map([[EVAL, "r2"]]),
  });
  assert.match(overview.scoreRule, /mean of the scores of its variants/);
  const [row] = overview.evals;
  assert.deepEqual(
    {
      cases: row?.cases,
      scorers: row?.scorers,
      datasetKind: row?.datasetKind,
      baselineScore: row?.baselineScore,
      newestRunId: row?.newestRunId,
      newestScore: row?.newestScore,
    },
    {
      cases: 4,
      scorers: 1,
      datasetKind: "fixed",
      baselineScore: 0.5,
      newestRunId: "r3",
      newestScore: 1,
    },
  );
  assert.deepEqual(
    row?.series.map(({ runId, score }) => [runId, score]),
    [
      ["r1", 0],
      ["r2", 0.5],
      ["r3", 1],
    ],
  );
  const [first] = definition.versions;
  assert.ok(first);
  const onQuery = evalsOverview({
    evals: [{ ...definition, versions: [{ ...first, datasetId: "d2" }] }],
    datasets: [fixed, query],
    rowCounts: new Map(),
    runs: new Map(),
    baselines: new Map(),
  }).evals[0];
  assert.deepEqual(
    [onQuery?.cases, onQuery?.query, onQuery?.newestScore],
    [null, "select trace_id from traces", null],
  );
});

test("one eval: its runs newest first with score and delta, and a pass-rate series for each scorer", () => {
  const baseline = matrixRun("r1", 1, [{ values: {}, results: ["fail", "fail"] }]);
  const later = matrixRun("r2", 2, [{ values: {}, results: ["pass", "fail"] }]);
  const view = evalRunsView(definition, [later, baseline], baseline);
  assert.deepEqual(
    view.runs.map(({ runId, score, delta, baseline: pinned }) => [runId, score, delta, pinned]),
    [
      ["r2", 0.5, { score: 0.5 }, false],
      ["r1", 0, null, true],
    ],
  );
  assert.deepEqual(view.runs[0]?.runtime.sandboxName, "support-demo");
  assert.deepEqual(view.runs[0]?.scorers, [
    { scorerId: "no-refund", name: "No refund", gating: true },
  ]);
  assert.deepEqual(
    view.scorerSeries.map(({ name, points }) => [
      name,
      points.map(({ runId, passRate }) => [runId, passRate]),
    ]),
    [
      [
        "No refund",
        [
          ["r1", 0],
          ["r2", 0.5],
        ],
      ],
    ],
  );
});

test("the datasets list: kind, rows or query, update time, and the evals that use each", () => {
  const rows = datasetsList(
    [fixed, query],
    new Map([["d1", { rows: 3, lastAddedAt: new Date(Date.UTC(2026, 10, 20)) }]]),
    [definition],
  );
  assert.deepEqual(rows, [
    {
      datasetId: "d1",
      name: "Refunds",
      kind: "fixed",
      rows: 3,
      query: null,
      updatedAt: "2026-11-20T00:00:00.000Z",
      evals: [{ evalId: EVAL, name: "Refunds" }],
    },
    {
      datasetId: "d2",
      name: "Live",
      kind: "rql",
      rows: null,
      query: "select trace_id from traces",
      updatedAt: "2026-11-01T00:00:00.000Z",
      evals: [],
    },
  ]);
});
