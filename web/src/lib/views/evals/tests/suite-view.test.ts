import assert from "node:assert/strict";
import { test } from "node:test";
import { pairedTrial, suiteTable } from "../suite-view";
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

test("a trial of the baseline run itself has no baseline trial", () => {
  const paired = pairedTrial(BASE, BASE, "base-a-t1");
  assert.deepEqual([paired?.baselineTrial, paired?.baselineId], [null, null]);
});

test("a trial of a matrix run pairs with the baseline variant of the same params", () => {
  const candidate = run("next", { refunds: { cases: { a: ["pass"] } } });
  const base = run("base", { refunds: { cases: { a: ["fail"] } } });
  candidate.experiment.variants = [
    { index: 0, params: { model: "sonnet" } },
    { index: 1, params: { model: "haiku" } },
  ];
  base.experiment.variants = [
    { index: 0, params: { model: "haiku" } },
    { index: 1, params: { model: "sonnet" } },
  ];
  const [own] = candidate.trials;
  const [old] = base.trials;
  assert.ok(own && old);
  candidate.trials.push({ ...own, id: "next-haiku", variant: 1 });
  base.trials.push({ ...old, id: "base-sonnet", variant: 1 });
  assert.equal(pairedTrial(candidate, base, "next-haiku")?.baselineTrial?.id, old.id);
  assert.equal(pairedTrial(candidate, base, own.id)?.baselineTrial?.id, "base-sonnet");
});
