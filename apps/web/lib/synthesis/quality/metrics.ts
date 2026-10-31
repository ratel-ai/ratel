/**
 * The quality metric, defined once, in pure functions over plain numbers.
 *
 * The question this answers is "when the agent needed a tool, did our list
 * contain it, and how near the top did we put it?", and it answers that without
 * a judge, from what an arm actually returned and what the agent actually ran.
 *
 * TWO numbers are reported side by side rather than one, because they fail
 * differently and a single figure hides which one moved:
 *
 *   Containment   the share of searches whose target appeared ANYWHERE in the
 *                 returned list. Rank-blind. This is the number that says
 *                 whether retrieval found the thing at all.
 *   Quality       the same population, but each hit earns {@link hitCredit}
 *                 instead of a flat 1: half a point for being in the list at
 *                 all, and the other half scaled by `1 / log2(1 + rank)`. Rank 1
 *                 scores 1.00, rank 2 scores 0.82, rank 3 scores 0.75, rank 5
 *                 scores 0.69, absent scores 0.
 *
 * WHY NOT PLAIN nDCG. The list we score is the list the agent was actually
 * shown, its own top-k, and an agent reads every result it is given. So a
 * target anywhere in that list is a success, and the outcome that actually
 * hurts is the target falling outside it. Plain nDCG credits rank 2 at 0.63,
 * which printed a tool the agent saw at #2 as a third of a failure and sent
 * readers chasing searches that had worked. Higher is still better, which is
 * why rank still earns something, but it is a refinement on top of "found",
 * not a second way to fail.
 *
 * The half is the only constant here, and it is a statement rather than a fit:
 * being shown is worth as much as the whole of placement.
 *
 * `Quality = Containment × Placement` exactly, where Placement is the mean hit
 * credit over the hits alone. So a drop in Quality always decomposes into "we
 * stopped finding it" or "we started ranking it lower", and the UI shows which.
 */

/**
 * The share of a hit's credit earned just by being in the list the agent saw.
 *
 * See the module comment: half for being shown, half for placement.
 */
export const SHOWN_CREDIT = 0.5;

/**
 * Discounted-gain rank credit, `1 / log2(1 + rank)`. Absent scores 0.
 *
 * Plain nDCG. Used where a POSITION is being weighted rather than an outcome
 * scored, such as how much of the incumbent's ordering we reproduced; the
 * per-search Quality credit is {@link hitCredit}.
 */
export function rankCredit(rank: number): number {
  if (!Number.isFinite(rank) || rank < 1) return 0;
  return 1 / Math.log2(1 + rank);
}

/**
 * Credit for the target found at 1-based `rank` in the list the agent saw.
 *
 * {@link SHOWN_CREDIT} for being there, plus the rest scaled by rank. Absent,
 * which includes "ranked outside the agent's top-k", scores 0.
 */
export function hitCredit(rank: number | null): number {
  if (rank === null || !Number.isFinite(rank) || rank < 1) return 0;
  return SHOWN_CREDIT + (1 - SHOWN_CREDIT) * rankCredit(rank);
}

/**
 * Summed hit credit for a stored rank histogram.
 *
 * The daily rollup keeps the histogram beside the pre-summed credit, so the
 * trend can re-derive credit under the current curve instead of trusting a sum
 * written under an older one. That is what keeps an archive day and a fresh day
 * on the same scale when the curve changes.
 */
export function creditFromHistogram(histogram: RankHistogram): number {
  let sum = 0;
  for (const [key, count] of Object.entries(histogram)) {
    if (key === ABSENT) continue;
    sum += hitCredit(Number(key)) * count;
  }
  return sum;
}

/** Reciprocal rank for a target found at 1-based `rank`. Absent scores 0. */
export function reciprocalRank(rank: number): number {
  if (!Number.isFinite(rank) || rank < 1) return 0;
  return 1 / rank;
}

/**
 * One evaluated search: where the ground-truth target landed in an arm's list.
 *
 * `rank` is 1-based, or null when the arm did not return the target at all.
 * Null is a real, scored outcome (zero) rather than a missing observation.
 * dropping these would measure only the searches we already won.
 */
export interface RankObservation {
  rank: number | null;
}

/** Everything the meter shows for one (arm, tier, window) population. */
export interface QualityScore {
  /** Evaluable searches. Every figure below is meaningless without it. */
  n: number;
  /** Searches whose target appeared anywhere in the list. */
  contained: number;
  /** `contained / n`, or null when nothing was evaluable. */
  containment: number | null;
  /** Mean hit credit over the contained searches only, or null. */
  placement: number | null;
  /** Mean hit credit over ALL evaluable searches. Containment × Placement. */
  quality: number | null;
  /** Mean reciprocal rank over all evaluable searches, or null. */
  mrr: number | null;
  /** 95% Wilson interval on containment, or null. */
  containmentInterval: ConfidenceInterval | null;
  /** Count of searches by 1-based rank; the `absent` key holds the misses. */
  rankHistogram: RankHistogram;
}

/** Counts keyed by 1-based rank as a string, plus `absent` for the misses. */
export type RankHistogram = Record<string, number>;

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export const ABSENT = "absent";

/** Score a population of rank observations. */
export function scoreObservations(observations: readonly RankObservation[]): QualityScore {
  return scoreTotals(totalsFromObservations(observations));
}

/**
 * Fold pre-aggregated sums back into a score.
 *
 * The daily rollup stores sums rather than raw observations, so the page can
 * span more than the 30 days of telemetry retention. Summing sums and dividing
 * once is exactly equivalent to scoring the union of the raw populations, which
 * is why the rollup keeps sums instead of the already-divided rates: averaging
 * daily rates would silently weight a quiet Sunday like a busy Tuesday.
 */
export interface QualityTotals {
  n: number;
  contained: number;
  creditSum: number;
  reciprocalSum: number;
  rankHistogram: RankHistogram;
}

export function emptyTotals(): QualityTotals {
  return {
    n: 0,
    contained: 0,
    creditSum: 0,
    reciprocalSum: 0,
    rankHistogram: {},
  };
}

export function addTotals(left: QualityTotals, right: QualityTotals): QualityTotals {
  const rankHistogram: RankHistogram = { ...left.rankHistogram };
  for (const [key, count] of Object.entries(right.rankHistogram)) {
    rankHistogram[key] = (rankHistogram[key] ?? 0) + count;
  }
  return {
    n: left.n + right.n,
    contained: left.contained + right.contained,
    creditSum: left.creditSum + right.creditSum,
    reciprocalSum: left.reciprocalSum + right.reciprocalSum,
    rankHistogram,
  };
}

export function totalsFromObservations(observations: readonly RankObservation[]): QualityTotals {
  const rankHistogram: RankHistogram = {};
  let contained = 0;
  let creditSum = 0;
  let reciprocalSum = 0;

  for (const observation of observations) {
    const rank = observation.rank;
    if (rank === null || !Number.isFinite(rank) || rank < 1) {
      rankHistogram[ABSENT] = (rankHistogram[ABSENT] ?? 0) + 1;
      continue;
    }
    contained += 1;
    creditSum += hitCredit(rank);
    reciprocalSum += reciprocalRank(rank);
    const key = String(rank);
    rankHistogram[key] = (rankHistogram[key] ?? 0) + 1;
  }

  return {
    n: observations.length,
    contained,
    creditSum,
    reciprocalSum,
    rankHistogram,
  };
}

export function scoreTotals(totals: QualityTotals): QualityScore {
  const { n, contained, creditSum, reciprocalSum, rankHistogram } = totals;
  return {
    n,
    contained,
    containment: n === 0 ? null : contained / n,
    placement: contained === 0 ? null : creditSum / contained,
    quality: n === 0 ? null : creditSum / n,
    mrr: n === 0 ? null : reciprocalSum / n,
    containmentInterval: n === 0 ? null : wilsonInterval(contained, n),
    rankHistogram,
  };
}

/**
 * 95% Wilson score interval for a proportion.
 *
 * Shown next to containment on every surface, because the populations here are
 * small (a partner week is tens of searches, not thousands) and a bare "56%"
 * invites reading a ten-point swing as a result when it is noise. Wilson rather
 * than the normal approximation because it stays inside [0, 1] and behaves at
 * the extremes, where a small sample most often sits.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.96,
): ConfidenceInterval | null {
  if (total <= 0) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return {
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  };
}

/**
 * Whether two populations differ by more than their sampling noise.
 *
 * Deliberately crude, non-overlapping Wilson intervals, because the decision
 * it supports is crude: "is this edit worth reading as an improvement, or should
 * I wait for more traffic?" A conservative test that says "not yet" too often is
 * the right failure for that question.
 */
export function separated(
  left: ConfidenceInterval | null,
  right: ConfidenceInterval | null,
): boolean {
  if (!left || !right) return false;
  return left.low > right.high || right.low > left.high;
}

/**
 * Which half of `Quality = Containment × Placement` moved.
 *
 * Because quality is exactly that product, a gap between two arms decomposes
 * without approximation:
 *
 *   Δq = (c_a − c_b)·p_b  +  c_a·(p_a − p_b)
 *        \____________/      \____________/
 *          containment           placement
 *
 * The two terms sum to the gap exactly, so the larger one names the cause
 * rather than being a guess about it. This matters because the two failures
 * need opposite fixes: missing coverage is a corpus problem, poor placement is
 * a ranking problem, and telling a partner the wrong one sends them to rewrite
 * descriptions that were never at fault.
 */
export interface QualityGap {
  /** Total difference in quality, positive when `arm` leads `baseline`. */
  total: number;
  /** The part attributable to finding the target at all. */
  containment: number;
  /** The part attributable to where it was ranked. */
  placement: number;
  /** Which term dominates, or `even` when neither does. */
  driver: "containment" | "placement" | "even";
}

export function explainQualityGap(arm: QualityScore, baseline: QualityScore): QualityGap | null {
  const { containment: ca, placement: pa, quality: qa } = arm;
  const { containment: cb, placement: pb, quality: qb } = baseline;
  if (qa === null || qb === null || ca === null || cb === null) return null;
  // A placement of null means the arm never contained the target, in which case
  // it contributed no rank credit at all: zero, not "unknown".
  const armPlacement = pa ?? 0;
  const baselinePlacement = pb ?? 0;

  const containment = (ca - cb) * baselinePlacement;
  const placement = ca * (armPlacement - baselinePlacement);
  const total = qa - qb;

  return {
    total,
    containment,
    placement,
    driver: driverOf(containment, placement),
  };
}

/**
 * A term has to be clearly ahead to be called the driver.
 *
 * Naming a cause that is 51% of the difference would be a coin flip dressed as
 * a finding, so a term must carry at least twice the other to claim it.
 */
function driverOf(containment: number, placement: number): QualityGap["driver"] {
  const c = Math.abs(containment);
  const p = Math.abs(placement);
  if (c === 0 && p === 0) return "even";
  if (c >= p * 2) return "containment";
  if (p >= c * 2) return "placement";
  return "even";
}

/**
 * How much of the incumbent's list we reproduced.
 *
 * The reference tier's first idea was "did we contain their top result", and
 * that is a bad target: their first result is not necessarily the right answer
 * either. If the answer was actually their third and we returned their second
 * and third, we did fine, and scoring only their first calls that a miss.
 *
 * So the target is their WHOLE list, and the score is the share of it we
 * returned. Each of their positions is weighted by the same rank credit used
 * everywhere else, because their ordering is evidence even though it is not
 * truth: missing their first costs more than missing their fourth, but missing
 * their first is no longer fatal.
 *
 * This is recall against a reference set, not accuracy. It cannot say we were
 * right; it says how much of what a system the customer already trusts we also
 * surfaced. That is the strongest claim available without knowing which tool the
 * agent ran, and it is stated that way on every surface.
 */
export interface CoverageSample {
  /** The incumbent's ranked list for one search. */
  reference: readonly string[];
  /** Our ranked list for the same search. */
  ours: readonly string[];
}

export interface CoverageScore {
  n: number;
  /** Rank-weighted share of the reference list we returned, in [0, 1]. */
  weighted: number | null;
  /** Plain share of the reference list we returned, ignoring their order. */
  plain: number | null;
  /**
   * The reverse direction: share of OUR list that appears in theirs.
   *
   * Never omit this. Coverage is recall, and recall is bought by returning
   * more: an arm that returned the whole catalog would cover any reference
   * perfectly. Acme's production numbers are the case in point, where we
   * cover 88% of a list averaging 1.8 items while returning 4.2 ourselves, and
   * only 41% of what we return appears in theirs. Coverage alone reads as
   * agreement; with precision beside it, the asymmetry is the first thing seen.
   */
  precision: number | null;
  /**
   * Share of searches where both lists START with the same id.
   *
   * The number a reader actually means by "do we agree". It is symmetric, it
   * cannot be bought with a longer list, and it is usually far below coverage.
   */
  sameFirst: number | null;
  /** Share of searches where we returned their entire list. */
  completeShare: number | null;
  /** Share of searches where we returned none of it. */
  disjointShare: number | null;
  /** Mean reference list length, so the reader can size the denominator. */
  averageReferenceSize: number | null;
  /** Mean length of our own list, which is what makes coverage easy or hard. */
  averageOurSize: number | null;
}

export function scoreCoverage(samples: readonly CoverageSample[]): CoverageScore {
  const usable = samples.filter((sample) => sample.reference.length > 0);
  if (usable.length === 0) {
    return {
      n: 0,
      weighted: null,
      plain: null,
      precision: null,
      sameFirst: null,
      completeShare: null,
      disjointShare: null,
      averageReferenceSize: null,
      averageOurSize: null,
    };
  }

  let weightedSum = 0;
  let plainSum = 0;
  let precisionSum = 0;
  let precisionN = 0;
  let sameFirst = 0;
  let complete = 0;
  let disjoint = 0;
  let referenceSize = 0;
  let ourSize = 0;

  for (const sample of usable) {
    const ours = new Set(sample.ours);
    let credit = 0;
    let total = 0;
    let hits = 0;
    // Deduplicated: an arm that returns the same id twice must not earn twice.
    const seen = new Set<string>();
    let position = 0;
    for (const id of sample.reference) {
      if (seen.has(id)) continue;
      seen.add(id);
      position += 1;
      const weight = rankCredit(position);
      total += weight;
      if (ours.has(id)) {
        credit += weight;
        hits += 1;
      }
    }
    const size = seen.size;
    referenceSize += size;
    weightedSum += total > 0 ? credit / total : 0;
    plainSum += hits / size;
    if (hits === size) complete += 1;
    if (hits === 0) disjoint += 1;

    const ourIds = new Set(sample.ours);
    ourSize += ourIds.size;
    if (ourIds.size > 0) {
      precisionN += 1;
      let inTheirs = 0;
      for (const id of ourIds) if (seen.has(id)) inTheirs += 1;
      precisionSum += inTheirs / ourIds.size;
    }
    if (sample.ours[0] !== undefined && sample.ours[0] === sample.reference[0]) {
      sameFirst += 1;
    }
  }

  const n = usable.length;
  return {
    n,
    weighted: weightedSum / n,
    plain: plainSum / n,
    precision: precisionN === 0 ? null : precisionSum / precisionN,
    sameFirst: sameFirst / n,
    completeShare: complete / n,
    disjointShare: disjoint / n,
    averageReferenceSize: referenceSize / n,
    averageOurSize: ourSize / n,
  };
}

/**
 * One score per search, built from the strongest evidence that search has.
 *
 * Telemetry arrives unevenly: an agent's `execute_operation` may be attributed
 * back to the search that offered it while a direct tool call is not, so the
 * same window holds searches with a known answer and searches without one.
 * Scoring the whole window in one mode wastes the strong evidence or discards
 * the dense evidence; choosing per search does neither.
 *
 * The two credits are both in [0, 1] and both mean "how much of what this search
 * needed did we return", so they add. What they do NOT share is strength:
 *
 *   REVEALED   credit against the tool the agent actually ran.
 *   JUDGED     credit against the answer key's tool for the request, decided
 *              independently of every arm.
 *
 * Both are real answers, and a search with neither is left out rather than
 * scored against the incumbent's guess. {@link UnifiedScore} still reports the
 * MIX and both sub-scores next to
 * the blended figure, never the blended figure alone. Without the mix, a partner
 * switching more of their traffic to attributed invocations would move this
 * number without anything about retrieval having changed, and it would read as
 * a quality result. That failure is the whole reason the split is surfaced.
 */
export type EvidenceKind = "revealed" | "judged";

export interface UnifiedObservation {
  evidence: EvidenceKind;
  /** Credit earned by this search, in [0, 1]. Rank-weighted. */
  credit: number;
  /**
   * The same search scored rank-blind: did we have it at all.
   *
   * One when the answer was anywhere in the list, zero otherwise. This is
   * what the trend plots, because for an agent that reads its whole list, HAVING
   * the tool is the outcome and leading with it is a refinement. Keeping both
   * lets the trend answer "are we finding it" while the headline still answers
   * "and are we putting it near the top".
   */
  reach: number;
  /**
   * Whether the answer was in the list at all. Null only for a legacy
   * observation that had no single answer to contain.
   */
  contained: boolean | null;
}

export interface UnifiedScore {
  n: number;
  /** Mean credit over every evaluable search, whatever its evidence. */
  score: number | null;
  /** Share of the population carrying a known answer. */
  revealedShare: number | null;
  /** Mean credit over the revealed searches alone. */
  revealedScore: number | null;
  revealedN: number;
  /** Mean credit over the answer-key searches alone. */
  judgedScore: number | null;
  judgedN: number;
  /** Mean rank-blind reach over every evaluable search. */
  reach: number | null;
  /**
   * Containment over every search with a known answer, revealed or judged.
   * Every revealed observation comes from an arm that did NOT serve the search
   * (see `observeUnified`), and a judged answer was chosen independently of all
   * arms, so neither needs further qualification.
   */
  containment: number | null;
  containmentN: number;
  containmentInterval: ConfidenceInterval | null;
}

export function scoreUnified(observations: readonly UnifiedObservation[]): UnifiedScore {
  const n = observations.length;
  let creditSum = 0;
  let revealedSum = 0;
  let revealedN = 0;
  let judgedSum = 0;
  let judgedN = 0;
  let contained = 0;
  let containmentN = 0;
  let reachSum = 0;

  for (const observation of observations) {
    creditSum += observation.credit;
    reachSum += observation.reach;
    if (observation.evidence === "revealed") {
      revealedN += 1;
      revealedSum += observation.credit;
    } else {
      judgedN += 1;
      judgedSum += observation.credit;
    }
    if (observation.contained !== null) {
      containmentN += 1;
      if (observation.contained) contained += 1;
    }
  }

  return {
    n,
    score: n === 0 ? null : creditSum / n,
    revealedShare: n === 0 ? null : revealedN / n,
    revealedScore: revealedN === 0 ? null : revealedSum / revealedN,
    revealedN,
    judgedScore: judgedN === 0 ? null : judgedSum / judgedN,
    judgedN,
    reach: n === 0 ? null : reachSum / n,
    containment: containmentN === 0 ? null : contained / containmentN,
    containmentN,
    containmentInterval: containmentN === 0 ? null : wilsonInterval(contained, containmentN),
  };
}

/**
 * Whether two windows' evidence mixes are close enough to compare.
 *
 * A blended score is only comparable against another blended score built from a
 * similar mix. Ten points of drift in the revealed share is enough to move the
 * headline on its own, so past that the surfaces say the two are not comparable
 * rather than letting a telemetry rollout be read as a quality change.
 */
export const COMPARABLE_MIX_DRIFT = 0.1;

export function mixComparable(left: UnifiedScore, right: UnifiedScore): boolean {
  if (left.revealedShare === null || right.revealedShare === null) return true;
  return Math.abs(left.revealedShare - right.revealedShare) <= COMPARABLE_MIX_DRIFT;
}

/**
 * What an arm's list costs the agent, beyond whether it was right.
 *
 * A list that fills every slot with weaker matches is worse than a short list
 * with the same hit: it spends the agent's context and its attention. None of
 * this folds into Quality. Weighting a padding penalty against rank credit
 * would be a judgement call dressed as arithmetic, so it is reported alongside.
 */
export interface ListCostSample {
  /** How many results the arm actually returned. */
  returned: number;
  /** The limit the request asked for, when the telemetry recorded one. */
  requested: number | null;
  /** Per-result scores in rank order, when the arm exported them. */
  scores: readonly number[] | null;
}

export interface ListCost {
  n: number;
  /** Mean list length. */
  averageReturned: number | null;
  /** Share of searches that returned exactly the requested limit. */
  fillRate: number | null;
  /**
   * Share of returned results scoring within `CONFIDENT_SCORE_RATIO` of the
   * top result. The complement is the tail the agent probably should not have
   * been shown. Measured, not judged.
   */
  confidentShare: number | null;
  /** Mean size of that confident prefix. */
  averageConfidentReturned: number | null;
}

/**
 * How close to the leader a result must score to count as confident.
 *
 * 0.90 is not tuned to this data; it is the cut the Acme analysis reported
 * against, kept so the two numbers stay comparable. It only ever affects the
 * companion panel, never Quality.
 */
export const CONFIDENT_SCORE_RATIO = 0.9;

export function summarizeListCost(samples: readonly ListCostSample[]): ListCost {
  if (samples.length === 0) {
    return {
      n: 0,
      averageReturned: null,
      fillRate: null,
      confidentShare: null,
      averageConfidentReturned: null,
    };
  }

  let returnedSum = 0;
  let filled = 0;
  let fillable = 0;
  let scoredResults = 0;
  let confidentResults = 0;
  let scoredSamples = 0;
  let confidentReturnedSum = 0;

  for (const sample of samples) {
    returnedSum += sample.returned;
    if (sample.requested !== null && sample.requested > 0) {
      fillable += 1;
      if (sample.returned >= sample.requested) filled += 1;
    }
    const confident = countConfident(sample.scores);
    if (confident !== null) {
      scoredSamples += 1;
      scoredResults += sample.scores!.length;
      confidentResults += confident;
      confidentReturnedSum += confident;
    }
  }

  return {
    n: samples.length,
    averageReturned: returnedSum / samples.length,
    fillRate: fillable === 0 ? null : filled / fillable,
    confidentShare: scoredResults === 0 ? null : confidentResults / scoredResults,
    averageConfidentReturned: scoredSamples === 0 ? null : confidentReturnedSum / scoredSamples,
  };
}

/** How many of `scores` sit within the confident band of the leader. */
function countConfident(scores: readonly number[] | null): number | null {
  if (!scores || scores.length === 0) return null;
  const top = Math.max(...scores);
  // A non-positive top score carries no ordering information, so calling any
  // prefix of it "confident" would be inventing a result.
  if (!Number.isFinite(top) || top <= 0) return null;
  return scores.filter((score) => score >= top * CONFIDENT_SCORE_RATIO).length;
}
