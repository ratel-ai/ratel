import assert from "node:assert/strict";
import { test } from "node:test";
import type { Compared } from "../baseline";
import { datasetPageModel, datasetsPageModel, filterDatasets, KIND_LABELS } from "../datasets-page";
import type { EvalCase } from "../domain/case";
import type { Dataset } from "../domain/dataset";
import type { EvalDefinition, EvalScorer } from "../domain/eval";
import type { TrialResult } from "../domain/score";
import { changedText, evalPageModel, paramsText } from "../eval-page";
import { evalsPageModel, filterEvals } from "../evals-page";
import { evalHistory, evalsOverview } from "../history-view";
import type { DatasetSummary } from "../ports/dataset-store";
import { runPageModel } from "../run-page";
import { percent, points, scoreChart } from "../score-chart";
import { POLITE, run } from "./runs";
import { evalContent, NO_REFUND, PROJECT_ID } from "./support";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 10, minute));

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
    name: `Eval ${id}`,
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

function summary(id: string, over: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    id,
    projectId: PROJECT_ID,
    name: `Data ${id}`,
    description: null,
    query: { kind: "fixed" },
    createdBy: "u",
    createdAt: at(0),
    updatedAt: at(5),
    rowCount: 2,
    ...over,
  };
}

// — Score chart ———————————————————————————————————————————————————————————————

test("a chart keeps a slot for each line in its order, and draws six at most", () => {
  const lines = Array.from({ length: 8 }, (_, index) => ({
    key: `e${index}`,
    label: `E${index}`,
    points: [
      { runId: `r${index}a`, at: at(1).toISOString(), value: 0.5 },
      { runId: `r${index}b`, at: at(2).toISOString(), value: null },
    ],
  }));
  const chart = scoreChart(lines, "evals");
  assert.deepEqual(
    chart.lines.map(({ slot }) => slot),
    [0, 1, 2, 3, 4, 5],
  );
  // A run with no score is not a point.
  assert.equal(chart.lines[0]?.points.length, 1);
  assert.match(chart.note ?? "", /first 6 evals\. 2 more are in the table/);
});

test("a chart with no run is empty, and one run says that a line needs two", () => {
  const empty = scoreChart([{ key: "e", label: "E", points: [] }]);
  assert.equal(empty.runs, 0);
  assert.equal(empty.start, null);
  assert.equal(empty.note, null);
  const one = scoreChart([
    { key: "e", label: "E", points: [{ runId: "r", at: at(1).toISOString(), value: 1.4 }] },
  ]);
  assert.equal(one.runs, 1);
  assert.equal(one.lines[0]?.points[0]?.value, 1, "a score stays in 0 to 100%");
  assert.match(one.note ?? "", /One run so far/);
});

test("a mean line has no color slot of its own", () => {
  const chart = scoreChart([
    { key: "a", label: "A", points: [] },
    { key: "m", label: "Mean", mean: true, points: [] },
    { key: "b", label: "B", points: [] },
  ]);
  assert.deepEqual(
    chart.lines.map(({ slot }) => slot),
    [0, "mean", 1],
  );
});

test("scores and deltas read as percents and points", () => {
  assert.equal(percent(0.666), "67%");
  assert.equal(percent(null), "No score");
  assert.equal(points(0.1), "+10 pts");
  assert.equal(points(-0.25), "−25 pts");
  assert.equal(points(0.001), "0 pts");
});

// — Evals page ————————————————————————————————————————————————————————————————

test("the Evals page has a line for each eval and four columns", () => {
  const evals = [definition("e1"), definition("e2")];
  const runs = [
    evalRun("r1", "e1", 1, ["pass", "fail"]),
    evalRun("r2", "e1", 2, ["pass", "pass"]),
    evalRun("r3", "e2", 3, ["fail"]),
  ];
  const overview = evalsOverview({
    evals,
    rowCounts: new Map([["e1-data", 2]]),
    runs,
    baselines: new Map([["e1", "r1"]]),
  });
  const model = evalsPageModel({
    projectId: PROJECT_ID,
    overview,
    evals,
    datasets: [
      summary("e1-data"),
      summary("e2-data", { query: { kind: "last_traces", limit: 20 }, rowCount: 0 }),
    ],
  });
  assert.deepEqual(
    model.chart.lines.map(({ label, points: line }) => [label, line.map(({ value }) => value)]),
    [
      ["Eval e1", [0.5, 1]],
      ["Eval e2", [0]],
    ],
  );
  assert.deepEqual(
    model.rows.map(({ name, cases, scorers, baselineScore, slot, href }) => ({
      name,
      cases,
      scorers,
      baselineScore,
      slot,
      href,
    })),
    [
      {
        name: "Eval e1",
        cases: "2",
        scorers: 1,
        baselineScore: 0.5,
        slot: 0,
        href: `/project/${PROJECT_ID}/evals/e1`,
      },
      {
        name: "Eval e2",
        cases: "Up to 20 (query)",
        scorers: 1,
        baselineScore: null,
        slot: 1,
        href: `/project/${PROJECT_ID}/evals/e2`,
      },
    ],
  );
  assert.deepEqual(
    filterEvals(model.rows, " E2 ").map(({ evalId }) => evalId),
    ["e2"],
  );
});

// — Datasets ——————————————————————————————————————————————————————————————————

test("the Datasets page shows the kind, the rows or the query, and the evals that use it", () => {
  const model = datasetsPageModel(
    PROJECT_ID,
    [
      summary("d1", { rowCount: 1 }),
      summary("d2", { query: { kind: "rql", text: "SELECT trace_id FROM traces", limit: 50 } }),
      summary("d3", { query: { kind: "task_traces", taskId: "task-9", limit: 30 } }),
    ],
    [
      definition("e1"),
      { ...definition("e2"), versions: [{ ...definition("e2").versions[0]!, datasetId: "d1" }] },
    ],
    new Map([["task-9", "Refund an order"]]),
  );
  assert.deepEqual(
    model.rows.map(({ name, kindLabel, size, rql, usedBy }) => [
      name,
      kindLabel,
      size,
      rql,
      usedBy.map(({ name: evalName }) => evalName),
    ]),
    [
      ["Data d1", "Fixed rows", "1 row", false, ["Eval e2"]],
      ["Data d2", "RQL query", "SELECT trace_id FROM traces", true, []],
      [
        "Data d3",
        "Traces of a task",
        'The last 30 traces of the task "Refund an order"',
        false,
        [],
      ],
    ],
  );
  assert.deepEqual(
    filterDatasets(model.rows, "refund").map(({ name }) => name),
    ["Data d3"],
  );
  assert.deepEqual(
    filterDatasets(model.rows, "eval e2").map(({ name }) => name),
    ["Data d1"],
  );
});

function row(
  id: string,
  over: { turnId?: string | null; input?: unknown; expected?: string | null },
): EvalCase {
  return {
    id,
    projectId: PROJECT_ID,
    datasetId: "d1",
    evalId: null,
    name: `Row ${id}`,
    labels: [],
    createdAt: at(1),
    versions: [
      {
        id: `${id}-v2`,
        caseId: id,
        number: 2,
        input: over.input ?? { message: "refund A200" },
        earlierTurns: [],
        toolFixtures: [],
        expectedOutput: over.expected ?? null,
        sourceTurnId: over.turnId ?? null,
        sourceOutput: null,
        updatedAt: at(2),
      },
    ],
  };
}

const DATASET: Dataset = {
  id: "d1",
  projectId: PROJECT_ID,
  name: "Refund asks",
  description: "Asks to refund",
  query: { kind: "fixed" },
  createdBy: "u",
  createdAt: at(0),
  updatedAt: at(3),
};

test("a dataset page links a trace row to its turn, and hides captured text by the content rule", () => {
  const rows = [
    row("a", { turnId: "turn-1", expected: "Refunded." }),
    row("b", { input: { order: "A1" }, expected: "No." }),
  ];
  const open = datasetPageModel({
    projectId: PROJECT_ID,
    dataset: DATASET,
    rows,
    evals: [],
    readContent: true,
  });
  assert.deepEqual(
    open.rows.map(({ kind, input, expectedOutput, traceHref, version }) => [
      kind,
      input,
      expectedOutput,
      traceHref,
      version,
    ]),
    [
      [
        "trace",
        '{"message":"refund A200"}',
        "Refunded.",
        `/project/${PROJECT_ID}/traces/turns/turn-1`,
        2,
      ],
      ["values", '{"order":"A1"}', "No.", null, 2],
    ],
  );
  assert.equal(open.contentWithheld, false);
  assert.equal(open.query, null);
  const closed = datasetPageModel({
    projectId: PROJECT_ID,
    dataset: DATASET,
    rows,
    evals: [],
    readContent: false,
  });
  // The trace row keeps its link and loses its text; typed values are not captured text.
  assert.deepEqual(
    closed.rows.map(({ input, expectedOutput, traceHref }) => [
      input,
      expectedOutput,
      traceHref !== null,
    ]),
    [
      [null, null, true],
      ['{"order":"A1"}', "No.", false],
    ],
  );
  assert.equal(closed.contentWithheld, true);
});

test("a query dataset page shows its query in words and its RQL text", () => {
  const model = datasetPageModel({
    projectId: PROJECT_ID,
    dataset: { ...DATASET, query: { kind: "rql", text: "SELECT trace_id FROM traces", limit: 40 } },
    rows: [],
    evals: [definition("e1")],
    readContent: true,
  });
  assert.deepEqual(model.query, {
    words: "Up to 40 traces of an RQL query",
    rql: "SELECT trace_id FROM traces",
    limit: 40,
    taskId: null,
  });
  assert.equal(model.kindLabel, KIND_LABELS.rql);
});

// — One eval ——————————————————————————————————————————————————————————————————

test("an eval page has a line for each scorer and the mean, and a row for each run", () => {
  const scorers = [NO_REFUND, POLITE];
  const def = definition("e1", scorers);
  const first = evalRun("r1", "e1", 1, ["pass", "fail"], scorers);
  first.experiment.gitCommit = "abcdef1234";
  const second = evalRun("r2", "e1", 2, ["pass", "pass", "invalid"], scorers);
  second.experiment.name = "Fixed prompt";
  second.experiment.variants = [
    { index: 0, params: { tone: "formal" } },
    { index: 1, params: { tone: "friendly" } },
  ];
  second.experiment.changes = { matrix: { tone: ["formal", "friendly"] }, addedRows: 2 };
  const runs = [first, second];
  const history = evalHistory({ definition: def, runs, baseline: first });
  const model = evalPageModel({
    projectId: PROJECT_ID,
    definition: def,
    history,
    runs,
    datasets: new Map([["e1-data", { name: "Refund asks", kind: "fixed" as const }]]),
    kindLabels: KIND_LABELS,
  });
  assert.deepEqual(
    model.chart.lines.map(({ label, slot }) => [label, slot]),
    [
      ["No refund", 0],
      ["Polite", 1],
      ["Score (mean)", "mean"],
    ],
  );
  const [newest, oldest] = model.runs;
  assert.equal(newest?.runId, "r2");
  assert.equal(newest?.name, "Fixed prompt");
  assert.equal(newest?.params, "matrix (2)");
  assert.equal(newest?.invalid, 1);
  assert.deepEqual(newest?.changed, ["2 added rows", "matrix"]);
  assert.equal(newest?.isBaseline, false);
  assert.equal(newest?.canPin, true);
  assert.equal(typeof newest?.delta, "number");
  assert.equal(newest?.href, `/project/${PROJECT_ID}/evals/e1/runs/r2`);
  assert.deepEqual(oldest?.dataset, {
    id: "e1-data",
    name: "Refund asks",
    href: `/project/${PROJECT_ID}/datasets/e1-data`,
    rows: 1,
  });
  assert.equal(oldest?.runtime.commit, "abcdef1");
  assert.equal(oldest?.isBaseline, true);
  assert.equal(oldest?.canPin, false);
  assert.equal(oldest?.params, "Defaults");
  assert.equal(model.definition.runtime.text, "The sandbox of each run");
  assert.deepEqual(
    model.definition.scorers.map(({ name, source }) => [name, source]),
    [
      ["No refund", "This eval"],
      ["Polite", "This eval"],
    ],
  );
});

test("params and changes read in words", () => {
  assert.equal(
    paramsText({ tone: "formal", model: "haiku", n: 2 }),
    "model=haiku, n=2, tone=formal",
  );
  assert.deepEqual(changedText({}), []);
  assert.deepEqual(
    changedText({
      datasetId: "d",
      scorers: true,
      sandboxVersionId: "v",
      trials: 1,
      params: { a: 1 },
    }),
    ["dataset", "scorers", "runtime version", "params", "trials"],
  );
});

// — One run ———————————————————————————————————————————————————————————————————

test("a matrix run shows its variants side by side, each with the output and the scorers", () => {
  const made = evalRun("r1", "e1", 1, ["pass", "fail"]);
  made.experiment.variants = [
    { index: 0, params: { model: "sonnet" } },
    { index: 1, params: { model: "haiku" } },
  ];
  // The same row in the second variant: one fail.
  const [first] = made.trials;
  assert.ok(first);
  made.trials.push({
    ...first,
    id: "v1-t0",
    variant: 1,
    result: "fail",
    scorers: first.scorers.map((one) => ({ ...one, status: "fail" })),
  });
  const versionId = made.experiment.caseVersions[0]?.versionId ?? "";
  const model = runPageModel({
    projectId: PROJECT_ID,
    evalId: "e1",
    experiment: made.experiment,
    trials: made.trials,
    versions: [
      {
        id: versionId,
        caseId: "a",
        number: 1,
        input: "refund A200",
        earlierTurns: [],
        toolFixtures: [],
        expectedOutput: "No refund.",
        sourceTurnId: null,
        sourceOutput: null,
        updatedAt: at(0),
      },
    ],
    outputs: new Map([
      [first.id, "I cannot refund."],
      ["v1-t0", "Refunded!"],
    ]),
  });
  assert.deepEqual(
    model.variants.map(({ label, counts }) => [label, counts.pass, counts.fail]),
    [
      ["model=sonnet", 1, 1],
      ["model=haiku", 0, 1],
    ],
  );
  assert.deepEqual(model.scorers, [{ name: "No refund", gating: true }]);
  const [gridRow] = model.rows;
  assert.equal(gridRow?.input, "refund A200");
  assert.equal(gridRow?.expectedOutput, "No refund.");
  assert.deepEqual(
    gridRow?.cells.map(({ output, scorers, trials }) => [
      output,
      scorers["No refund"],
      trials.map(({ href }) => href.endsWith(`/evals/e1/runs/r1/trials/${trials[0]?.trialId}`)),
    ]),
    [
      ["I cannot refund.", { pass: 1, rated: 2 }, [true, false]],
      ["Refunded!", { pass: 0, rated: 1 }, [true]],
    ],
  );
});

test("a run with no matrix has one column, and a suite run shows the rows of the eval only", () => {
  const made = run("r1", {
    e1: { cases: { a: ["pass"] } },
    e2: { cases: { b: ["fail"] } },
  });
  const model = runPageModel({
    projectId: PROJECT_ID,
    evalId: "e2",
    experiment: made.experiment,
    trials: made.trials,
    versions: [],
    outputs: new Map(),
  });
  assert.deepEqual(
    model.variants.map(({ label }) => label),
    ["This run"],
  );
  assert.deepEqual(
    model.rows.map(({ name, input }) => [name, input]),
    [["b", ""]],
  );
  assert.equal(model.score, 0);
});

test("a run grid hides the input of a trace row when the project does not let Ratel read captured text", () => {
  const made = evalRun("r1", "e1", 1, ["pass"]);
  const versionId = made.experiment.caseVersions[0]?.versionId ?? "";
  const version = {
    id: versionId,
    caseId: "a",
    number: 1,
    input: "refund A200",
    earlierTurns: [],
    toolFixtures: [],
    expectedOutput: "No refund.",
    sourceTurnId: "turn-1",
    sourceOutput: null,
    updatedAt: at(0),
  };
  const model = (readContent: boolean) =>
    runPageModel({
      projectId: PROJECT_ID,
      evalId: "e1",
      experiment: made.experiment,
      trials: made.trials,
      versions: [version],
      outputs: new Map(),
      readContent,
    });
  assert.equal(model(true).rows[0]?.input, "refund A200");
  assert.equal(model(false).rows[0]?.input, null);
  assert.equal(model(false).rows[0]?.expectedOutput, null);
  assert.equal(model(false).contentWithheld, true);
  // Typed values are not captured text.
  const typed = runPageModel({
    projectId: PROJECT_ID,
    evalId: "e1",
    experiment: made.experiment,
    trials: made.trials,
    versions: [{ ...version, sourceTurnId: null }],
    outputs: new Map(),
    readContent: false,
  });
  assert.equal(typed.rows[0]?.input, "refund A200");
  assert.equal(typed.contentWithheld, false);
});
