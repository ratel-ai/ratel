import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { CaseEditor } from "@/components/console/evals/CaseEditor";
import { ExperimentView } from "@/components/console/evals/ExperimentView";
import { SaveAsEvalCase } from "@/components/console/evals/SaveAsEvalCase";
import { SuiteView } from "@/components/console/evals/SuiteView";
import { TrialPanel } from "@/components/console/evals/TrialPanel";
import { resolveConfig } from "@/config";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import type { CaseVersion } from "../domain/case";
import { compare } from "../domain/compare";
import type { Experiment, Trial } from "../domain/experiment";
import { pairedTrials } from "../domain/paired-trials";
import type { TrialResult } from "../domain/score";
import { evalsEnabledForProject, evalsOffForAll, evalsOrganizationIds } from "../gate";
import {
  type CaseEditorModel,
  type CaseVersionView,
  experimentPageModel,
  PREVIEW_CHARS,
  readyVersions,
} from "../page-model";
import { suitePageModel } from "../suite-page";
import { POLITE, run } from "./runs";
import { content, NO_REFUND } from "./support";

const NOW = "2026-11-25T10:00:00.000Z";
const version = (over: Partial<CaseVersionView> = {}): CaseVersionView => ({
  ...content(),
  id: "v1",
  caseId: "c1",
  number: 1,
  state: "approved",
  sourceTurnId: "t1",
  sourceOutput: "Refunded.",
  approvedBy: "user_1",
  approvedAt: NOW,
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
  approved: null,
  draft: version({ state: "draft" }),
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

test("the rail has Evals only with the flag on", () => {
  assert.ok(labels(true).includes("Evals"));
  assert.ok(!labels(false).includes("Evals"));
});

test("the editor of an approved case with a draft shows both", () => {
  const html = render(
    createElement(CaseEditor, {
      model: model({
        approved: version(),
        draft: version({ id: "v2", number: 2, state: "draft" }),
      }),
    }),
  );
  const text = visibleText(html);
  assert.match(text, /Version 1 counts in eval runs/);
  assert.match(text, /Draft v2/);
  assert.match(text, /No refund \(gating\): tools is not refund_order/);
  assert.match(html, /traces\/turns\/t1/);
});

test("a support session sees no action", () => {
  const text = visibleText(render(createElement(CaseEditor, { model: model({ canEdit: false }) })));
  assert.ok(!text.includes("Approve"));
  assert.ok(!text.includes("Save draft"));
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

test("the suite table: a row for each eval, scorer columns, the delta, the invalid count and the verdict line", () => {
  const version = (id: string, status: "ready" | "failed") => ({
    id,
    projectId: PROJECT_ID,
    sandboxId: "s",
    name: "support-demo",
    git: { commit: "b".repeat(40), dirty: false },
    status,
    createdAt: new Date(),
    tools: [],
    params: [],
  });
  const versions = readyVersions([version("1", "failed"), version("2", "ready")]);
  assert.deepEqual(
    versions.map(({ id }) => id),
    ["2"],
  );
  const BASE = run("base", { refunds: { cases: { a: ["fail", "pass"] } } });
  const NEXT = run("next", {
    refunds: { cases: { a: ["pass", "invalid"] } },
    status: { scorers: [NO_REFUND, POLITE], cases: { s: ["pass"] } },
  });
  const model = suitePageModel({
    projectId: PROJECT_ID,
    evals: [suiteEval("refunds"), suiteEval("status")],
    cases: [],
    runs: [],
    run: NEXT,
    baseline: BASE,
  });
  const view = (canEdit: boolean) =>
    visibleText(
      render(
        createElement(SuiteView, {
          model,
          canEdit,
          versions,
          experiments: [],
          baseline: "other",
          now: NOW,
        }),
      ),
    );
  const text = view(true);
  for (const header of ["Eval", "Score", "No refund", "Polite", "Δ baseline", "Invalid"]) {
    assert.ok(text.includes(header), header);
  }
  assert.match(text, /Improved/);
  assert.match(text, /\+50 pts/);
  assert.match(text, /New eval/);
  assert.match(text, /Run suite/);
  assert.doesNotMatch(view(false), /Run suite|New eval/);
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

test("a completed run can be pinned, and opens its deltas when another one is the baseline", () => {
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
  assert.doesNotMatch(text("none"), /Deltas against the baseline/);
  assert.match(text("other"), /Pin as baseline\s*Deltas against the baseline/);
  assert.match(text("this"), /Unpin baseline/);
  assert.doesNotMatch(text("other", false), /Pin as baseline/);
});

function suiteEval(id: string) {
  return {
    id,
    projectId: PROJECT_ID,
    name: id,
    taskId: null,
    createdAt: new Date(0),
    versions: [
      {
        sandboxName: null,
        params: {},
        trials: 3,
        scorers: [NO_REFUND],
        id: `${id}-v1`,
        evalId: id,
        number: 1,
        createdBy: "u",
        createdAt: new Date(0),
      },
    ],
  };
}
