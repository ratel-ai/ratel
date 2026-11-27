import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParamSpec } from "@/lib/views/sandboxes/run-form";
import {
  type EvalDraft,
  evalRequestOf,
  LATEST,
  matrixOf,
  type RunDefaults,
  type RunDraft,
  runDraftOf,
  runRequestOf,
  scorerGroups,
  searchScorers,
} from "../eval-dialog";
import { CHART_SLOTS, evalsPageModel, filterEvals, percent, timeLabel } from "../evals-page";
import type { EvalOverviewRow } from "../history-view";
import type { LibraryEntry } from "../scorer-library";

const P = "11111111-1111-4111-8111-111111111111";
const at = (day: number) => new Date(Date.UTC(2026, 10, day)).toISOString();

function row(evalId: string, scores: Array<number | null>, over: Partial<EvalOverviewRow> = {}) {
  return {
    evalId,
    name: evalId,
    cases: 4,
    scorers: 2,
    baselineScore: null,
    newestScore: scores.at(-1) ?? null,
    series: scores.map((score, index) => ({
      experimentId: `${evalId}-r${index}`,
      at: at(index + 1),
      score,
    })),
    ...over,
  } satisfies EvalOverviewRow;
}

const created = (id: string, day: number) => ({ id, createdAt: new Date(Date.UTC(2026, 9, day)) });

test("one line for each eval with a scored run, colored by the age of the eval", () => {
  const page = evalsPageModel({
    projectId: P,
    definitions: [created("b", 2), created("a", 1), created("c", 3)],
    overview: [row("c", []), row("b", [0.5, 0.75]), row("a", [1], { baselineScore: 1 })],
  });
  assert.deepEqual(
    page.chart.series.map(({ id, slot, points }) => [id, slot, points.length]),
    [
      ["a", 0, 1],
      ["b", 1, 2],
    ],
  );
  assert.equal(page.chart.runs, 3);
  assert.equal(page.chart.hidden, 0);
  assert.equal(page.chart.series[0]?.points[0]?.href, `/project/${P}/evals/experiments/a-r0`);
  assert.deepEqual(
    page.rows.map(({ evalId, cases, scorers, baselineScore, slot, href }) => [
      evalId,
      cases,
      scorers,
      baselineScore,
      slot,
      href,
    ]),
    [
      ["a", 4, 2, 1, 0, `/project/${P}/evals/a`],
      ["b", 4, 2, null, 1, `/project/${P}/evals/b`],
      ["c", 4, 2, null, null, `/project/${P}/evals/c`],
    ],
  );
});

test("the chart draws the six evals with the newest runs, and says how many it leaves out", () => {
  const ids = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"];
  const overview = ids.map((id, index) =>
    row(id, [0.5], { series: [{ experimentId: `${id}-r`, at: at(index + 1), score: 0.5 }] }),
  );
  const page = evalsPageModel({
    projectId: P,
    definitions: ids.map((id, index) => created(id, index + 1)),
    overview,
  });
  assert.equal(page.chart.series.length, CHART_SLOTS);
  assert.equal(page.chart.hidden, 2);
  assert.deepEqual(
    page.chart.series.map(({ id, slot }) => [id, slot]),
    [
      ["e3", 0],
      ["e4", 1],
      ["e5", 2],
      ["e6", 3],
      ["e7", 4],
      ["e8", 5],
    ],
  );
  assert.equal(page.rows.find(({ evalId }) => evalId === "e1")?.slot, null);
});

test("no run draws no line; the filter keeps the chart's colors", () => {
  const page = evalsPageModel({
    projectId: P,
    definitions: [created("a", 1), created("b", 2)],
    overview: [row("a", [null]), row("b", [0.2])],
  });
  assert.deepEqual(
    page.chart.series.map(({ id }) => id),
    ["b"],
  );
  assert.deepEqual(
    filterEvals(page.rows, " B ").map(({ evalId, slot }) => [evalId, slot]),
    [["b", 0]],
  );
  assert.equal(filterEvals(page.rows, "").length, 2);
  assert.equal(percent(0.834), "83%");
  assert.equal(percent(null), "No score");
});

const PARAMS: ParamSpec[] = [
  { name: "model", type: "enum", default: "small", description: null, options: ["small", "large"] },
  { name: "temperature", type: "number", default: 0, description: null, options: [] },
  { name: "verbose", type: "boolean", default: false, description: null, options: [] },
];

function draft(over: Partial<EvalDraft> = {}): EvalDraft {
  return {
    name: "Orders",
    taskId: "",
    sandboxName: "support-demo",
    versionId: LATEST,
    dataset: { mode: "existing", datasetId: "d1" },
    params: { model: "small", temperature: "0", verbose: false },
    matrix: {},
    matrixOn: false,
    trials: "3",
    scorers: [{ source: "predefined", id: "is_safe", name: "Answer is safe", settings: [] }],
    ...over,
  };
}

test("the dialog sends the runtime, the dataset, the defaults, the trials and the scorer refs", () => {
  const made = evalRequestOf(
    draft({
      taskId: " wf-orders ",
      versionId: "66666666-6666-4666-8666-666666666666",
      scorers: [
        { source: "project", id: "s1", name: "Refund policy", settings: [] },
        {
          source: "predefined",
          id: "max_cost_usd",
          name: "Cost under a limit",
          settings: [{ name: "max", type: "number", value: "0.05" }],
        },
      ],
    }),
    PARAMS,
  );
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.deepEqual(made.request, {
    name: "Orders",
    taskId: "wf-orders",
    runtime: {
      sandboxName: "support-demo",
      sandboxVersionId: "66666666-6666-4666-8666-666666666666",
    },
    dataset: { datasetId: "d1" },
    params: { model: "small", temperature: 0, verbose: false },
    matrix: {},
    trials: 3,
    scorers: [
      {
        id: "project-s1",
        name: "Refund policy",
        gating: true,
        ref: { source: "project", scorerId: "s1" },
      },
      {
        id: "predefined-max_cost_usd",
        name: "Cost under a limit",
        gating: true,
        ref: { source: "predefined", key: "max_cost_usd", settings: { max: 0.05 } },
      },
    ],
  });
});

test("a query dataset, and a matrix whose params leave the defaults", () => {
  const made = evalRequestOf(
    draft({
      dataset: { mode: "query", draft: { kind: "auto", limit: "30", taskId: "", rql: "" } },
      matrixOn: true,
      matrix: { model: "small, large", temperature: "", verbose: "true,false" },
    }),
    PARAMS,
  );
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.deepEqual(made.request.dataset, { query: { kind: "auto", taskId: null, limit: 30 } });
  assert.deepEqual(made.request.matrix, { model: ["small", "large"], verbose: [true, false] });
  assert.deepEqual(made.request.params, { temperature: 0 });
});

test("a matrix over 12 combinations is refused with the count and the reason", () => {
  const ok = matrixOf(PARAMS, { model: "small, large", temperature: "0, 0.5, 1" });
  assert.deepEqual(ok, {
    ok: true,
    matrix: { model: ["small", "large"], temperature: [0, 0.5, 1] },
    count: 6,
  });
  const wide = matrixOf(PARAMS, {
    model: "small, large",
    temperature: "0, 0.2, 0.4, 0.6, 0.8, 1, 1.2",
  });
  assert.equal(wide.ok, false);
  assert.equal(wide.count, 14);
  if (!wide.ok) assert.match(wide.message, /at most 12 combinations, and this one has 14/);
  const refused = evalRequestOf(
    draft({ matrixOn: true, matrix: { temperature: "0,1,2,3,4,5,6,7,8,9,10,11,12" } }),
    PARAMS,
  );
  assert.equal(refused.ok, false);
  assert.equal(matrixOf(PARAMS, { model: "huge" }).ok, false);
  assert.equal(matrixOf(PARAMS, { verbose: "yes" }).ok, false);
  assert.equal(matrixOf(PARAMS, { temperature: "warm" }).ok, false);
  // The matrix is off: its values are not sent.
  const off = evalRequestOf(draft({ matrix: { model: "small, large" } }), PARAMS);
  assert.ok(off.ok && Object.keys(off.request.matrix).length === 0);
});

test("the dialog says what is missing", () => {
  const cases: Array<[Partial<EvalDraft>, RegExp]> = [
    [{ name: " " }, /name/],
    [{ sandboxName: "" }, /runtime/],
    [{ dataset: { mode: "existing", datasetId: "" } }, /dataset/],
    [
      {
        dataset: { mode: "query", draft: { kind: "task_traces", limit: "5", taskId: "", rql: "" } },
      },
      /task/,
    ],
    [{ trials: "0" }, /trials/],
    [{ trials: "21" }, /trials/],
    [{ scorers: [] }, /scorer/],
    [
      {
        scorers: [
          {
            source: "predefined",
            id: "expected_tool",
            name: "Tool was called",
            settings: [{ name: "tool", type: "string", value: " " }],
          },
        ],
      },
      /needs its tool/,
    ],
    [{ params: { model: "huge", temperature: "0", verbose: false } }, /model must be one of/],
  ];
  for (const [over, message] of cases) {
    const made = evalRequestOf(draft(over), PARAMS);
    assert.equal(made.ok, false, JSON.stringify(over));
    if (!made.ok) assert.match(made.message, message);
  }
});

test("the scorer picker groups the project's scorers and the pre-defined ones, and searches", () => {
  const entry = (source: LibraryEntry["source"], name: string, description: string | null = null) =>
    ({
      source,
      id: name,
      name,
      description,
      kind: "check",
      usable: true,
      why: null,
      settings: [],
      evalName: null,
    }) satisfies LibraryEntry;
  const entries = [
    entry("project", "Refund policy"),
    entry("predefined", "Answer is safe", "no harmful content"),
    entry("eval", "Old scorer"),
  ];
  const groups = scorerGroups(entries);
  assert.deepEqual(
    groups.project.map(({ name }) => name),
    ["Refund policy"],
  );
  assert.deepEqual(
    groups.predefined.map(({ name }) => name),
    ["Answer is safe"],
  );
  assert.deepEqual(
    searchScorers(entries, "HARMFUL").map(({ name }) => name),
    ["Answer is safe"],
  );
});

test("an x label is a day over a long span, and a day with its UTC time over a short one", () => {
  const at = Date.UTC(2026, 10, 27, 14, 5);
  assert.equal(timeLabel(at, 3 * 24 * 60 * 60_000), "27 Nov");
  assert.equal(timeLabel(at, 60_000), "27 Nov 14:05");
});

const DEFAULTS: RunDefaults = {
  datasetId: "d1",
  versionId: LATEST,
  params: { temperature: 0.2 },
  matrix: {},
  trials: 3,
};

test("New run starts from the defaults, and an unchanged draft runs the eval as it is", () => {
  const draft = runDraftOf(DEFAULTS, PARAMS);
  assert.deepEqual(draft.params, { model: "small", temperature: "0.2", verbose: false });
  assert.equal(draft.matrixOn, false);
  assert.deepEqual(runRequestOf(draft, DEFAULTS, PARAMS), { ok: true, request: {} });
  const withMatrix = runDraftOf({ ...DEFAULTS, matrix: { model: ["small", "large"] } }, PARAMS);
  assert.equal(withMatrix.matrixOn, true);
  assert.deepEqual(withMatrix.matrix, { model: "small, large" });
  assert.deepEqual(
    runRequestOf(withMatrix, { ...DEFAULTS, matrix: { model: ["small", "large"] } }, PARAMS),
    { ok: true, request: {} },
  );
});

test("New run sends only the changes for this run", () => {
  const draft: RunDraft = {
    ...runDraftOf(DEFAULTS, PARAMS),
    name: " Large model ",
    datasetId: "d2",
    addRows: { mode: "auto", limit: "10" },
    scorers: [{ source: "predefined", id: "is_safe", name: "Answer is safe", settings: [] }],
    versionId: "66666666-6666-4666-8666-666666666666",
    params: { model: "large", temperature: "0.2", verbose: false },
    trials: "1",
  };
  const made = runRequestOf(draft, DEFAULTS, PARAMS);
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.deepEqual(made.request, {
    name: "Large model",
    datasetId: "d2",
    addRows: { query: { kind: "auto", limit: 10 } },
    scorers: [
      {
        id: "predefined-is_safe",
        name: "Answer is safe",
        gating: true,
        ref: { source: "predefined", key: "is_safe", settings: {} },
      },
    ],
    sandboxVersion: "66666666-6666-4666-8666-666666666666",
    params: { model: "large" },
    trials: 1,
  });
  const off = runRequestOf(
    {
      ...runDraftOf({ ...DEFAULTS, matrix: { model: ["small", "large"] } }, PARAMS),
      matrixOn: false,
    },
    { ...DEFAULTS, matrix: { model: ["small", "large"] } },
    PARAMS,
  );
  assert.ok(off.ok && JSON.stringify(off.request.matrix) === "{}");
  const traces = runRequestOf(
    { ...runDraftOf(DEFAULTS, PARAMS), addRows: { mode: "traces", turnIds: [] } },
    DEFAULTS,
    PARAMS,
  );
  assert.equal(traces.ok, false);
  const wide = runRequestOf(
    {
      ...runDraftOf(DEFAULTS, PARAMS),
      matrixOn: true,
      matrix: { temperature: "0,1,2,3,4,5,6,7,8,9,10,11,12" },
    },
    DEFAULTS,
    PARAMS,
  );
  assert.equal(wide.ok, false);
});
