import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { judgeSettings } from "@/app/(evals)/project/[projectId]/evals-pages";
import { DatasetsList } from "@/components/console/evals/DatasetsList";
import { DatasetView } from "@/components/console/evals/DatasetView";
import { EvalDialog } from "@/components/console/evals/EvalDialog";
import { EvalsList } from "@/components/console/evals/EvalsList";
import { RunView } from "@/components/console/evals/RunView";
import { SaveAsEvalCase } from "@/components/console/evals/SaveAsEvalCase";
import { ScoreChart } from "@/components/console/evals/ScoreChart";
import { TrialPanel } from "@/components/console/evals/TrialPanel";
import { resolveConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import type { Trial } from "../domain/experiment";
import { pairedTrials } from "../domain/paired-trials";
import { evalsEnabledForProject, evalsOffForAll, evalsOrganizationIds } from "../gate";
import type { DialogData } from "../pages-load";
import { runPageModel } from "../run-page";
import { scoreChart } from "../score-chart";
import { run } from "./runs";

const NOW = "2026-11-27T10:00:00.000Z";
const labels = (evalsPage: boolean) =>
  flattenNav(consoleNav({ projectId: PROJECT_ID, additions: [], evalsPage })).map(
    ({ label }) => label,
  );
const Nothing = () => null;
/** The judge settings section of an edition, as Cloud fills the slot. */
const JudgeSettings = ({ projectId }: { projectId: string }) =>
  createElement("section", null, `Who judges the project ${projectId}`);
const DIALOG: DialogData = {
  sandboxes: [{ name: "support-demo", versions: [{ id: "v1", label: "abc1234", params: [] }] }],
  library: [],
  datasets: [],
  tasks: [],
};

test("evals are off by default, and FF_EVALS=1 turns them on", async () => {
  assert.equal(await evalsEnabledForProject("p1", { config: resolveConfig() }), false);
  assert.equal(evalsOffForAll({ config: resolveConfig(), port: undefined }), true);
  const config = resolveConfig({ env: { FF_EVALS: "1" } });
  assert.equal(await evalsEnabledForProject("p1", { config }), true);
  assert.deepEqual(await evalsOrganizationIds([{ id: "o1" }], { config }), ["o1"]);
});

test("the rail has Evals and Datasets only with the flag on", () => {
  for (const label of ["Evals", "Datasets"]) {
    assert.ok(labels(true).includes(label), label);
    assert.ok(!labels(false).includes(label), label);
  }
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

test("the Evals page is a chart and a table of four columns, with New eval and a filter", () => {
  const chart = scoreChart([
    {
      key: "e1",
      label: "Refunds",
      points: [
        { runId: "r1", at: "2026-11-27T09:00:00Z", value: 0.5 },
        { runId: "r2", at: "2026-11-27T10:00:00Z", value: 0.75 },
      ],
    },
  ]);
  const html = render(
    createElement(EvalsList, {
      model: {
        projectId: PROJECT_ID,
        chart,
        rows: [
          {
            evalId: "e1",
            name: "Refunds",
            href: `/project/${PROJECT_ID}/evals/e1`,
            cases: "12",
            scorers: 2,
            baselineScore: 0.5,
            slot: 0,
          },
        ],
      },
      dialog: DIALOG,
      canEdit: true,
      openNew: false,
    }),
  );
  const text = visibleText(html);
  for (const header of ["Name", "Cases", "Scorers", "Baseline score"])
    assert.ok(text.includes(header), header);
  assert.match(text, /New eval/);
  assert.match(html, /Filter evals/);
  assert.match(text, /Refunds\s+75%/, "the legend names the line with its newest score");
  for (const gone of ["Run suite", "Start run", "Cases of", "Experiments"]) {
    assert.ok(!text.includes(gone), `${gone} is not on the Evals page`);
  }
  // A support session sees no action.
  const readOnly = visibleText(
    render(
      createElement(EvalsList, {
        model: { projectId: PROJECT_ID, chart, rows: [] },
        dialog: DIALOG,
        canEdit: false,
        openNew: false,
      }),
    ),
  );
  assert.doesNotMatch(readOnly, /New eval/);
});

test("the Evals page draws the judge settings of an edition at its foot, and nothing with no edition", async () => {
  const editionUi = composition.ui;
  try {
    composition.ui = undefined;
    assert.equal(await judgeSettings(PROJECT_ID), null);
    composition.ui = async () => ({
      RootProvider: Nothing,
      AccountMenuItems: Nothing,
      EvalJudgeSettings: JudgeSettings,
    });
    const slot = await judgeSettings(PROJECT_ID);
    const html = render(
      createElement(
        EvalsList,
        {
          model: { projectId: PROJECT_ID, chart: scoreChart([]), rows: [] },
          dialog: DIALOG,
          canEdit: true,
          openNew: false,
        },
        slot,
      ),
    );
    assert.match(visibleText(html), new RegExp(`Who judges the project ${PROJECT_ID}`));
    // The section is under the table of evals.
    assert.ok(html.indexOf("Who judges") > html.indexOf("No eval yet"));
  } finally {
    composition.ui = editionUi;
  }
});

test("a chart with no run says so, and one run says that a line starts with the second", () => {
  const none = visibleText(
    render(
      createElement(ScoreChart, {
        chart: scoreChart([{ key: "e", label: "E", points: [] }]),
        label: "Score",
        emptyTitle: "No run yet",
        emptyDescription: "Start a run.",
      }),
    ),
  );
  assert.match(none, /No run yet\s+Start a run\./);
  const one = visibleText(
    render(
      createElement(ScoreChart, {
        chart: scoreChart([{ key: "e", label: "E", points: [{ runId: "r", at: NOW, value: 1 }] }]),
        label: "Score",
        emptyTitle: "No run yet",
        emptyDescription: "Start a run.",
      }),
    ),
  );
  assert.match(one, /100%\s+50%\s+0%/, "the axis runs from 0 to 100%");
  assert.match(one, /One run so far/);
});

test("New eval marks Production agent as coming soon, and it cannot be chosen", () => {
  const html = render(
    createElement(EvalDialog, {
      projectId: PROJECT_ID,
      dialog: DIALOG,
      open: true,
      onOpenChange: () => {},
    }),
  );
  // The dialog renders in a portal: the markup is empty on the server. The rule is in the form.
  assert.equal(typeof html, "string");
  const source = readFileSync(
    fileURLToPath(new URL("../../../../components/console/evals/EvalDialog.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /label: "Production agent",[\s\S]*?disabled: true,[\s\S]*?Coming soon/);
});

test("the Datasets page and a dataset: kinds, rows, trace links and the frozen-rows note", () => {
  const list = visibleText(
    render(
      createElement(DatasetsList, {
        model: {
          projectId: PROJECT_ID,
          rows: [
            {
              datasetId: "d1",
              name: "Refund asks",
              kind: "fixed",
              kindLabel: "Fixed rows",
              size: "2 rows",
              rql: false,
              updatedAt: NOW,
              usedBy: [{ evalId: "e1", name: "Refunds", href: "/x" }],
            },
          ],
        },
        tasks: [],
        canEdit: true,
        now: NOW,
      }),
    ),
  );
  for (const header of ["Name", "Kind", "Cases or query", "Updated", "Used by", "New dataset"]) {
    assert.ok(list.includes(header), header);
  }
  const base = {
    projectId: PROJECT_ID,
    datasetId: "d1",
    name: "Refund asks",
    description: null,
    usedBy: [],
    updatedAt: NOW,
    contentWithheld: false,
  };
  const fixed = render(
    createElement(DatasetView, {
      model: {
        ...base,
        kind: "fixed",
        kindLabel: "Fixed rows",
        query: null,
        rows: [
          {
            rowId: "r1",
            name: "Turn a1111111",
            kind: "trace",
            input: '{"message":"refund A200"}',
            expectedOutput: null,
            traceHref: `/project/${PROJECT_ID}/traces/turns/t1`,
            version: 1,
            updatedAt: NOW,
          },
        ],
      },
      tasks: [],
      canEdit: true,
      now: NOW,
    }),
  );
  assert.match(fixed, new RegExp(`/project/${PROJECT_ID}/traces/turns/t1`));
  assert.match(visibleText(fixed), /Add rows/);
  assert.match(fixed, /Remove Turn a1111111/);
  const query = visibleText(
    render(
      createElement(DatasetView, {
        model: {
          ...base,
          kind: "rql",
          kindLabel: "RQL query",
          query: {
            words: "Up to 20 traces of an RQL query",
            rql: "SELECT trace_id FROM traces",
            limit: 20,
            taskId: null,
          },
          rows: [],
        },
        tasks: [],
        canEdit: true,
        now: NOW,
      }),
    ),
  );
  assert.match(query, /A run freezes the rows/);
  assert.match(query, /SELECT trace_id FROM traces/);
  assert.match(query, /Preview/);
  assert.doesNotMatch(query, /Add rows/);
});

test("a matrix run shows its variants side by side, with their params in the header", () => {
  const made = run("r1", { e1: { cases: { a: ["pass"] } } });
  made.experiment.evalId = "e1";
  made.experiment.variants = [
    { index: 0, params: { model: "sonnet" } },
    { index: 1, params: { model: "haiku" } },
  ];
  const [first] = made.trials;
  assert.ok(first);
  made.trials.push({ ...first, id: "second", variant: 1, result: "fail" });
  const html = render(
    createElement(RunView, {
      evalName: "Refunds",
      model: runPageModel({
        projectId: PROJECT_ID,
        evalId: "e1",
        experiment: made.experiment,
        trials: made.trials,
        versions: [],
        outputs: new Map(),
      }),
    }),
  );
  const text = visibleText(html);
  assert.match(text, /model=sonnet[\s\S]*model=haiku/);
  assert.equal(
    (html.match(/>Output and trials</g) ?? []).length,
    2,
    "one output column for each variant",
  );
  assert.match(html, /\/evals\/e1\/runs\/r1\/trials\/second/);
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
