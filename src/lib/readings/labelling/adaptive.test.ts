import assert from "node:assert/strict";
import { test } from "node:test";
import { auditVerdict, labelsNeeded, spreadPick, stratifiedShare } from "./adaptive";

test("the share weights each stratum by its population, not by how hard it was sampled", () => {
  // 900 agreeing searches, 100 disputed; the disputed ones were sampled ten times harder.
  const estimate = stratifiedShare([
    { population: 900, labelled: 50, hits: 45 },
    { population: 100, labelled: 50, hits: 10 },
  ]);
  assert.ok(estimate.share !== null && estimate.margin !== null);
  assert.ok(Math.abs(estimate.share - (0.9 * 0.9 + 0.1 * 0.2)) < 1e-9, "0.83, not the raw 0.55");
  assert.ok(estimate.margin > 0 && estimate.margin < 0.1);
  assert.equal(estimate.labelled, 100);
  assert.equal(estimate.population, 1000);
});

test("nothing labelled is no estimate, and a stratum labelled in full has no sampling error", () => {
  assert.deepEqual(stratifiedShare([{ population: 40, labelled: 0, hits: 0 }]), {
    share: null,
    margin: null,
    labelled: 0,
    population: 40,
  });
  const full = stratifiedShare([{ population: 40, labelled: 40, hits: 30 }]);
  assert.equal(full.share, 0.75);
  assert.equal(full.margin, 0);
});

test("labels needed: about 385 for plus or minus five points on a big unknown population, fewer on a small one", () => {
  const [big] = labelsNeeded([{ population: 1_000_000, labelled: 0, hits: 0 }], 0.05);
  assert.ok(big !== undefined && big >= 370 && big <= 390, `got ${big}`);
  const [small] = labelsNeeded([{ population: 200, labelled: 0, hits: 0 }], 0.05);
  assert.ok(
    small !== undefined && small < 200 && small > 100,
    `the finite population needs fewer, got ${small}`,
  );
  const [ten] = labelsNeeded([{ population: 1_000_000, labelled: 0, hits: 0 }], 0.1);
  assert.ok(
    ten !== undefined && ten >= 90 && ten <= 100,
    `plus or minus ten needs about 96, got ${ten}`,
  );
});

test("labels needed shrink as answers arrive and reach zero once the margin is met", () => {
  const strata = [{ population: 5_000, labelled: 0, hits: 0 }];
  const [first] = labelsNeeded(strata, 0.05);
  assert.ok(first !== undefined && first > 300);
  // A clear-cut stratum (95% hits) needs far fewer than the uncertain prior assumed.
  const [after] = labelsNeeded([{ population: 5_000, labelled: 100, hits: 95 }], 0.05);
  assert.ok(after !== undefined && after < first - 100, `got ${after}`);
  const [done] = labelsNeeded([{ population: 5_000, labelled: 400, hits: 380 }], 0.05);
  assert.equal(done, 0);
  assert.ok(
    (stratifiedShare([{ population: 5_000, labelled: 400, hits: 380 }]).margin ?? 1) <= 0.05,
  );
});

test("labels needed go where the population and the uncertainty are, and every stratum gets some", () => {
  const [busy, quiet, empty] = labelsNeeded(
    [
      { population: 9_000, labelled: 0, hits: 0 },
      { population: 1_000, labelled: 0, hits: 0 },
      { population: 0, labelled: 0, hits: 0 },
    ],
    0.05,
  );
  assert.ok(busy !== undefined && quiet !== undefined);
  assert.ok(busy > quiet * 5, "Neyman: proportional to size when spreads match");
  assert.ok(quiet >= 10, "an unmeasured stratum asks for at least the floor");
  assert.equal(empty, 0);
  assert.deepEqual(labelsNeeded([], 0.05), []);
  assert.deepEqual(
    labelsNeeded([{ population: 10, labelled: 0, hits: 0 }], 0),
    [0],
    "no target, no labels",
  );
});

test("labels needed never exceed what is left to label", () => {
  const [left] = labelsNeeded([{ population: 30, labelled: 25, hits: 12 }], 0.01);
  assert.equal(left, 5);
});

test("the audit distrusts a carry only on evidence", () => {
  assert.equal(auditVerdict(9, 9), "unknown", "below the minimum sample");
  assert.equal(auditVerdict(19, 20), "trust");
  assert.equal(auditVerdict(15, 20), "distrust");
  assert.equal(auditVerdict(0, 0), "unknown");
  assert.equal(auditVerdict(8, 10, { threshold: 0.7 }), "trust");
});

test("a spread pick spans the list", () => {
  assert.deepEqual(spreadPick([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [1, 4, 7]);
  assert.deepEqual(spreadPick([1, 2], 5), [1, 2]);
  assert.deepEqual(spreadPick([1, 2], 0), []);
});
