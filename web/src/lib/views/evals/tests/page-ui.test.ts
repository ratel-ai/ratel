import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { CaseEditor } from "@/components/console/evals/CaseEditor";
import { PairedTrials } from "@/components/console/evals/CompareCase";
import { CompareView } from "@/components/console/evals/CompareView";
import { EvalsView } from "@/components/console/evals/EvalsView";
import { ExperimentView } from "@/components/console/evals/ExperimentView";
import { SaveAsEvalCase } from "@/components/console/evals/SaveAsEvalCase";
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
  type ComparedCaseRow,
  caseLabels,
  caseRow,
  comparePageModel,
  DIFF_CHARS,
  experimentPageModel,
  PREVIEW_CHARS,
  readyVersions,
  runnableCases,
} from "../page-model";
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

test("the cases table shows the input, the expected output, the labels and which version counts", () => {
  const row = {
    id: "c1",
    name: "Late refund",
    labels: ["task: refunds"],
    createdAt: NOW,
    input: '{"message":"refund A200"}',
    turns: 2,
    expectedOutput: "It is refunded.",
  };
  const html = render(
    createElement(EvalsView, {
      baselineId: null,
      projectId: PROJECT_ID,
      canEdit: true,
      now: NOW,
      cases: [
        { ...row, approved: 1, draft: 2 },
        { ...row, id: "c2", name: "Status", labels: ["status"], approved: null, draft: 1 },
      ],
      experiments: [],
      versions: [
        {
          id: "v1",
          name: "support-demo",
          commit: "b".repeat(40),
          params: [
            {
              name: "tone",
              type: "enum",
              default: "formal",
              description: null,
              options: ["formal", "friendly"],
            },
            { name: "depth", type: "number", default: 2, description: "How deep", options: [] },
          ],
        },
      ],
    }),
  );
  const text = visibleText(html);
  for (const part of [
    "Late refund",
    "refund A200",
    "+2 turns",
    "It is refunded.",
    "Approved v1",
    "Draft v2",
    "task: refunds",
    "New case",
    "Experiment name",
    "1 approved case, 3 trials.",
  ]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(html.includes("<table"), "a table");
  assert.ok(html.includes('type="number"'), "a typed control for depth");
  assert.doesNotMatch(text, /Params \(JSON\)/);
});

test("a case row cuts its input and expected output, and counts the cases a label takes", () => {
  const long = "x".repeat(400);
  const evalCase = {
    id: "c1",
    projectId: PROJECT_ID,
    name: "Long",
    labels: ["a"],
    createdAt: new Date(NOW),
    createdBy: "u",
    versions: [{ ...version(), input: { message: long }, expectedOutput: long }],
  } as unknown as Parameters<typeof caseRow>[0];
  const row = caseRow(evalCase);
  assert.equal(row.input.length, PREVIEW_CHARS);
  assert.ok(row.input.endsWith("…"));
  assert.equal(row.expectedOutput?.length, PREVIEW_CHARS);
  const rows = [
    { labels: ["a"], approved: 1 },
    { labels: ["a", "b"], approved: null },
    { labels: ["b"], approved: 2 },
  ];
  assert.equal(runnableCases(rows, null), 2);
  assert.equal(runnableCases(rows, "a"), 1);
  assert.equal(runnableCases(rows, "c"), 0);
  assert.deepEqual(caseLabels(rows), ["a", "b"]);
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

test("Run evals lists ready versions only, and is not there in a support session", () => {
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
  const view = (canEdit: boolean) =>
    visibleText(
      render(
        createElement(EvalsView, {
          baselineId: null,
          projectId: PROJECT_ID,
          canEdit,
          now: NOW,
          cases: [],
          experiments: [],
          versions,
        }),
      ),
    );
  assert.ok(view(true).includes("No case is approved yet."));
  assert.ok(!view(false).includes("Run evals"));
});

const compared = (id: string, cases: Record<string, TrialResult>) => {
  const experiment: Experiment = {
    id,
    projectId: PROJECT_ID,
    organizationId: "o1",
    name: null,
    labelFilter: null,
    sandboxVersionId: "sv1",
    sandboxName: "support-demo",
    gitCommit: id.repeat(40),
    gitDirty: false,
    params: {},
    trialsPerCase: 1,
    evalVersions: [],
    caseVersions: Object.keys(cases).map((name) => ({
      caseId: name,
      versionId: name,
      number: 1,
      name,
    })),
    scorerSnapshots: {},
    startedBy: "u",
    state: "completed",
    createdAt: new Date(NOW),
    finishedAt: new Date(NOW),
  };
  const trials = Object.entries(cases).map(
    ([name, result]): Trial => ({
      id: `${id}-${name}`,
      experimentId: id,
      caseVersionId: name,
      index: 0,
      state: "done",
      result,
      reason: null,
      scorers: [],
      costUsd: 0.0123,
      durationMs: 1_500,
      traceId: null,
      sandboxRunId: null,
    }),
  );
  return { experiment, trials };
};

test("the comparison page: the verdict and its rule, the changed cases, then the others", () => {
  const baseline = compared("a", { better: "fail", same: "pass", worse: "pass" });
  const candidate = compared("b", { better: "pass", same: "pass", worse: "fail" });
  const comparison = compare(baseline, candidate);
  assert.ok(comparison.ok);
  const pin = { experimentId: "a", pinnedBy: "user_1", pinnedAt: new Date(NOW) };
  const ids = { projectId: PROJECT_ID, experimentId: "b" };
  const result = { ok: true as const, pin, baseline, candidate, comparison };
  const model = comparePageModel(ids, result, "user_1");
  const text = visibleText(render(createElement(CompareView, { model, now: NOW })));
  const order = ["Regressed", comparison.rule, "Changed cases", "worse", "better", "Other cases"];
  const at = order.map((part) => text.indexOf(part));
  assert.ok(!at.includes(-1), text);
  assert.deepEqual(
    at,
    [...at].sort((left, right) => left - right),
  );
  for (const part of ["1 regressed", "pinned by you", "1 pass", "1.5 s mean", "$0.0123 total"]) {
    assert.ok(text.includes(part), part);
  }
  const asOther = comparePageModel(
    ids,
    { ...result, pin: { ...pin, pinnedBy: "key:1" } },
    "user_2",
  );
  assert.equal(asOther.ok && asOther.pin?.by, "a project key");
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

test("an open case shows each pair with its scorer reasons, its trace and the side that is missing", () => {
  const { trials } = compared("a", { one: "pass" });
  const [trial] = trials;
  assert.ok(trial);
  const scorer = {
    scorerId: "s",
    name: "No refund",
    kind: "check" as const,
    gating: true,
    status: "pass" as const,
    reason: "tools ne refund_order: the value is [].",
  };
  const row: ComparedCaseRow = {
    caseId: "one",
    name: "one",
    change: "removed",
    baseline: {
      versionId: "one",
      number: 1,
      status: "pass",
      counts: { pass: 1, fail: 0, invalid: 0, open: 0 },
      costUsd: null,
      meanDurationMs: null,
      trials: [{ ...trial, traceId: "d".repeat(32), scorers: [scorer], output: null }],
    },
    candidate: null,
  };
  const html = render(createElement(PairedTrials, { projectId: PROJECT_ID, row }));
  const text = visibleText(html);
  for (const part of [
    "Baseline, trial 1",
    "Candidate, trial 1",
    "Not in this experiment",
    scorer.reason,
    "Loading",
  ]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(html, new RegExp(`traces/${"d".repeat(32)}`));
});

test("a chosen experiment: the setup differences, then both outputs with a word diff", () => {
  const baseline = compared("a", { worse: "pass", same: "pass" });
  const candidate = compared("b", { worse: "fail", same: "pass" });
  baseline.experiment.params = { tone: "friendly", maxWords: 40 };
  candidate.experiment.params = { tone: "formal", maxWords: 40, offerRefund: false };
  candidate.experiment.sandboxVersionId = "sv2";
  candidate.experiment.name = "Formal, no refunds";
  const comparison = compare(baseline, candidate);
  assert.ok(comparison.ok);
  const outputs = new Map([
    ["a-worse", "Your order A107 is late. I refunded it for you."],
    ["b-worse", "Dear customer, your order A107 is late."],
  ]);
  const choices = [{ id: "a", label: "support-demo · aaaa · 2026-11-25 10:00", pinned: false }];
  const model = comparePageModel(
    { projectId: PROJECT_ID, experimentId: "b" },
    { ok: true, pin: null, baseline, candidate, comparison },
    "user_1",
    { outputs, choices, chosenId: "a" },
  );
  assert.ok(model.ok);
  assert.deepEqual(model.params, [
    { name: "offerRefund", baseline: null, candidate: "false" },
    { name: "tone", baseline: '"friendly"', candidate: '"formal"' },
  ]);
  assert.equal(model.versionChanged, true);
  const html = render(createElement(CompareView, { model, now: NOW }));
  const text = visibleText(html);
  const order = ["Regressed", comparison.rule, "What changed in the setup", "Changed cases"];
  const at = order.map((part) => text.indexOf(part));
  assert.ok(!at.includes(-1), text);
  assert.deepEqual(
    at,
    [...at].sort((left, right) => left - right),
  );
  for (const part of ["not the pinned baseline", "offerRefund", "default", "Version", "sv2"]) {
    assert.ok(text.includes(part), part);
  }
  // Removed words are marked on the baseline side, added words on the candidate side.
  assert.match(html, /<mark[^>]*line-through[^>]*>[^<]*refunded/);
  assert.match(html, /<mark[^>]*>Dear /);
  assert.ok(text.includes("Your order A107 is late."));
  const long = comparePageModel(
    { projectId: PROJECT_ID, experimentId: "b" },
    { ok: true, pin: null, baseline, candidate, comparison },
    "user_1",
    { outputs: new Map([["b-worse", "x".repeat(DIFF_CHARS + 1)]]) },
  );
  assert.ok(long.ok);
  const cutOutput = long.changed[0]?.candidate?.trials[0]?.output ?? "";
  assert.equal(cutOutput.length, DIFF_CHARS + 1);
  assert.ok(cutOutput.endsWith("…"));
  assert.ok(html.includes('aria-label="Compare with"'));
});

test("a refused comparison shows the reason and the scorers that differ", () => {
  const scorers = [
    { caseId: "c1", caseName: "Late refund", name: "No refund", difference: "changed" as const },
  ];
  const pin = { experimentId: "base-1", pinnedBy: "u", pinnedAt: new Date(NOW) };
  const model = comparePageModel(
    { projectId: PROJECT_ID, experimentId: "b" },
    {
      ok: false,
      refusal: {
        reason: "scorers_differ",
        message: "The scorers differ.",
        scorers,
        pin,
        otherId: "base-1",
      },
    },
    "u",
  );
  const html = render(createElement(CompareView, { model, now: NOW }));
  const text = visibleText(html);
  assert.match(html, /evals\/experiments\/base-1"/);
  for (const part of ["the scorers differ", "No refund", "Late refund", "The definition changed"]) {
    assert.ok(text.includes(part), part);
  }
});

test("a completed experiment can be pinned, and compared when another one is the baseline", () => {
  const { experiment, trials } = compared("b", { one: "pass" });
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
  assert.doesNotMatch(text("none"), /Compare with baseline/);
  assert.match(text("other"), /Pin as baseline\s*Compare with baseline/);
  assert.match(text("this"), /Unpin baseline/);
  assert.doesNotMatch(text("other", false), /Pin as baseline/);
});
