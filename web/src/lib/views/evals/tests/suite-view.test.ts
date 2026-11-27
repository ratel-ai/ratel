import assert from "node:assert/strict";
import { test } from "node:test";
import type { Compared } from "../baseline";
import type { EvalScorer } from "../domain/eval";
import type { Experiment, Trial } from "../domain/experiment";
import { snapshotOf, type TrialResult } from "../domain/score";
import { evalDetail, pairedTrial, suiteTable } from "../suite-view";
import { NO_REFUND, ORGANIZATION_ID, PROJECT_ID } from "./support";

const POLITE: EvalScorer = {
  id: "polite",
  name: "Polite",
  gating: false,
  definition: { kind: "judge", config: { prompt: "polite?", output: "boolean" } },
};
const T0 = new Date("2026-11-26T10:00:00Z");

type Spec = Record<string, { scorers?: EvalScorer[]; cases: Record<string, TrialResult[]> }>;

/** A completed run. Each trial passes or fails every scorer with its result. */
function run(id: string, spec: Spec): Compared {
  const experiment: Experiment = {
    id,
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    sandboxVersionId: "sv",
    sandboxName: "support-demo",
    name: null,
    labelFilter: null,
    gitCommit: "",
    gitDirty: false,
    params: {},
    trialsPerCase: 3,
    caseVersions: [],
    evalVersions: [],
    scorerSnapshots: {},
    startedBy: "u",
    state: "completed",
    createdAt: T0,
    finishedAt: T0,
  };
  const trials: Trial[] = [];
  for (const [evalId, { scorers = [NO_REFUND], cases }] of Object.entries(spec)) {
    experiment.evalVersions.push({
      evalId,
      versionId: `${evalId}-v1`,
      number: 1,
      name: evalId,
      params: {},
      trials: 3,
    });
    for (const [caseId, results] of Object.entries(cases)) {
      const versionId = `${id}-${caseId}`;
      experiment.caseVersions.push({ caseId, versionId, number: 1, name: caseId, evalId });
      experiment.scorerSnapshots[versionId] = scorers.map(snapshotOf);
      results.forEach((result, index) => {
        const status = result === "invalid" ? "not_scored" : result;
        trials.push({
          id: `${versionId}-t${index}`,
          experimentId: id,
          caseVersionId: versionId,
          index,
          state: "done",
          result,
          reason: null,
          scorers: scorers.map(({ id: scorerId, name, gating, definition }) => ({
            scorerId,
            name,
            kind: definition.kind,
            gating,
            status,
            reason: "",
          })),
          costUsd: null,
          durationMs: null,
          traceId: `${id}-trace-${index}`,
          sandboxRunId: null,
        });
      });
    }
  }
  return { experiment, trials };
}

const BASE = run("base", {
  refunds: { cases: { a: ["pass", "fail"], b: ["pass", "pass"] } },
  status: { scorers: [NO_REFUND, POLITE], cases: { s: ["pass"] } },
});
const NEXT = run("next", {
  refunds: { cases: { a: ["pass", "pass"], b: ["pass", "invalid"] } },
  status: { scorers: [{ ...NO_REFUND, gating: false }, POLITE], cases: { s: ["fail"] } },
});

test("the suite table has a row for each eval: score, counts, scorers, delta, and the verdict", () => {
  const table = suiteTable(NEXT, BASE);
  assert.equal(table.baselineId, "base");
  assert.deepEqual(table.scorerColumns, ["No refund", "Polite"]);
  const [refunds, status] = table.rows;
  assert.deepEqual(
    [refunds?.name, refunds?.cases, refunds?.score, refunds?.counts],
    ["refunds", 2, 1, { pass: 3, fail: 0, invalid: 1, open: 0 }],
  );
  assert.ok(refunds?.delta?.ok);
  assert.equal(refunds.delta.score, 1 - 0.75);
  assert.ok(status?.delta && !status.delta.ok);
  assert.equal(status.delta.reason, "scorers_differ");
  assert.equal(status.score, 0);
  // The verdict counts the cases of all evals whose scorers did not change.
  assert.ok(table.verdict?.ok);
  assert.equal(table.verdict.verdict, "improved");
  assert.match(table.verdict.excludedMessage ?? "", /No refund/);
});

test("with no baseline, or against itself, the table has no delta and no verdict", () => {
  for (const table of [suiteTable(NEXT, null), suiteTable(NEXT, NEXT)]) {
    assert.equal(table.baselineId, null);
    assert.equal(table.verdict, null);
    assert.ok(table.rows.every(({ delta }) => delta === null));
  }
});

test("an eval opens its cases with a breakdown for each scorer, next to the baseline", () => {
  const detail = evalDetail(NEXT, BASE, "refunds");
  assert.ok(detail);
  assert.equal(detail.row.name, "refunds");
  assert.deepEqual(
    detail.cases.map(({ caseId, status, scorers, baseline }) => [
      caseId,
      status,
      scorers.map(({ name, pass, fail, passRate }) => [name, pass, fail, passRate]),
      baseline?.status,
    ]),
    [
      ["a", "pass", [["No refund", 2, 0, 1]], "fail"],
      ["b", "pass", [["No refund", 1, 0, 1]], "pass"],
    ],
  );
  assert.equal(evalDetail(NEXT, BASE, "nope"), null);
  assert.equal(evalDetail(NEXT, null, "refunds")?.cases[0]?.baseline, null);
});

test("a trial opens next to the baseline trial of the same row and index", () => {
  const paired = pairedTrial(NEXT, BASE, "next-a-t1");
  assert.ok(paired);
  assert.deepEqual(
    [paired.caseId, paired.evalId, paired.trial.id, paired.baselineTrial?.id, paired.baselineId],
    ["a", "refunds", "next-a-t1", "base-a-t1", "base"],
  );
  assert.equal(paired.baselineTrial?.traceId, "base-trace-1");
  const alone = pairedTrial(NEXT, run("old", { refunds: { cases: { z: ["pass"] } } }), "next-a-t0");
  assert.deepEqual([alone?.baselineTrial, alone?.baselineId], [null, null]);
  assert.equal(pairedTrial(NEXT, BASE, "missing"), null);
});
