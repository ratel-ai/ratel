/**
 * Label a sample, look at it, label more only when the number is not yet
 * good enough (RC-394).
 *
 * Every feature that asks the decision engine about the same asks (Match
 * quality's answer key, Intents' topic placement, Tasks' workflow decisions)
 * shares the same question: how many more answers does this number need?
 * This file answers it, pure and model-free, so each feature decides WHAT to
 * ask and this decides HOW MANY.
 *
 * The number is a share (for example "our first result was the right tool")
 * measured over strata: groups of asks sampled at different rates, such as
 * searches where our engine and the baseline disagreed and searches where
 * they agreed. Each stratum's share is weighted by its share of the
 * population, never by how many of it happened to be labelled, so a
 * stratum sampled harder does not tilt the estimate.
 *
 * Sizes come from Neyman allocation for a target margin at 95%: a stratum
 * that is bigger, or whose answers vary more, gets more of the labels. A
 * stratum not labelled yet is assumed maximally uncertain (a share of one
 * half), so the first batch is never too small, and the size shrinks as real
 * answers arrive. That is the whole loop: label a batch, re-estimate, and
 * stop when the margin is met.
 */

/** z for a two-sided 95% interval. */
export const Z_95 = 1.96;

/** The margin a headline share needs by default: plus or minus five points. */
export const DEFAULT_TARGET_MARGIN = 0.05;

/** One stratum: how many asks it holds, how many are labelled, and how many of those were hits. */
export interface StratumTally {
  population: number;
  labelled: number;
  hits: number;
}

export interface ShareEstimate {
  /** The weighted share over strata with any label; null when nothing is labelled. */
  share: number | null;
  /** Half-width of the 95% interval; null when nothing is labelled. */
  margin: number | null;
  labelled: number;
  population: number;
}

/**
 * The share's spread in one stratum, pulled towards one half by two
 * pseudo-hits and two pseudo-misses (Agresti-Coull), so a stratum with ten
 * hits out of ten does not claim zero uncertainty.
 */
function spread(stratum: StratumTally): number {
  const adjusted = (stratum.hits + 2) / (stratum.labelled + 4);
  return Math.sqrt(adjusted * (1 - adjusted));
}

function clean(strata: readonly StratumTally[]): StratumTally[] {
  return strata.map((stratum) => {
    const population = Math.max(0, Math.floor(stratum.population));
    const labelled = Math.min(population, Math.max(0, Math.floor(stratum.labelled)));
    return {
      population,
      labelled,
      hits: Math.min(labelled, Math.max(0, Math.floor(stratum.hits))),
    };
  });
}

/**
 * The stratified share and its 95% margin, with the finite population
 * correction (a stratum labelled in full has no sampling error left).
 *
 * Strata nobody labelled are left out of the weights, as `stratifiedAccuracy`
 * does: the estimate covers what was measured rather than assuming the
 * unmeasured part behaved like the measured one. `labelsNeeded` is what
 * closes that gap, since an unlabelled stratum always asks for labels.
 */
export function stratifiedShare(strata: readonly StratumTally[], z: number = Z_95): ShareEstimate {
  const all = clean(strata);
  const measured = all.filter((stratum) => stratum.labelled > 0);
  const labelled = all.reduce((sum, stratum) => sum + stratum.labelled, 0);
  const population = all.reduce((sum, stratum) => sum + stratum.population, 0);
  const weight = measured.reduce((sum, stratum) => sum + stratum.population, 0);
  if (measured.length === 0 || weight === 0)
    return { share: null, margin: null, labelled, population };
  let share = 0;
  let variance = 0;
  for (const stratum of measured) {
    const w = stratum.population / weight;
    share += w * (stratum.hits / stratum.labelled);
    const fpc =
      stratum.population > 1
        ? (stratum.population - stratum.labelled) / (stratum.population - 1)
        : 0;
    variance += w * w * (spread(stratum) ** 2 / stratum.labelled) * Math.max(0, fpc);
  }
  return { share, margin: z * Math.sqrt(variance), labelled, population };
}

/**
 * How many MORE labels each stratum needs for the share to reach
 * `targetMargin`, by Neyman allocation; zeros once it is reached.
 *
 * Never more than a stratum's unlabelled remainder. A stratum with any
 * population but no labels asks for at least `minPerStratum`, so every part
 * of the population gets measured.
 */
export function labelsNeeded(
  strata: readonly StratumTally[],
  targetMargin: number = DEFAULT_TARGET_MARGIN,
  opts: { z?: number; minPerStratum?: number } = {},
): number[] {
  const z = opts.z ?? Z_95;
  const minPerStratum = opts.minPerStratum ?? 10;
  const all = clean(strata);
  const total = all.reduce((sum, stratum) => sum + stratum.population, 0);
  if (total === 0 || !(targetMargin > 0)) return all.map(() => 0);
  const variance = (targetMargin / z) ** 2;
  const weighted = all.map((stratum) => (stratum.population / total) * spread(stratum));
  const sumWS = weighted.reduce((sum, value) => sum + value, 0);
  const sumWS2 = all.reduce(
    (sum, stratum, index) => sum + (weighted[index] ?? 0) * spread(stratum),
    0,
  );
  // Total sample for the target, with the finite population correction.
  const n0 = (sumWS * sumWS) / variance;
  const n = n0 / (1 + sumWS2 / (total * variance));
  return all.map((stratum, index) => {
    if (stratum.population === 0) return 0;
    const share = sumWS > 0 ? (weighted[index] ?? 0) / sumWS : 1 / all.length;
    const floor = stratum.labelled === 0 ? minPerStratum : 0;
    const wanted = Math.max(Math.ceil(n * share), floor);
    return Math.max(0, Math.min(stratum.population, wanted) - stratum.labelled);
  });
}

/**
 * Whether answers carried over from an earlier option set can still be
 * trusted, from a re-asked sample of them: "distrust" when the sample agrees
 * less often than `threshold`, "trust" otherwise, and "unknown" while fewer
 * than `minSample` were re-asked (a carry is kept until there is evidence
 * against it, the same as before the audit existed).
 */
export function auditVerdict(
  agreed: number,
  asked: number,
  opts: { threshold?: number; minSample?: number } = {},
): "trust" | "distrust" | "unknown" {
  const threshold = opts.threshold ?? AUDIT_TRUST_THRESHOLD;
  const minSample = opts.minSample ?? AUDIT_MIN_SAMPLE;
  if (asked <= 0 || asked < minSample) return "unknown";
  return agreed / asked < threshold ? "distrust" : "trust";
}

/** Below this agreement a re-asked sample stops carried answers from standing. */
export const AUDIT_TRUST_THRESHOLD = 0.85;
/** Re-asked answers needed before an audit can distrust a carry. */
export const AUDIT_MIN_SAMPLE = 10;
/** Carried answers re-asked per run, at most, to audit the carry. */
export const AUDIT_SAMPLE = 20;

/**
 * A deterministic sample of `count` items, spread evenly over the list (so a
 * pick spans the whole window instead of one afternoon of it).
 */
export function spreadPick<T>(rows: readonly T[], count: number): T[] {
  const limit = Math.max(0, Math.floor(count));
  if (rows.length <= limit) return [...rows];
  const step = rows.length / limit;
  const picked: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const row = rows[Math.floor(index * step)];
    if (row !== undefined) picked.push(row);
  }
  return picked;
}
