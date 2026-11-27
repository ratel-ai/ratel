import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { CaseEditor } from "@/components/console/evals/CaseEditor";
import { DatasetsList } from "@/components/console/evals/DatasetsList";
import { DatasetView } from "@/components/console/evals/DatasetView";
import { EvalPageView } from "@/components/console/evals/EvalPageView";
import { EvalsOverview } from "@/components/console/evals/EvalsOverview";
import { ExperimentView } from "@/components/console/evals/ExperimentView";
import {
  emptyDraft,
  NewEvalFields,
  type NewEvalOptions,
} from "@/components/console/evals/NewEvalDialog";
import { SaveAsEvalCase } from "@/components/console/evals/SaveAsEvalCase";
import { TrialPanel } from "@/components/console/evals/TrialPanel";
import { resolveConfig } from "@/config";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { datasetPageModel, datasetsPageModel } from "../dataset-pages";
import type { CaseVersion } from "../domain/case";
import type { Experiment, Trial } from "../domain/experiment";
import { pairedTrials } from "../domain/paired-trials";
import { evalsPageModel } from "../evals-page";
import { evalsEnabledForProject, evalsOffForAll, evalsOrganizationIds } from "../gate";
import {
  type CaseEditorModel,
  type CaseVersionView,
  experimentPageModel,
  PREVIEW_CHARS,
} from "../page-model";
import { run } from "./runs";
import { content, NO_REFUND } from "./support";

const NOW = "2026-11-25T10:00:00.000Z";
const version = (over: Partial<CaseVersionView> = {}): CaseVersionView => ({
  ...content(),
  id: "v1",
  caseId: "c1",
  number: 1,
  sourceTurnId: "t1",
  sourceOutput: "Refunded.",
  updatedAt: NOW,
  ...over,
});
const model = (over: Partial<CaseEditorModel> = {}): CaseEditorModel => ({
  projectId: PROJECT_ID,
  canEdit: true,
  id: "c1",
  name: "Late refund",
  labels: ["task: refunds"],
  evalId: "e1",
  evals: [{ id: "e1", name: "Refunds", scorers: [NO_REFUND] }],
  current: version(),
  ...over,
});
const labels = (evalsPage: boolean) =>
  flattenNav(consoleNav({ projectId: PROJECT_ID, additions: [], evalsPage })).map(
    ({ label }) => label,
  );

test("evals are off by default, and FF_EVALS=1 turns them on", async () => {
  assert.equal(await evalsEnabledForProject("p1", { config: resolveConfig() }), false);
  assert.equal(evalsOffForAll({ config: resolveConfig(), port: undefined }), true);
  const config = resolveConfig({ env: { FF_EVALS: "1" } });
  assert.equal(await evalsEnabledForProject("p1", { config }), true);
  assert.deepEqual(await evalsOrganizationIds([{ id: "o1" }], { config }), ["o1"]);
});

test("the rail has Evals and Datasets only with the flag on", () => {
  assert.ok(labels(true).includes("Evals"));
  assert.ok(labels(true).includes("Datasets"));
  assert.ok(!labels(false).includes("Evals"));
  assert.ok(!labels(false).includes("Datasets"));
});

test("the editor of a case shows the version that counts, and saves a new version", () => {
  const html = render(
    createElement(CaseEditor, { model: model({ current: version({ id: "v2", number: 2 }) }) }),
  );
  const text = visibleText(html);
  assert.match(text, /Version 2 counts in eval runs\. A save adds a new version\./);
  assert.match(text, /Save/);
  assert.doesNotMatch(text, /draft|approve/i);
  assert.match(text, /No refund \(gating\): tools is not refund_order/);
  assert.match(html, /traces\/turns\/t1/);
});

test("a support session sees no action", () => {
  const html = render(createElement(CaseEditor, { model: model({ canEdit: false }) }));
  assert.doesNotMatch(html, /<button[^>]*>Save<\/button>/);
});

test("the turn page shows the action behind the flag, and the pages are under the gated layout", () => {
  const source = (path: string) =>
    readFileSync(
      fileURLToPath(new URL(`../../../../app/(console)/${path}`, import.meta.url)),
      "utf8",
    );
  const page = source("project/[projectId]/traces/turns/[turnId]/page.tsx");
  assert.match(
    page,
    /evalsEnabledForProject\(project\.id\)\) &&\s*!\(await isRestrictedBySupportSession\(\)\) &&\s*\(await contentOptIn\(project\.id\)\);\s*const saveAction = canSave \? \(?\s*<SaveAsEvalCase/,
  );
  assert.match(source("../(evals)/project/[projectId]/layout.tsx"), /notFound\(\)/);
});

test("save as eval case is one button on the turn page and on the run panel; the dialog opens on a click", () => {
  const turn = visibleText(
    render(createElement(SaveAsEvalCase, { projectId: PROJECT_ID, source: { turnId: "t1" } })),
  );
  assert.match(turn, /Save as eval case/);
  assert.ok(!turn.includes("Create the eval"), "the dialog is closed until a click");
  const run = visibleText(
    render(
      createElement(SaveAsEvalCase, {
        projectId: PROJECT_ID,
        label: "Save as case",
        source: { traceId: null, name: "x", content: { input: "hi", expectedOutput: null } },
      }),
    ),
  );
  assert.match(run, /Save as case/);
  const panel = readFileSync(
    fileURLToPath(
      new URL("../../../../components/console/sandboxes/SandboxRunOnce.tsx", import.meta.url),
    ),
    "utf8",
  );
  assert.match(panel, /<SaveAsEvalCase\b[\s\S]*traceId: run\.traceId/);
});

const gridTrial = (over: Partial<Trial>): Trial => ({
  id: crypto.randomUUID(),
  experimentId: "e1",
  caseVersionId: "v1",
  variant: 0,
  index: 0,
  state: "done",
  result: "pass",
  reason: null,
  scorers: [],
  costUsd: 0.01,
  durationMs: 900,
  traceId: "c".repeat(32),
  sandboxRunId: "r1",
  ...over,
});
const NO_REFUND_FAIL = {
  scorerId: "s",
  name: "No refund",
  kind: "check" as const,
  gating: true,
  status: "fail" as const,
  reason: "tools ne refund_order: the value is there.",
};
const gridExperiment: Experiment = {
  id: "e1",
  projectId: PROJECT_ID,
  organizationId: "o1",
  evalId: null,
  datasetId: null,
  variants: [],
  changes: {},
  name: "Refunds with the new prompt",
  labelFilter: "refunds",
  sandboxVersionId: "sv1",
  sandboxName: "support-demo",
  gitCommit: "b".repeat(40),
  gitDirty: false,
  params: { tone: "formal", offerRefund: true },
  trialsPerCase: 3,
  evalVersions: [],
  caseVersions: [
    { caseId: "c1", versionId: "v1", number: 2, name: "Late refund" },
    { caseId: "c2", versionId: "v2", number: 1, name: "Status" },
  ],
  scorerSnapshots: {
    v1: [{ ...NO_REFUND, hash: "h" }],
    v2: [
      { ...NO_REFUND, hash: "h" },
      {
        id: "j",
        name: "Polite",
        gating: false,
        definition: { kind: "judge", config: { prompt: "Polite?", output: "boolean" } },
        hash: "j",
      },
    ],
  },
  startedBy: "u",
  state: "completed",
  createdAt: new Date(NOW),
  finishedAt: new Date(NOW),
};
const gridTrials = (): { trials: Trial[]; outputs: Map<string, string> } => {
  const trials = [
    gridTrial({ id: "t1", scorers: [{ ...NO_REFUND_FAIL, status: "pass", reason: "ok" }] }),
    gridTrial({ id: "t2", index: 1, result: "fail", scorers: [NO_REFUND_FAIL], costUsd: 0.03 }),
    gridTrial({
      id: "t3",
      index: 2,
      result: "invalid",
      reason: "timed_out: no result",
      traceId: null,
      costUsd: null,
      durationMs: null,
    }),
    gridTrial({ id: "t4", caseVersionId: "v2", result: null, state: "running", costUsd: null }),
  ];
  return {
    trials,
    outputs: new Map([
      ["t1", "It is refunded."],
      ["t2", "x".repeat(400)],
    ]),
  };
};

test("the grid rows hold the input, the outputs, the expected output and raw scorer counts", () => {
  const { trials, outputs } = gridTrials();
  const versions = [
    { ...version(), id: "v1", input: { message: "refund A200" }, expectedOutput: "Refunded." },
  ] as unknown as CaseVersion[];
  const model = experimentPageModel(gridExperiment, trials, { versions, outputs });
  assert.deepEqual(model.scorers, [
    { name: "No refund", gating: true },
    { name: "Polite", gating: false },
  ]);
  assert.equal(model.name, "Refunds with the new prompt");
  assert.equal(model.labelFilter, "refunds");
  assert.equal(model.costUsd, 0.04);
  const [late, status] = model.rows;
  assert.equal(late?.input, '{"message":"refund A200"}');
  assert.equal(late?.expectedOutput, "Refunded.");
  assert.deepEqual(late?.scorerCounts, { "No refund": { pass: 1, fail: 1, notScored: 0 } });
  assert.deepEqual(late?.counts, { pass: 1, fail: 1, invalid: 1, open: 0 });
  assert.equal(late?.durationMs, 900);
  assert.equal(late?.costUsd, 0.04);
  assert.deepEqual(
    late?.trials.map(({ output }) => output?.length ?? null),
    ["It is refunded.".length, PREVIEW_CHARS, null],
  );
  // A case version that is gone keeps its row, with empty text.
  assert.equal(status?.input, "");
  assert.equal(status?.expectedOutput, null);
  assert.deepEqual(status?.scorerCounts, {});
  assert.equal(status?.costUsd, null);
});

test("the experiment page is a grid: an invalid trial shows its reason and no pass or fail", () => {
  const { trials, outputs } = gridTrials();
  const versions = [
    { ...version(), id: "v1", input: { message: "refund A200" }, expectedOutput: "Refunded." },
  ] as unknown as CaseVersion[];
  const model = experimentPageModel(gridExperiment, trials, { versions, outputs });
  const html = render(
    createElement(ExperimentView, { model, baseline: "none", canEdit: true, now: NOW }),
  );
  const text = visibleText(html);
  for (const part of [
    "Refunds with the new prompt",
    "support-demo",
    "sv1",
    "bbbbbbbbbbbb",
    "tone=formal",
    "offerRefund=true",
    "refunds",
    "Late refund",
    "refund A200",
    "It is refunded.",
    "Refunded.",
    "No refund",
    "1 pass",
    "1 fail",
    "Running…",
  ]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(html.includes("<table"), "a grid");
  // Trial 3 of the first row is invalid: the row shows its reason, with no pass or fail mark.
  const invalid = experimentPageModel(
    gridExperiment,
    trials.map((trial) => (trial.id === "t3" ? trial : { ...trial, caseVersionId: "v2" })),
    { versions, outputs },
  );
  const invalidText = visibleText(
    render(
      createElement(ExperimentView, {
        model: invalid,
        baseline: "none",
        canEdit: true,
        now: NOW,
      }),
    ),
  );
  const row = invalidText.slice(invalidText.indexOf("Late refund"), invalidText.indexOf("Status"));
  assert.match(row, /Invalid\s+timed_out: no result/);
  assert.doesNotMatch(row, /\b(pass|fail)\b/i);
});

test("a trial of the side panel shows its scorers with reasons, and a link to its trace", () => {
  const html = render(
    createElement(TrialPanel, {
      projectId: PROJECT_ID,
      trial: gridTrial({ index: 1, result: "fail", scorers: [NO_REFUND_FAIL] }),
      showLogs: true,
    }),
  );
  const text = visibleText(html);
  assert.match(text, /Trial 2\s*Fail/);
  assert.match(text, /No refund\s*gating\s*tools ne refund_order/);
  assert.match(text, /Logs/);
  assert.match(html, new RegExp(`traces/${"c".repeat(32)}`));
});

test("the trials of a case are paired by index, with gaps and with one side", () => {
  const trial = (id: string, index: number) => ({ id, index });
  const ids = (pairs: ReturnType<typeof pairedTrials<{ id: string; index: number }>>) =>
    pairs.map(({ index, baseline, candidate }) => [index, baseline?.id, candidate?.id]);
  const left = [trial("b2", 2), trial("b0", 0)];
  const right = [trial("c0", 0), trial("c1", 1), trial("c2", 2)];
  assert.deepEqual(ids(pairedTrials(left, right)), [
    [0, "b0", "c0"],
    [1, undefined, "c1"],
    [2, "b2", "c2"],
  ]);
  assert.deepEqual(ids(pairedTrials(null, [trial("c0", 0)])), [[0, undefined, "c0"]]);
  assert.deepEqual(ids(pairedTrials([trial("b0", 0)], null)), [[0, "b0", undefined]]);
});

test("a completed run can be pinned as the baseline of its eval, and unpinned", () => {
  const { experiment, trials } = run("b", { refunds: { cases: { one: ["pass"] } } });
  const text = (baseline: "this" | "other" | "none", canEdit = true) =>
    visibleText(
      render(
        createElement(ExperimentView, {
          model: experimentPageModel(experiment, trials),
          baseline,
          canEdit,
          now: NOW,
        }),
      ),
    );
  assert.match(text("none"), /Pin as baseline/);
  assert.match(text("other"), /Pin as baseline/);
  assert.match(text("this"), /Unpin baseline/);
  assert.doesNotMatch(text("other", false), /Pin as baseline/);
});

test("the Datasets page lists each dataset with its kind, cases or query, and its evals", () => {
  const rows = datasetsPageModel(PROJECT_ID, [
    {
      datasetId: "d1",
      name: "Refund asks",
      description: "Asks for a refund",
      kind: "fixed",
      rows: 3,
      query: null,
      updatedAt: NOW,
      evals: [{ evalId: "e1", name: "Refunds" }],
    },
    {
      datasetId: "d2",
      name: "Errors",
      description: null,
      kind: "rql",
      rows: null,
      query: "select trace_id from traces where has_error",
      updatedAt: NOW,
      evals: [],
    },
  ]);
  const html = render(
    createElement(DatasetsList, {
      projectId: PROJECT_ID,
      rows,
      options: { turns: [], tasks: [] },
      canEdit: true,
      now: NOW,
    }),
  );
  const text = visibleText(html);
  for (const word of [
    "New dataset",
    "Refund asks",
    "Asks for a refund",
    "3 cases",
    "RQL query",
    "Refunds",
    "No eval",
  ]) {
    assert.match(text, new RegExp(word));
  }
  assert.match(html, /select trace_id from traces where has_error/);
  assert.match(html, new RegExp(`/project/${PROJECT_ID}/datasets/d1`));
  assert.doesNotMatch(text, /experiment/i);
});

test("a dataset page links each trace row to its trace, and a query page says a run freezes the rows", () => {
  const at = new Date(NOW);
  const dataset = {
    id: "d1",
    projectId: PROJECT_ID,
    name: "Refund asks",
    description: null,
    createdBy: "u",
    createdAt: at,
    updatedAt: at,
  };
  const fixed = datasetPageModel({
    projectId: PROJECT_ID,
    dataset: { ...dataset, query: { kind: "fixed" } },
    rows: [
      {
        id: "r1",
        projectId: PROJECT_ID,
        datasetId: "d1",
        evalId: null,
        name: "From a turn",
        labels: [],
        createdAt: at,
        versions: [{ ...version({ input: { message: "refund A200" } }), updatedAt: at }],
      },
    ],
    evals: [],
  });
  const options = { turns: [], tasks: [] };
  const html = render(
    createElement(DatasetView, { model: fixed, options, canEdit: true, now: NOW }),
  );
  assert.match(visibleText(html), /refund A200/);
  assert.match(visibleText(html), /Add rows/);
  assert.match(visibleText(html), /Remove/);
  assert.match(html, new RegExp(`/project/${PROJECT_ID}/traces/turns/t1`));
  const query = datasetPageModel({
    projectId: PROJECT_ID,
    dataset: { ...dataset, query: { kind: "rql", text: "select trace_id from traces", limit: 50 } },
    rows: [],
    evals: [],
  });
  const queryHtml = render(
    createElement(DatasetView, { model: query, options, canEdit: true, now: NOW }),
  );
  const queryText = visibleText(queryHtml);
  assert.match(queryText, /A run freezes the rows/);
  assert.match(queryText, /What it resolves now/);
  assert.match(queryHtml, /select trace_id from traces/);
  assert.doesNotMatch(queryText, /Add rows/);
});

test("the Evals page is a chart, a filter and a table of four columns, with New eval", () => {
  const model = evalsPageModel({
    projectId: PROJECT_ID,
    definitions: [{ id: "e1", createdAt: new Date(NOW) }],
    overview: [
      {
        evalId: "e1",
        name: "Order questions",
        cases: 6,
        scorers: 2,
        baselineScore: 0.5,
        newestScore: 0.75,
        series: [
          { experimentId: "r1", at: "2026-11-24T10:00:00.000Z", score: 0.5 },
          { experimentId: "r2", at: "2026-11-25T09:00:00.000Z", score: 0.75 },
        ],
      },
    ],
  });
  const html = render(
    createElement(EvalsOverview, {
      model,
      options: { sandboxes: [], datasets: [], tasks: [], scorers: [] },
      canEdit: true,
      now: NOW,
    }),
  );
  const text = visibleText(html);
  for (const word of [
    "New eval",
    "Order questions",
    "Cases",
    "Scorers",
    "Baseline score",
    "50%",
    "75%",
  ]) {
    assert.match(text, new RegExp(word));
  }
  assert.match(html, /aria-label="Score of each eval by run"/);
  assert.match(html, /<polyline/);
  assert.match(html, /Filter evals/);
  assert.doesNotMatch(text, /Start run|Run evals|New case|[Ee]xperiment/);
});

test("the New eval dialog shows Production agent as a runtime that comes later", () => {
  const options: NewEvalOptions = {
    sandboxes: [
      {
        name: "support-demo",
        versions: [
          {
            id: "v1",
            commit: "a".repeat(40),
            createdAt: NOW,
            params: [
              {
                name: "model",
                type: "enum",
                default: "small",
                description: null,
                options: ["small", "large"],
              },
            ],
          },
        ],
      },
    ],
    datasets: [{ id: "d1", name: "Order asks", kindLabel: "Fixed" }],
    tasks: [],
    scorers: [],
  };
  const html = render(
    createElement(NewEvalFields, {
      projectId: PROJECT_ID,
      options,
      draft: emptyDraft(options),
      set: () => {},
      chooseSandbox: () => {},
      problem: null,
    }),
  );
  const text = visibleText(html);
  assert.match(text, /Production agent/);
  assert.match(text, /Coming soon/);
  assert.match(
    html,
    /<button[^>]*disabled[^>]*value="production"|<button[^>]*value="production"[^>]*disabled/,
  );
  for (const word of [
    "Runtime",
    "Dataset",
    "Parameters",
    "Matrix",
    "Scorers",
    "This project",
    "Pre-defined",
    "Trials",
  ]) {
    assert.match(text, new RegExp(word));
  }
});

test("a matrix run shows its variants side by side, with the param values in the header", () => {
  const { experiment, trials } = run("m", { refunds: { cases: { one: ["pass", "fail"] } } });
  const matrix: Experiment = {
    ...experiment,
    evalId: "e1",
    variants: [
      { index: 0, params: { model: "small", style: "plain" } },
      { index: 1, params: { model: "small", style: "shout" } },
    ],
  };
  const split = trials.map((trial, at) => ({ ...trial, variant: at % 2 }));
  const html = render(
    createElement(ExperimentView, {
      model: experimentPageModel(matrix, split),
      baseline: "none",
      canEdit: true,
      now: NOW,
    }),
  );
  const text = visibleText(html);
  assert.match(text, /Variants side by side/);
  assert.match(text, /style=plain/);
  assert.match(text, /style=shout/);
  assert.doesNotMatch(text, /model=small/);
  assert.match(text, /Matrix \(2 variants\)/);
  assert.match(html, /\/evals\/experiments\/m\/trials\//);
});

test("the eval page shows its definition, the scorer chart and the runs with their columns", () => {
  const html = render(
    createElement(EvalPageView, {
      model: {
        projectId: PROJECT_ID,
        evalId: "e1",
        name: "Orders",
        taskId: null,
        definition: {
          dataset: {
            name: "Order asks",
            kindLabel: "Fixed",
            href: `/project/${PROJECT_ID}/datasets/d1`,
          },
          runtime: "support-demo · newest ready version",
          scorers: ["No refund"],
          trials: 3,
          params: [],
          matrix: "matrix (2)",
        },
        chart: {
          runs: 2,
          series: [
            {
              id: "mean",
              name: "Score (mean)",
              slot: 0,
              points: [
                { experimentId: "r1", href: "/r1", at: "2026-11-24T10:00:00.000Z", score: 0.5 },
                { experimentId: "r2", href: "/r2", at: "2026-11-25T09:00:00.000Z", score: 1 },
              ],
            },
          ],
        },
        runs: [
          {
            experimentId: "r2",
            href: "/r2",
            title: "Fixed prompt",
            at: "2026-11-25T09:00:00.000Z",
            running: false,
            dataset: { name: "Order asks", rows: 4, href: "/d1" },
            runtime: { sandbox: "support-demo", version: "66666666", commit: "aaaaaaaaaaaa" },
            scorers: 1,
            params: "matrix (2)",
            score: 1,
            delta: 0.5,
            deltaNote: null,
            invalid: 1,
            isBaseline: false,
            changed: ["pinned 66666666"],
          },
        ],
        baselineId: "r1",
      },
      options: {
        defaults: { datasetId: "d1", versionId: "latest", params: {}, matrix: {}, trials: 3 },
        versions: [],
        datasets: [],
        turns: [],
        scorers: [],
        evalScorers: ["No refund"],
      },
      canEdit: true,
      now: NOW,
    }),
  );
  const text = visibleText(html);
  for (const word of [
    "Edit",
    "New run",
    "Order asks",
    "support-demo · newest ready version",
    "No refund",
    "Fixed prompt",
    "4 frozen rows",
    "aaaaaaaaaaaa",
    "matrix \\(2\\)",
    "100%",
    "\\+50 pts",
    "Changed: pinned 66666666",
    "Pin as baseline",
  ]) {
    assert.match(text, new RegExp(word));
  }
  assert.match(html, /aria-label="Mean and pass rate of each scorer by run"/);
});
