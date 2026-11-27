import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalScorer, FrozenEval } from "../domain/eval";
import type { FrozenCase } from "../domain/experiment";
import { type ScorerResult, snapshotOf, type TrialResult } from "../domain/score";
import { evalDeltas, evalScores, type ScoredRun } from "../domain/suite";
import { NO_REFUND } from "./support";

const POLITE: EvalScorer = {
  id: "polite",
  name: "Polite",
  gating: false,
  definition: { kind: "judge", config: { prompt: "polite?", output: "boolean" } },
};

type Row = {
  /** One trial each: its result and the status of each scorer, by scorer id. */
  trials: Array<{ result: TrialResult | null; scorers?: Record<string, ScorerResult["status"]> }>;
};
type EvalSide = { scorers?: EvalScorer[]; rows: Record<string, Row>; number?: number };

/** A run of these evals. The key of an eval is its id and its name. */
function run(id: string, evals: Record<string, EvalSide>, legacy = false): ScoredRun {
  const caseVersions: FrozenCase[] = [];
  const evalVersions: FrozenEval[] = [];
  const scorerSnapshots: ScoredRun["experiment"]["scorerSnapshots"] = {};
  const trials: Array<ScoredRun["trials"][number]> = [];
  for (const [evalId, { scorers = [NO_REFUND], rows, number = 1 }] of Object.entries(evals)) {
    evalVersions.push({
      evalId,
      versionId: `${evalId}-v${number}`,
      number,
      name: evalId,
      params: {},
      trials: 3,
    });
    for (const [caseId, row] of Object.entries(rows)) {
      const versionId = `${id}-${caseId}`;
      caseVersions.push({
        caseId,
        versionId,
        number: 1,
        name: caseId,
        ...(legacy ? {} : { evalId }),
      });
      scorerSnapshots[versionId] = scorers.map(snapshotOf);
      for (const trial of row.trials) {
        trials.push({
          caseVersionId: versionId,
          result: trial.result,
          scorers: Object.entries(trial.scorers ?? {}).flatMap(([scorerId, status]) => {
            const scorer = scorers.find((one) => one.id === scorerId);
            if (!scorer) return [];
            const { name, gating, definition } = scorer;
            return [{ scorerId, name, kind: definition.kind, gating, status, reason: "" }];
          }),
        });
      }
    }
  }
  return {
    experiment: {
      id,
      state: "completed",
      caseVersions,
      evalVersions: legacy ? [] : evalVersions,
      scorerSnapshots,
    },
    trials,
  };
}

const passed = { result: "pass" as const, scorers: { "no-refund": "pass" as const } };
const failed = { result: "fail" as const, scorers: { "no-refund": "fail" as const } };
const invalid = { result: "invalid" as const };

test("the score of an eval is the mean of its scorer pass rates over the valid trials", () => {
  const [refunds] = evalScores(
    run("r1", {
      refunds: {
        scorers: [NO_REFUND, POLITE],
        rows: {
          a: {
            trials: [
              { result: "pass", scorers: { "no-refund": "pass", polite: "pass" } },
              { result: "pass", scorers: { "no-refund": "pass", polite: "fail" } },
              { result: "fail", scorers: { "no-refund": "fail", polite: "not_scored" } },
            ],
          },
          b: { trials: [passed, invalid, { result: null }] },
        },
      },
    }),
  );
  assert.ok(refunds);
  assert.deepEqual(
    refunds.scorers.map(({ scorerId, pass, fail, notScored, passRate }) => [
      scorerId,
      pass,
      fail,
      notScored,
      passRate,
    ]),
    [
      // 3 of 4 valid trials. The invalid and the open trial are not in the rate.
      ["no-refund", 3, 1, 0, 0.75],
      // A scorer that could not run, or gave no result, is counted and not in the rate.
      ["polite", 1, 1, 2, 0.5],
    ],
  );
  assert.equal(refunds.score, (0.75 + 0.5) / 2);
  assert.deepEqual(refunds.counts, { pass: 3, fail: 1, invalid: 1, open: 1 });
  assert.equal(refunds.cases, 2);
  assert.deepEqual([refunds.evalId, refunds.name, refunds.number], ["refunds", "refunds", 1]);
});

test("an eval with no valid trial has no score, and its counts stay", () => {
  const [only] = evalScores(
    run("r1", { refunds: { rows: { a: { trials: [invalid, invalid] } } } }),
  );
  assert.equal(only?.score, null);
  assert.equal(only?.scorers[0]?.passRate, null);
  assert.deepEqual(only?.counts, { pass: 0, fail: 0, invalid: 2, open: 0 });
});

test("the evals keep the order of the run, and a run from before evals had definitions is one group", () => {
  const evals = {
    b: { rows: { x: { trials: [passed] } } },
    a: { rows: { y: { trials: [failed] } } },
  };
  assert.deepEqual(
    evalScores(run("r1", evals)).map(({ evalId, score }) => [evalId, score]),
    [
      ["b", 1],
      ["a", 0],
    ],
  );
  const legacy = evalScores(run("r0", evals, true));
  assert.deepEqual(
    legacy.map(({ evalId, name, number, cases, score }) => [evalId, name, number, cases, score]),
    [[null, "All cases", null, 2, 0.5]],
  );
});

test("the delta of an eval is its score minus its score in the baseline, for each scorer too", () => {
  const baseline = run("base", {
    refunds: {
      scorers: [NO_REFUND, POLITE],
      rows: {
        a: {
          trials: [{ result: "fail", scorers: { "no-refund": "fail", polite: "pass" } }, passed],
        },
      },
    },
  });
  const candidate = run("next", {
    refunds: {
      // Another id and name for the same scorer do not count.
      scorers: [NO_REFUND, { ...POLITE, id: "kind", name: "Kind" }],
      rows: {
        a: { trials: [{ result: "pass", scorers: { "no-refund": "pass", kind: "fail" } }, passed] },
        b: { trials: [passed] },
      },
    },
  });
  const deltas = evalDeltas(baseline, candidate);
  const refunds = deltas.get("refunds");
  assert.ok(refunds?.ok);
  // no-refund: 0.5 to 1. polite: 1 to 0.
  assert.deepEqual(refunds.scorers, [
    { scorerId: "no-refund", delta: 0.5 },
    { scorerId: "kind", delta: -1 },
  ]);
  assert.equal(refunds.score, (1 + 0) / 2 - (0.5 + 1) / 2);
});

test("an eval whose scorers differ from the baseline has no delta, and says why", () => {
  const strict = { ...NO_REFUND, gating: false };
  const deltas = evalDeltas(
    run("base", {
      refunds: { rows: { a: { trials: [passed] } } },
      status: { rows: { s: { trials: [passed] } } },
    }),
    run("next", {
      refunds: { scorers: [strict], rows: { a: { trials: [passed] } } },
      status: { rows: { s: { trials: [failed] } } },
      added: { rows: { n: { trials: [passed] } } },
    }),
  );
  const refunds = deltas.get("refunds");
  assert.ok(refunds && !refunds.ok);
  assert.equal(refunds.reason, "scorers_differ");
  assert.match(refunds.message, /"No refund" \(gating on one side and advisory on the other\)/);
  const status = deltas.get("status");
  assert.ok(status?.ok);
  assert.equal(status.score, -1);
  const added = deltas.get("added");
  assert.ok(added && !added.ok);
  assert.equal(added.reason, "not_in_baseline");
});

test("a judge that answered with another model is another scorer", () => {
  const judge = { ...POLITE, gating: true };
  const judged = (model: string) =>
    ({
      result: "pass",
      scorers: { polite: "pass" },
      model,
    }) as const;
  const side = (id: string, model: string): ScoredRun => {
    const made = run(id, {
      refunds: { scorers: [judge], rows: { a: { trials: [judged(model)] } } },
    });
    return {
      ...made,
      trials: made.trials.map((trial) => ({
        ...trial,
        scorers: trial.scorers.map((scorer) => ({ ...scorer, model })),
      })),
    };
  };
  const delta = evalDeltas(side("base", "m1"), side("next", "m2")).get("refunds");
  assert.ok(delta && !delta.ok);
  assert.equal(delta.reason, "scorers_differ");
  assert.match(delta.message, /judge model/);
  assert.ok(evalDeltas(side("base", "m1"), side("next", "m1")).get("refunds")?.ok);
});

test("a baseline from before evals had definitions gives no delta, and says why", () => {
  const evals = { refunds: { rows: { a: { trials: [passed] } } } };
  const delta = evalDeltas(run("base", evals, true), run("next", evals)).get("refunds");
  assert.ok(delta && !delta.ok);
  assert.equal(delta.reason, "not_in_baseline");
  assert.match(delta.message, /before evals had definitions/);
});
