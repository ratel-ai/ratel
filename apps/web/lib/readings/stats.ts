/**
 * The two statistics the readings share with the quality meter (L5), kept here so the
 * detectors can read them without reaching up a layer. Owned (ADR-0030): upstream defines
 * both in its quality metrics module beside the metric itself.
 */

export interface ConfidenceInterval {
  low: number;
  high: number;
}

/**
 * 95% Wilson score interval for a proportion.
 *
 * Shown beside every share read from a small population, because a bare "56%" invites
 * reading a ten-point swing as a result when it is noise. Wilson rather than the normal
 * approximation because it stays inside [0, 1] and behaves at the extremes, where a small
 * sample most often sits.
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
 * How close to the leader a search result must score to count as confident. The cut the
 * first retrieval analysis reported against, kept so the numbers stay comparable; it only
 * ever affects companion panels, never a quality figure.
 */
export const CONFIDENT_SCORE_RATIO = 0.9;
