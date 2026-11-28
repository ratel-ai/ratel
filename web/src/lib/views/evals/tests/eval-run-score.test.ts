import assert from "node:assert/strict";
import { test } from "node:test";
import { combinations, evalContentSchema, MAX_COMBINATIONS } from "../domain/eval";
import type { Experiment, Trial } from "../domain/experiment";
import { snapshotOf } from "../domain/score";
import { evalDeltas, evalScores, RUN_SCORE_RULE, runDelta, runScore } from "../domain/suite";
import { NO_REFUND } from "./support";

const POLITE = { ...NO_REFUND, id: "polite", name: "Polite", gating: false };

/** A completed run of the eval `e1` with one case, and these results of NO_REFUND for each variant. */
function run(
  id: string,
  results: Array<Array<"pass" | "fail" | "invalid">>,
  scorers = [NO_REFUND],
): { experiment: Experiment; trials: Trial[] } {
  const versionId = `${id}-c1`;
  const variants =
    results.length > 1 ? results.map((_, index) => ({ index, params: { n: index } })) : [];
  const experiment = {
    id,
    evalId: "e1",
    state: "completed",
    variants,
    caseVersions: [{ caseId: "c1", versionId, number: 1, name: "c1", evalId: "e1" }],
    evalVersions: [
      { evalId: "e1", versionId: "v1", number: 1, name: "Refunds", params: {}, trials: 2 },
    ],
    scorerSnapshots: { [versionId]: scorers.map(snapshotOf) },
  } as unknown as Experiment;
  const trials = results.flatMap((variant, index) =>
    variant.map(
      (result, trial) =>
        ({
          id: `${id}-${index}-${trial}`,
          caseVersionId: versionId,
          variant: variants.length === 0 ? 0 : index,
          result,
          scorers: scorers.map((scorer) => ({
            scorerId: scorer.id,
            name: scorer.name,
            kind: "check",
            gating: scorer.gating,
            status: result,
            reason: "",
          })),
        }) as unknown as Trial,
    ),
  );
  return { experiment, trials };
}

test("the score of a run pools the valid trials of its variants, and each variant keeps its own score", () => {
  const score = runScore(
    run("r1", [
      ["pass", "pass"],
      ["pass", "fail"],
    ]),
  );
  assert.deepEqual(
    score.variants.map(({ variant, score: one }) => [variant?.index, one.score]),
    [
      [0, 1],
      [1, 0.5],
    ],
  );
  assert.equal(score.score, 0.75);
  assert.equal(score.rule, RUN_SCORE_RULE);
  assert.equal(runScore(run("r2", [["pass", "fail"]])).variants[0]?.variant, null);
});

test("a matrix run has one score: the scorer pass rates over all its valid trials", () => {
  // Variant 0: 1 pass, 3 invalid. Variant 1: 4 fails. 1 pass of 5 valid trials.
  const matrix = run("r1", [
    ["pass", "invalid", "invalid", "invalid"],
    ["fail", "fail", "fail", "fail"],
  ]);
  const score = runScore(matrix);
  assert.equal(score.score, 0.2);
  assert.equal(evalScores(matrix)[0]?.score, 0.2);
  // Each variant keeps the score of its own trials.
  assert.deepEqual(
    score.variants.map(({ score: one }) => one.score),
    [1, 0],
  );
  assert.match(score.rule, /all the valid trials/);
});

test("a run has one delta: its score minus the baseline score, also when a scorer is not rated on one side", () => {
  // Baseline: A pass, B not scored (score 1). Candidate: A pass, B fail (score 0.5).
  const baseline = run("base", [["pass"]], [NO_REFUND, POLITE]);
  const [trial] = baseline.trials;
  if (trial) trial.scorers = trial.scorers.filter(({ scorerId }) => scorerId !== POLITE.id);
  const candidate = run("next", [["pass"]], [NO_REFUND, POLITE]);
  const polite = candidate.trials[0]?.scorers.find(({ scorerId }) => scorerId === POLITE.id);
  if (polite) polite.status = "fail";

  const ofRun = runDelta(baseline, candidate);
  const ofEval = evalDeltas(baseline, candidate).get("e1");
  assert.ok(ofRun.ok && ofEval?.ok);
  assert.equal(ofRun.score, -0.5);
  assert.equal(ofEval.score, -0.5);
  // Each scorer keeps its own delta: none for a scorer that one side did not rate.
  assert.deepEqual(ofEval.scorers, [
    { scorerId: NO_REFUND.id, delta: 0 },
    { scorerId: POLITE.id, delta: null },
  ]);
});

test("the delta of a run is its score minus the baseline score", () => {
  const delta = runDelta(run("base", [["pass", "fail"]]), run("next", [["pass", "pass"]]));
  assert.ok(delta.ok);
  assert.equal(delta.score, 0.5);
});

test("the delta has no value, with its reason, when the scorer snapshots differ", () => {
  const delta = runDelta(
    run("base", [["pass", "fail"]]),
    run("next", [["pass"]], [NO_REFUND, POLITE]),
  );
  assert.equal(delta.ok, false);
  assert.equal(delta.ok ? null : delta.reason, "scorers_differ");
  assert.match(delta.ok ? "" : delta.message, /"Polite"/);
});

test("a matrix has each combination, and at most 12 of them", () => {
  assert.deepEqual(combinations({ model: ["a", "b"], depth: [1, 2, 3] }).length, 6);
  assert.deepEqual(combinations({}), []);
  const twelve = evalContentSchema.safeParse({ matrix: { a: [1, 2, 3], b: [1, 2, 3, 4] } });
  assert.equal(twelve.success, true);
  const more = evalContentSchema.safeParse({ matrix: { a: [1, 2, 3], b: [1, 2, 3, 4, 5] } });
  assert.equal(more.success, false);
  assert.match(more.error?.issues[0]?.message ?? "", new RegExp(`at most ${MAX_COMBINATIONS}`));
});
