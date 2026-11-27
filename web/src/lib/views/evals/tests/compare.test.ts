import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ComparedRun,
  changedCases,
  compare,
  otherCases,
  VERDICT_RULE,
} from "../domain/compare";
import type { EvalScorer } from "../domain/eval";
import { type ScorerResult, snapshotOf, type TrialResult } from "../domain/score";
import { NO_REFUND } from "./support";

type Side = {
  results: Array<TrialResult | null>;
  number?: number;
  scorers?: EvalScorer[];
  name?: string;
  /** The judge model of each trial. */
  models?: string[];
};

/** A completed experiment with these cases. The key is the case id. */
function run(id: string, cases: Record<string, Side>): ComparedRun {
  const sides = Object.entries(cases);
  const versionOf = (caseId: string) => `${caseId}-v${cases[caseId]?.number ?? 1}`;
  return {
    experiment: {
      id,
      state: "completed",
      caseVersions: sides.map(([caseId, { number = 1, name = caseId }]) => ({
        caseId,
        versionId: versionOf(caseId),
        number,
        name,
      })),
      scorerSnapshots: Object.fromEntries(
        sides.map(([caseId, { scorers = [NO_REFUND] }]) => [
          versionOf(caseId),
          scorers.map(snapshotOf),
        ]),
      ),
    },
    trials: sides.flatMap(([caseId, { results, scorers = [], models = [] }]) =>
      results.map((result, index) => ({
        caseVersionId: versionOf(caseId),
        result,
        scorers: scorers.flatMap(({ id, name, gating, definition }): ScorerResult[] => {
          const model = definition.kind === "judge" ? models[index] : undefined;
          if (!model) return [];
          return [{ scorerId: id, name, kind: "judge", gating, status: "pass", reason: "", model }];
        }),
      })),
    ),
  };
}

const PASS: Side = { results: ["pass", "pass", "pass"] };
const FAIL: Side = { results: ["pass", "fail", "pass"] };
const INVALID: Side = { results: ["invalid", "invalid", "invalid"] };

function compared(baseline: Record<string, Side>, candidate: Record<string, Side>) {
  const comparison = compare(run("base", baseline), run("next", candidate));
  assert.ok(comparison.ok, JSON.stringify(comparison));
  return comparison;
}
const changes = (comparison: ReturnType<typeof compared>) =>
  comparison.cases.map(({ caseId, change }) => [caseId, change]);

test("regressed: a case goes from pass to fail", () => {
  const comparison = compared({ a: PASS, b: PASS }, { a: FAIL, b: PASS });
  assert.equal(comparison.verdict, "regressed");
  assert.equal(comparison.rule, VERDICT_RULE.regressed);
  assert.deepEqual(changes(comparison), [
    ["a", "regressed"],
    ["b", "unchanged"],
  ]);
});

test("a regression wins over an improvement and over an invalid case", () => {
  const comparison = compared({ a: FAIL, b: PASS, c: PASS }, { a: PASS, b: FAIL, c: INVALID });
  assert.equal(comparison.verdict, "regressed");
  assert.deepEqual(changes(comparison), [
    ["b", "regressed"],
    ["c", "inconclusive"],
    ["a", "improved"],
  ]);
});

test("improved: a case goes from fail to pass and none regressed", () => {
  const comparison = compared({ a: FAIL, b: PASS }, { a: PASS, b: PASS });
  assert.equal(comparison.verdict, "improved");
  assert.equal(comparison.rule, VERDICT_RULE.improved);
});

test("unchanged: each case has the same status, also with other counts", () => {
  const comparison = compared(
    { a: PASS, b: FAIL },
    { a: { results: ["pass", "invalid", "pass"] }, b: { results: ["fail", "fail", "fail"] } },
  );
  assert.equal(comparison.verdict, "unchanged");
  assert.equal(comparison.rule, VERDICT_RULE.unchanged);
  assert.deepEqual(comparison.cases[1]?.candidate?.counts, {
    pass: 0,
    fail: 3,
    invalid: 0,
    open: 0,
  });
});

test("inconclusive: a compared case is invalid on one side or on both, also with an improvement", () => {
  for (const [before, after] of [
    [INVALID, PASS],
    [PASS, INVALID],
    [INVALID, INVALID],
    [INVALID, FAIL],
  ] as const) {
    const comparison = compared({ a: before, b: FAIL }, { a: after, b: PASS });
    assert.equal(comparison.verdict, "inconclusive");
    assert.equal(comparison.rule, VERDICT_RULE.inconclusive);
  }
});

test("inconclusive: no case is in both experiments", () => {
  const comparison = compared({ a: PASS }, { b: FAIL });
  assert.equal(comparison.verdict, "inconclusive");
  assert.equal(comparison.rule, VERDICT_RULE.nothing);
});

test("a case of one side is added or removed and does not decide the verdict", () => {
  const comparison = compared({ a: PASS, gone: PASS }, { a: PASS, fresh: FAIL, odd: INVALID });
  assert.equal(comparison.verdict, "unchanged");
  assert.deepEqual(changes(comparison), [
    ["fresh", "added"],
    ["odd", "added"],
    ["gone", "removed"],
    ["a", "unchanged"],
  ]);
  const [fresh, , gone] = comparison.cases;
  assert.deepEqual([fresh?.baseline, fresh?.candidate?.status], [null, "fail"]);
  assert.deepEqual([gone?.baseline?.status, gone?.candidate], ["pass", null]);
  assert.deepEqual(changedCases(comparison).length, 3);
  assert.deepEqual(otherCases(comparison).length, 1);
});

test("the version of each side is reported", () => {
  const [only] = compared({ a: PASS }, { a: { ...PASS, number: 2, name: "renamed" } }).cases;
  assert.deepEqual(
    [only?.name, only?.baseline?.number, only?.candidate?.number, only?.change],
    ["renamed", 1, 2, "unchanged"],
  );
});

test("other scorers are refused, and the scorers that differ are named", () => {
  const changed: EvalScorer = {
    ...NO_REFUND,
    definition: { kind: "check", config: { path: "tools", op: "eq", value: "refund_order" } },
  };
  const advisory = { ...NO_REFUND, id: "adv", name: "Advisory", gating: false };
  const extra = { ...changed, id: "extra", name: "Extra" };
  const refusal = compare(
    run("base", {
      a: PASS,
      b: { ...PASS, scorers: [NO_REFUND, advisory] },
      gone: PASS,
      same: PASS,
    }),
    run("next", {
      a: { ...PASS, scorers: [changed] },
      b: { ...PASS, scorers: [NO_REFUND, { ...advisory, gating: true }, extra] },
      same: { ...PASS, scorers: [{ ...NO_REFUND, id: "new-id", name: "new name" }] },
    }),
  );
  assert.ok(!refusal.ok);
  assert.equal(refusal.reason, "scorers_differ");
  assert.deepEqual(refusal.scorers, [
    { caseId: "a", caseName: "a", name: "No refund", difference: "changed" },
    { caseId: "b", caseName: "b", name: "Advisory", difference: "gating" },
    { caseId: "b", caseName: "b", name: "Extra", difference: "added" },
  ]);
  for (const name of ["No refund", "Advisory", "Extra"]) {
    assert.ok(refusal.message.includes(name), refusal.message);
  }
});

test("a message with many scorers names the first ones and counts the others", () => {
  const ids = Array.from({ length: 30 }, (_, index) => `case-${10 + index}`);
  const side = (scorers: EvalScorer[]) =>
    Object.fromEntries(ids.map((id) => [id, { ...PASS, scorers }]));
  const refusal = compare(
    run("base", side([NO_REFUND])),
    run("next", side([{ ...NO_REFUND, gating: false }])),
  );
  assert.ok(!refusal.ok);
  assert.equal(refusal.scorers.length, 30);
  assert.match(refusal.message, /case-10.*case-12/);
  assert.doesNotMatch(refusal.message, /case-13/);
  assert.match(refusal.message, /27 more/);
});

test("a removed scorer, and one of two equal scorers, is a difference", () => {
  const twin = { ...NO_REFUND, id: "twin", name: "Twin" };
  const refusal = compare(
    run("base", { a: { ...PASS, scorers: [NO_REFUND, twin] } }),
    run("next", { a: PASS }),
  );
  assert.ok(!refusal.ok);
  assert.deepEqual(refusal.scorers, [
    { caseId: "a", caseName: "a", name: "Twin", difference: "removed" },
  ]);
});

test("an experiment that has not ended is refused", () => {
  const open = run("next", { a: PASS });
  open.experiment.state = "running";
  const refusal = compare(run("base", { a: PASS }), open);
  assert.deepEqual([refusal.ok, !refusal.ok && refusal.reason], [false, "not_completed"]);
});

test("an experiment is not compared with itself", () => {
  const same = run("base", { a: PASS });
  const refusal = compare(same, same);
  assert.deepEqual([refusal.ok, !refusal.ok && refusal.reason], [false, "same_experiment"]);
});

test("the same two experiments always give the same result, in any order of the rows", () => {
  const baseline = { a: PASS, b: FAIL, c: PASS, d: INVALID };
  const candidate = { a: FAIL, b: PASS, c: PASS, d: PASS, e: PASS };
  const first = compare(run("base", baseline), run("next", candidate));
  const mixed = (side: Record<string, Side>, id: string) => {
    const made = run(id, side);
    made.experiment.caseVersions.reverse();
    return { ...made, trials: [...made.trials].reverse() };
  };
  assert.deepEqual(compare(mixed(baseline, "base"), mixed(candidate, "next")), first);
});

const JUDGE: EvalScorer = {
  id: "judge",
  name: "Polite",
  gating: true,
  definition: { kind: "judge", config: { prompt: "Is it polite?", output: "boolean" } },
};
const judgedBy = (...models: string[]): Side => ({ ...PASS, scorers: [JUDGE], models });

test("a judge with another model is another scorer", () => {
  for (const [before, after] of [
    [judgedBy("a", "a", "a"), judgedBy("b", "b", "b")],
    [judgedBy("a", "a", "a"), judgedBy("a", "b", "a")],
    [judgedBy("a", "b", "a"), judgedBy("a", "b", "a")],
  ] as const) {
    const refusal = compare(
      run("base", { x: before, y: PASS }),
      run("next", { x: after, y: PASS }),
    );
    assert.ok(!refusal.ok);
    assert.equal(refusal.reason, "scorers_differ");
    assert.deepEqual(refusal.scorers, [
      { caseId: "x", caseName: "x", name: "Polite", difference: "changed" },
    ]);
    assert.match(refusal.message, /judge model/);
  }
});

test("the same judge model, and a judge with no answer, are compared", () => {
  compared({ x: judgedBy("a", "a", "a") }, { x: judgedBy("a", "a") });
  compared({ x: judgedBy("a", "a", "a") }, { x: judgedBy() });
});

test("two judges of a case can have two models, also with new ids", () => {
  const other: EvalScorer = {
    ...JUDGE,
    id: "other",
    name: "Short",
    definition: { kind: "judge", config: { prompt: "Is it short?", output: "boolean" } },
  };
  const side = (id: string) => {
    const made = run(id, { x: { ...PASS, scorers: [{ ...JUDGE, id: `j-${id}` }, other] } });
    const results: ScorerResult[] = [
      [`j-${id}`, "a"],
      ["other", "b"],
    ].map(([scorerId = "", model]) => ({
      scorerId,
      name: scorerId,
      kind: "judge",
      gating: true,
      status: "pass",
      reason: "",
      model,
    }));
    return { ...made, trials: made.trials.map((trial) => ({ ...trial, scorers: results })) };
  };
  assert.ok(compare(side("base"), side("next")).ok);
});
