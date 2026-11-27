import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalCase } from "../domain/case";
import type { EvalDefinition } from "../domain/eval";
import { emptyCounts } from "../domain/experiment";
import { evalPageModel, suitePageModel, trialPageModel } from "../suite-page";
import { pairedTrial } from "../suite-view";
import { POLITE, run } from "./runs";
import { content, evalContent, NO_REFUND, PROJECT_ID } from "./support";

const BASE = run("base", {
  refunds: { cases: { a: ["pass", "fail"], b: ["pass", "pass"] } },
  status: { scorers: [NO_REFUND, POLITE], cases: { s: ["pass"] } },
});
const NEXT = run("next", {
  refunds: { cases: { a: ["pass", "pass"], b: ["pass", "invalid"] } },
  status: { scorers: [{ ...NO_REFUND, gating: false }, POLITE], cases: { s: ["fail"] } },
});

function definition(id: string, taskId: string | null = null): EvalDefinition {
  return {
    id,
    projectId: PROJECT_ID,
    name: id,
    taskId,
    createdAt: new Date(0),
    versions: [
      {
        ...evalContent(),
        id: `${id}-v1`,
        evalId: id,
        number: 1,
        createdBy: "u",
        createdAt: new Date(0),
      },
    ],
  };
}

function evalCase(id: string, evalId: string, state: "draft" | "approved" = "approved"): EvalCase {
  return {
    id,
    projectId: PROJECT_ID,
    evalId,
    name: id,
    labels: [],
    createdAt: new Date(0),
    versions: [
      {
        ...content({ expectedOutput: "No refund." }),
        id: `${id}-v1`,
        caseId: id,
        number: 1,
        state,
        sourceTurnId: null,
        sourceOutput: null,
        approvedBy: null,
        approvedAt: null,
        updatedAt: new Date(0),
      },
    ],
  };
}

const EVALS = [definition("refunds", "wf-refunds"), definition("status"), definition("new")];
const CASES = [
  evalCase("a", "refunds"),
  evalCase("b", "refunds"),
  evalCase("s", "status"),
  evalCase("d", "new", "draft"),
];
const RUNS = [
  {
    id: "next",
    sandboxName: "support-demo",
    commit: "abcdef123",
    state: "completed" as const,
    cases: 3,
    counts: emptyCounts(),
    createdAt: "2026-11-26T10:00:00.000Z",
  },
];

test("the suite table has every eval: the score, a cell for each scorer, the delta and the invalid count", () => {
  const model = suitePageModel({
    projectId: PROJECT_ID,
    evals: EVALS,
    cases: CASES,
    runs: RUNS,
    run: NEXT,
    baseline: BASE,
  });
  assert.equal(model.runId, "next");
  assert.deepEqual(model.runs, [
    { id: "next", label: "2026-11-26 10:00 · support-demo · abcdef1" },
  ]);
  assert.deepEqual(model.scorerColumns, ["No refund", "Polite"]);
  const [refunds, status, unrun] = model.rows;
  assert.deepEqual(
    [
      refunds?.name,
      refunds?.taskId,
      refunds?.approvedCases,
      refunds?.run?.score,
      refunds?.run?.counts.invalid,
    ],
    ["refunds", "wf-refunds", 2, 1, 1],
  );
  assert.deepEqual(refunds?.run?.scorers["No refund"], {
    passRate: 1,
    pass: 3,
    rated: 3,
    delta: 0.25,
  });
  assert.equal(refunds?.run?.delta, 0.25);
  assert.equal(refunds?.href, `/project/${PROJECT_ID}/evals/refunds`);
  assert.equal(status?.run?.delta, null);
  assert.match(status?.run?.deltaReason ?? "", /scorers of this eval differ/);
  assert.deepEqual([unrun?.name, unrun?.run, unrun?.draftCases], ["new", null, 1]);
  assert.ok(model.verdict?.ok);
  assert.equal(model.verdict.verdict, "improved");
});

test("with no run the table lists the evals with no score, and no verdict", () => {
  const model = suitePageModel({
    projectId: PROJECT_ID,
    evals: EVALS,
    cases: CASES,
    runs: [],
    run: null,
    baseline: null,
  });
  assert.equal(model.runId, null);
  assert.equal(model.verdict, null);
  assert.ok(model.rows.every(({ run: cell }) => cell === null));
});

test("a run from before evals had definitions shows as one row", () => {
  const old = run("old", { refunds: { cases: { a: ["pass"] } } });
  old.experiment.evalVersions = [];
  for (const frozen of old.experiment.caseVersions) delete frozen.evalId;
  const model = suitePageModel({
    projectId: PROJECT_ID,
    evals: EVALS,
    cases: CASES,
    runs: [],
    run: old,
    baseline: null,
  });
  const legacy = model.rows.at(-1);
  assert.equal(legacy?.evalId, null);
  assert.match(legacy?.name ?? "", /before evals had definitions/);
  assert.equal(legacy?.run?.score, 1);
});

test("an eval page has its definition and its dataset with the output and a breakdown for each scorer", () => {
  const model = evalPageModel({
    projectId: PROJECT_ID,
    definition: EVALS[0] as EvalDefinition,
    cases: CASES,
    run: NEXT,
    baseline: BASE,
    outputs: new Map([["next-a-t1", "No refund for A200."]]),
  });
  assert.deepEqual(
    [model.version.number, model.version.trials, model.version.scorers.map(({ id }) => id)],
    [1, 3, ["no-refund"]],
  );
  assert.equal(model.run?.score, 1);
  assert.deepEqual(
    model.dataset.map(({ caseId, status, change, output, expectedOutput, scorers }) => [
      caseId,
      status,
      change,
      output,
      expectedOutput,
      scorers["No refund"]?.passRate,
    ]),
    [
      ["a", "pass", "improved", "No refund for A200.", "No refund.", 1],
      ["b", "pass", "unchanged", null, "No refund.", 1],
    ],
  );
  assert.deepEqual(
    model.dataset[0]?.trials.map(({ id, href }) => [id, href]),
    [
      ["next-a-t0", `/project/${PROJECT_ID}/evals/experiments/next/trials/next-a-t0`],
      ["next-a-t1", `/project/${PROJECT_ID}/evals/experiments/next/trials/next-a-t1`],
    ],
  );
});

test("an eval page takes the change of each row from the run verdict", () => {
  const page = (candidate: typeof NEXT) =>
    evalPageModel({
      projectId: PROJECT_ID,
      definition: EVALS[1] as EvalDefinition,
      cases: CASES,
      run: candidate,
      baseline: BASE,
    });
  // The scorers of "status" changed: its row is not compared, so it did not regress.
  assert.deepEqual(
    page(NEXT).dataset.map(({ caseId, change }) => [caseId, change]),
    [["s", "excluded"]],
  );
  // A run that has not ended is not compared.
  const running = { ...NEXT, experiment: { ...NEXT.experiment, state: "running" as const } };
  assert.deepEqual(
    page(running).dataset.map(({ change }) => change),
    [null],
  );
});

test("a trial page has both trials of the same row and index", () => {
  const paired = pairedTrial(NEXT, BASE, "next-a-t1");
  assert.ok(paired);
  const model = trialPageModel(PROJECT_ID, paired, "next");
  assert.deepEqual(
    [
      model.candidate.runId,
      model.candidate.trial.id,
      model.baseline?.runId,
      model.baseline?.trial.id,
    ],
    ["next", "next-a-t1", "base", "base-a-t1"],
  );
  const alone = pairedTrial(NEXT, null, "next-a-t1");
  assert.ok(alone);
  assert.equal(trialPageModel(PROJECT_ID, alone, "next").baseline, null);
});
