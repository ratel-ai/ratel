import assert from "node:assert/strict";
import { test } from "node:test";
import { evalDetail, pairedTrial, suiteTable } from "../suite-view";
import { POLITE, run } from "./runs";
import { NO_REFUND } from "./support";

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
