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
import { resolveConfig } from "@/config";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { compare } from "../domain/compare";
import type { Experiment, Trial } from "../domain/experiment";
import { pairedTrials } from "../domain/paired-trials";
import type { TrialResult } from "../domain/score";
import { evalsEnabledForProject, evalsOffForAll, evalsOrganizationIds } from "../gate";
import {
  type CaseEditorModel,
  type CaseVersionView,
  type ComparedCaseRow,
  comparePageModel,
  experimentPageModel,
  readyVersions,
} from "../page-model";
import { content } from "./support";

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

test("the list shows which version counts", () => {
  const row = { id: "c1", name: "Late refund", labels: ["task: refunds"], createdAt: NOW };
  const html = render(
    createElement(EvalsView, {
      baselineId: null,
      projectId: PROJECT_ID,
      canEdit: true,
      now: NOW,
      cases: [{ ...row, approved: 1, draft: 2 }],
      experiments: [],
      versions: [],
    }),
  );
  const text = visibleText(html);
  for (const part of ["Late refund", "Approved v1", "Draft v2", "task: refunds", "New case"]) {
    assert.ok(text.includes(part), part);
  }
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

test("the experiment page shows the raw counts of each case, and links each trial to its trace", () => {
  const trial = (over: Partial<Trial>): Trial => ({
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
  const experiment: Experiment = {
    id: "e1",
    projectId: PROJECT_ID,
    organizationId: "o1",
    sandboxVersionId: "sv1",
    sandboxName: "support-demo",
    gitCommit: "b".repeat(40),
    gitDirty: false,
    params: { model: "x" },
    trialsPerCase: 3,
    caseVersions: [{ caseId: "c1", versionId: "v1", number: 2, name: "Late refund" }],
    scorerSnapshots: {},
    startedBy: "u",
    state: "completed",
    createdAt: new Date(NOW),
    finishedAt: new Date(NOW),
  };
  const model = experimentPageModel(experiment, [
    trial({}),
    trial({
      index: 1,
      result: "fail",
      scorers: [
        {
          scorerId: "s",
          name: "No refund",
          kind: "check",
          gating: true,
          status: "fail",
          reason: "tools ne refund_order: the value is there.",
        },
        {
          scorerId: "j",
          name: "Polite",
          kind: "judge",
          gating: true,
          status: "not_scored",
          reason: "The judge budget of this organization for today (100 USD) is used.",
        },
      ],
    }),
    trial({ index: 2, result: "invalid", reason: "timed_out: no result", traceId: null }),
  ]);
  const html = render(
    createElement(ExperimentView, { model, baseline: "none", canEdit: true, now: NOW }),
  );
  const text = visibleText(html);
  assert.equal(text.match(/1 pass/g)?.length, 2, "the total and the case");
  for (const part of ["1 fail", "1 invalid", "Late refund", "timed_out: no result", "sv1"]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(text, /No refund\s*gating\s*tools ne refund_order/);
  // A judge that could not run shows its reason next to the fail of the trial.
  assert.match(
    text,
    /Trial 2\s*Fail[\s\S]*Not scored\s*Polite\s*gating\s*The judge budget [\s\S]*100 USD/,
  );
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
    sandboxVersionId: "sv1",
    sandboxName: "support-demo",
    gitCommit: id.repeat(40),
    gitDirty: false,
    params: {},
    trialsPerCase: 1,
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
  assert.equal(asOther.ok && asOther.pinnedBy, "a project key");
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
      trials: [{ ...trial, traceId: "d".repeat(32), scorers: [scorer] }],
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

test("a refused comparison shows the reason and the scorers that differ", () => {
  const scorers = [
    { caseId: "c1", caseName: "Late refund", name: "No refund", difference: "changed" as const },
  ];
  const pin = { experimentId: "base-1", pinnedBy: "u", pinnedAt: new Date(NOW) };
  const model = comparePageModel(
    { projectId: PROJECT_ID, experimentId: "b" },
    {
      ok: false,
      refusal: { reason: "scorers_differ", message: "The scorers differ.", scorers, pin },
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
