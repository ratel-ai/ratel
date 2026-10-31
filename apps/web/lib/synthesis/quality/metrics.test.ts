import assert from "node:assert/strict";
import { test } from "node:test";
import { wilsonInterval } from "@/lib/readings/stats";
import {
  ABSENT,
  addTotals,
  creditFromHistogram,
  emptyTotals,
  explainQualityGap,
  hitCredit,
  mixComparable,
  rankCredit,
  reciprocalRank,
  scoreCoverage,
  scoreObservations,
  scoreTotals,
  scoreUnified,
  separated,
  summarizeListCost,
  totalsFromObservations,
} from "@/lib/synthesis/quality/metrics";

const close = (actual: number | null, expected: number, epsilon = 1e-9) => {
  assert.ok(actual !== null, "expected a value, got null");
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
};

test("rankCredit pays the documented amount at each rank", () => {
  close(rankCredit(1), 1);
  close(rankCredit(2), 0.6309297535714574);
  close(rankCredit(3), 0.5);
  close(rankCredit(5), 0.3868528072345416);
});

test("hitCredit is half for being shown and half for placement", () => {
  close(hitCredit(1), 1);
  close(hitCredit(2), 0.5 + 0.5 * 0.6309297535714574);
  close(hitCredit(3), 0.75);
  close(hitCredit(5), 0.5 + 0.5 * 0.3868528072345416);
  // Rank 2 is a success the agent saw, not a third of a failure.
  assert.ok(hitCredit(2) > 0.8);
  // Higher is still better, all the way down the list.
  for (let rank = 1; rank < 20; rank += 1) {
    assert.ok(hitCredit(rank) > hitCredit(rank + 1));
    assert.ok(hitCredit(rank + 1) > 0.5);
  }
});

test("hitCredit scores an absent target as zero", () => {
  for (const rank of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(hitCredit(rank), 0);
  }
});

test("creditFromHistogram matches the credit summed from raw observations", () => {
  const totals = totalsFromObservations([
    { rank: 1 },
    { rank: 2 },
    { rank: 2 },
    { rank: 7 },
    { rank: null },
  ]);
  close(creditFromHistogram(totals.rankHistogram), totals.creditSum);
  assert.equal(creditFromHistogram({ [ABSENT]: 3 }), 0);
});

test("rankCredit and reciprocalRank score an absent target as zero", () => {
  for (const rank of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(rankCredit(rank), 0);
    assert.equal(reciprocalRank(rank), 0);
  }
});

test("scoreObservations reports containment, placement and quality", () => {
  // Four evaluable searches: found at ranks 1 and 3, and two misses.
  const score = scoreObservations([{ rank: 1 }, { rank: 3 }, { rank: null }, { rank: null }]);

  assert.equal(score.n, 4);
  assert.equal(score.contained, 2);
  close(score.containment, 0.5);
  close(score.placement, (1 + 0.75) / 2);
  close(score.quality, (1 + 0.75) / 4);
  close(score.mrr, (1 + 1 / 3) / 4);
});

test("quality is exactly containment times placement", () => {
  const score = scoreObservations([
    { rank: 1 },
    { rank: 2 },
    { rank: 5 },
    { rank: null },
    { rank: null },
    { rank: null },
  ]);

  close(score.quality, score.containment! * score.placement!);
});

test("a perfect arm scores one and a blind arm scores zero", () => {
  const perfect = scoreObservations([{ rank: 1 }, { rank: 1 }, { rank: 1 }]);
  close(perfect.containment, 1);
  close(perfect.placement, 1);
  close(perfect.quality, 1);

  const blind = scoreObservations([{ rank: null }, { rank: null }]);
  close(blind.containment, 0);
  assert.equal(blind.placement, null);
  close(blind.quality, 0);
});

test("containment and quality separate an arm that finds but buries", () => {
  // Both arms contain the target every time; one puts it first, one puts it
  // fifth. Containment cannot tell them apart, which is why quality exists.
  const top = scoreObservations([{ rank: 1 }, { rank: 1 }]);
  const buried = scoreObservations([{ rank: 5 }, { rank: 5 }]);

  assert.equal(top.containment, buried.containment);
  assert.ok(top.quality! > buried.quality!);
});

test("scoreObservations bins ranks and misses into the histogram", () => {
  const score = scoreObservations([{ rank: 1 }, { rank: 1 }, { rank: 3 }, { rank: null }]);

  assert.deepEqual(score.rankHistogram, { "1": 2, "3": 1, [ABSENT]: 1 });
});

test("an empty population reports nulls rather than zeroes", () => {
  const score = scoreObservations([]);
  assert.equal(score.n, 0);
  assert.equal(score.containment, null);
  assert.equal(score.placement, null);
  assert.equal(score.quality, null);
  assert.equal(score.mrr, null);
  assert.equal(score.containmentInterval, null);
});

test("summed totals score identically to the union of their populations", () => {
  const monday = [{ rank: 1 }, { rank: null }, { rank: 4 }];
  const tuesday = [{ rank: 2 }, { rank: 2 }, { rank: null }, { rank: 1 }];

  const rolled = scoreTotals(
    addTotals(totalsFromObservations(monday), totalsFromObservations(tuesday)),
  );
  const direct = scoreObservations([...monday, ...tuesday]);

  assert.deepEqual(rolled, direct);
});

test("addTotals leaves an empty accumulator unchanged", () => {
  const totals = totalsFromObservations([{ rank: 1 }, { rank: null }]);
  assert.deepEqual(addTotals(emptyTotals(), totals), totals);
});

test("wilsonInterval brackets the observed rate and stays inside [0, 1]", () => {
  const interval = wilsonInterval(37, 66)!;
  assert.ok(interval.low < 37 / 66 && 37 / 66 < interval.high);
  assert.ok(interval.low >= 0 && interval.high <= 1);
});

test("wilsonInterval stays in range at the extremes", () => {
  const none = wilsonInterval(0, 12)!;
  assert.equal(none.low, 0);
  assert.ok(none.high > 0 && none.high < 1);

  const all = wilsonInterval(12, 12)!;
  close(all.high, 1);
  assert.ok(all.low > 0 && all.low < 1);
});

test("wilsonInterval narrows as the sample grows", () => {
  const small = wilsonInterval(28, 50)!;
  const large = wilsonInterval(280, 500)!;
  assert.ok(large.high - large.low < small.high - small.low);
});

test("separated only calls a difference real when the intervals clear", () => {
  // 56% against 79% on 66 searches each: a gap wide enough to read.
  assert.equal(separated(wilsonInterval(37, 66), wilsonInterval(52, 66)), true);
  // The same rates on a dozen searches each are not yet distinguishable.
  assert.equal(separated(wilsonInterval(7, 12), wilsonInterval(9, 12)), false);
  assert.equal(separated(null, wilsonInterval(9, 12)), false);
});

test("summarizeListCost reports length, fill rate and the confident prefix", () => {
  const cost = summarizeListCost([
    { returned: 5, requested: 5, scores: [10, 9.5, 4, 3, 2] },
    { returned: 3, requested: 3, scores: [10, 2, 1] },
    { returned: 1, requested: 5, scores: [10] },
  ]);

  assert.equal(cost.n, 3);
  close(cost.averageReturned, 3);
  close(cost.fillRate, 2 / 3);
  // Confident: 2 of 5, then 1 of 3, then 1 of 1, so 4 of 9 results.
  close(cost.confidentShare, 4 / 9);
  close(cost.averageConfidentReturned, 4 / 3);
});

test("summarizeListCost ignores samples that carry no usable scores", () => {
  const cost = summarizeListCost([
    { returned: 3, requested: 3, scores: null },
    { returned: 2, requested: 2, scores: [0, 0] },
  ]);

  assert.equal(cost.confidentShare, null);
  assert.equal(cost.averageConfidentReturned, null);
  close(cost.fillRate, 1);
  close(cost.averageReturned, 2.5);
});

test("summarizeListCost reports nulls for an empty population", () => {
  const cost = summarizeListCost([]);
  assert.equal(cost.n, 0);
  assert.equal(cost.averageReturned, null);
  assert.equal(cost.fillRate, null);
});

test("explainQualityGap decomposes the difference exactly", () => {
  const arm = scoreObservations([{ rank: 3 }, { rank: 3 }, { rank: 2 }, { rank: null }]);
  const baseline = scoreObservations([{ rank: 1 }, { rank: 1 }, { rank: 1 }, { rank: null }]);

  const gap = explainQualityGap(arm, baseline)!;
  close(gap.total, arm.quality! - baseline.quality!);
  // The two terms sum to the whole gap, with nothing left over.
  close(gap.containment + gap.placement, gap.total);
});

test("explainQualityGap blames placement when both arms find it equally often", () => {
  // Same containment, wildly different rank: this is a ranking problem.
  const buried = scoreObservations([{ rank: 5 }, { rank: 5 }, { rank: null }]);
  const top = scoreObservations([{ rank: 1 }, { rank: 1 }, { rank: null }]);

  const gap = explainQualityGap(buried, top)!;
  assert.equal(gap.driver, "placement");
  assert.equal(gap.containment, 0);
  assert.ok(gap.placement < 0);
});

test("explainQualityGap blames containment when both rank it first", () => {
  // Whenever either arm finds it, it leads with it. The gap is coverage.
  const misses = scoreObservations([{ rank: 1 }, { rank: null }, { rank: null }]);
  const finds = scoreObservations([{ rank: 1 }, { rank: 1 }, { rank: 1 }]);

  const gap = explainQualityGap(misses, finds)!;
  assert.equal(gap.driver, "containment");
  assert.equal(gap.placement, 0);
  assert.ok(gap.containment < 0);
});

test("explainQualityGap calls a mixed cause even rather than picking one", () => {
  const arm = scoreObservations([{ rank: 5 }, { rank: 5 }, { rank: null }, { rank: null }]);
  const baseline = scoreObservations([{ rank: 1 }, { rank: 1 }, { rank: 1 }, { rank: null }]);

  const gap = explainQualityGap(arm, baseline)!;
  // Containment −0.25 and placement −0.15 in credit terms: neither dominates.
  assert.equal(gap.driver, "even");
});

test("explainQualityGap treats an arm that never found it as zero placement", () => {
  const blind = scoreObservations([{ rank: null }, { rank: null }]);
  const finds = scoreObservations([{ rank: 1 }, { rank: 1 }]);

  const gap = explainQualityGap(blind, finds)!;
  assert.equal(gap.driver, "containment");
  close(gap.total, -1);
});

test("explainQualityGap refuses an empty population", () => {
  assert.equal(explainQualityGap(scoreObservations([]), scoreObservations([{ rank: 1 }])), null);
});

test("scoreCoverage rewards containing the reference list, not just its first", () => {
  // The exact case that motivates this metric: we miss their first result but
  // return their second and third. Scoring only their top result calls this a
  // total miss; it plainly is not.
  const score = scoreCoverage([{ reference: ["a", "b", "c"], ours: ["b", "c"] }]);

  close(score.plain, 2 / 3);
  // Weighted: we earned the credit of positions 2 and 3 out of 1, 2 and 3.
  const total = rankCredit(1) + rankCredit(2) + rankCredit(3);
  close(score.weighted, (rankCredit(2) + rankCredit(3)) / total);
  assert.equal(score.completeShare, 0);
  assert.equal(score.disjointShare, 0);
});

test("scoreCoverage weights their leading results more than their tail", () => {
  const led = scoreCoverage([{ reference: ["a", "b", "c"], ours: ["a"] }]);
  const trailed = scoreCoverage([{ reference: ["a", "b", "c"], ours: ["c"] }]);

  // Their order is evidence even though it is not truth, so missing their first
  // costs more than missing their third.
  assert.ok(led.weighted! > trailed.weighted!);
  // It is not fatal though: the tail still scores above zero.
  assert.ok(trailed.weighted! > 0);
  // Rank-blind, the two are identical, which is exactly what weighting adds.
  close(led.plain, trailed.plain!);
});

test("scoreCoverage reports a full and an empty reproduction", () => {
  const full = scoreCoverage([{ reference: ["a", "b"], ours: ["b", "a", "z"] }]);
  close(full.weighted, 1);
  close(full.plain, 1);
  assert.equal(full.completeShare, 1);

  const none = scoreCoverage([{ reference: ["a", "b"], ours: ["y", "z"] }]);
  close(none.weighted, 0);
  assert.equal(none.disjointShare, 1);
});

test("scoreCoverage averages over searches, not over results", () => {
  // A search with a long reference list must not outweigh a short one.
  const score = scoreCoverage([
    { reference: ["a"], ours: ["a"] },
    { reference: ["b", "c", "d", "e"], ours: [] },
  ]);

  close(score.plain, 0.5);
  close(score.averageReferenceSize!, 2.5);
});

test("scoreCoverage does not pay twice for a duplicated reference id", () => {
  const score = scoreCoverage([{ reference: ["a", "a", "b"], ours: ["a"] }]);
  close(score.plain, 0.5);
  assert.equal(score.averageReferenceSize, 2);
});

test("scoreCoverage skips searches where the reference returned nothing", () => {
  const score = scoreCoverage([
    { reference: [], ours: ["a"] },
    { reference: ["a"], ours: ["a"] },
  ]);

  // Nothing to reproduce is not a perfect score and not a failure; it is not
  // evidence at all, so it leaves the population.
  assert.equal(score.n, 1);
  close(score.plain, 1);
});

test("scoreCoverage reports nulls when nothing is evaluable", () => {
  const score = scoreCoverage([{ reference: [], ours: ["a"] }]);
  assert.equal(score.n, 0);
  assert.equal(score.weighted, null);
  assert.equal(score.averageReferenceSize, null);
});

test("scoreUnified reports the blend and the mix that produced it", () => {
  const score = scoreUnified([
    { evidence: "revealed", credit: 1, reach: 1, contained: true },
    { evidence: "revealed", credit: 0, reach: 0, contained: false },
    { evidence: "judged", credit: 1, reach: 1, contained: true },
    { evidence: "judged", credit: 0, reach: 0, contained: false },
  ]);

  assert.equal(score.n, 4);
  close(score.score, 0.5);
  close(score.revealedShare, 0.5);
  close(score.revealedScore, 0.5);
  close(score.judgedScore, 0.5);
  assert.equal(score.judgedN, 2);
  close(score.containment, 0.5);
  assert.equal(score.containmentN, 4);
});

test("scoreUnified counts revealed and answer-key searches toward containment", () => {
  // `observeUnified` never emits revealed evidence for the arm that served, and
  // an answer-key target was chosen independently of every arm, so both belong
  // in the containment denominator. Only an observation with no single answer
  // (`contained: null`) stays out of it.
  const score = scoreUnified([
    { evidence: "revealed", credit: 1, reach: 1, contained: true },
    { evidence: "revealed", credit: 0, reach: 0, contained: false },
    { evidence: "judged", credit: 1, reach: 1, contained: true },
    { evidence: "judged", credit: 0, reach: 0, contained: null },
  ]);

  assert.equal(score.containmentN, 3);
  close(score.containment, 2 / 3);
  close(score.score, 2 / 4);
  close(score.reach, 2 / 4);
});

test("mixComparable refuses to compare windows with different evidence mixes", () => {
  const mostlyRevealed = scoreUnified([
    { evidence: "revealed", credit: 1, reach: 1, contained: true },
    { evidence: "revealed", credit: 1, reach: 1, contained: true },
    { evidence: "revealed", credit: 1, reach: 1, contained: true },
    { evidence: "judged", credit: 0, reach: 0, contained: false },
  ]);
  const mostlyJudged = scoreUnified([
    { evidence: "revealed", credit: 1, reach: 1, contained: true },
    { evidence: "judged", credit: 0, reach: 0, contained: false },
    { evidence: "judged", credit: 0, reach: 0, contained: false },
    { evidence: "judged", credit: 0, reach: 0, contained: false },
  ]);

  // A telemetry rollout moved the mix from 75% to 25%; the blended scores are
  // not measuring the same thing and must not be read against each other.
  assert.equal(mixComparable(mostlyRevealed, mostlyJudged), false);
  assert.equal(mixComparable(mostlyRevealed, mostlyRevealed), true);
});

test("scoreUnified reports nulls for an empty population", () => {
  const score = scoreUnified([]);
  assert.equal(score.n, 0);
  assert.equal(score.score, null);
  assert.equal(score.revealedShare, null);
  assert.equal(score.containment, null);
});

test("scoreCoverage exposes the asymmetry that a longer list buys", () => {
  // Acme's production shape: their list is short, ours is long. Coverage
  // looks excellent and precision shows why it is not the whole story.
  const score = scoreCoverage([
    { reference: ["a"], ours: ["a", "x", "y", "z"] },
    { reference: ["b", "c"], ours: ["b", "c", "p", "q"] },
  ]);

  close(score.plain, 1);
  // Every reference item was returned, but most of what we returned was not
  // theirs: 1/4 and 2/4.
  close(score.precision, (0.25 + 0.5) / 2);
  close(score.averageReferenceSize, 1.5);
  close(score.averageOurSize, 4);
});

test("scoreCoverage cannot be gamed into agreement by returning everything", () => {
  // An arm that returns the whole catalog covers any reference perfectly. Only
  // precision and same-first notice.
  const everything = scoreCoverage([{ reference: ["a"], ours: ["z", "y", "x", "a"] }]);

  close(everything.plain, 1);
  close(everything.precision, 0.25);
  // We did not lead with their pick, so the honest agreement figure is zero.
  close(everything.sameFirst, 0);
});

test("scoreCoverage counts a shared first result as agreement", () => {
  const score = scoreCoverage([
    { reference: ["a", "b"], ours: ["a", "z"] },
    { reference: ["c"], ours: ["d", "c"] },
  ]);

  // First shares a leading id; second contains it but does not lead with it.
  close(score.sameFirst, 0.5);
  close(score.plain, (0.5 + 1) / 2);
});
