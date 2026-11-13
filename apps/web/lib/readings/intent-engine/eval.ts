/**
 * Clustering quality against labelled asks, for the offline comparison
 * (`scripts/compare-intent-engine.mts`). Pure.
 *
 *   - purity: share of asks whose predicted cluster's majority label is theirs
 *     (high when clusters are clean, even if over-split);
 *   - inverse purity: the same from the labels' side (high when a label is not
 *     scattered over many clusters);
 *   - pairwise precision / recall / F1 over every pair of asks: a pair is
 *     predicted together when it shares a cluster, truly together when it
 *     shares a label. Precision punishes over-merging, recall over-splitting.
 */

export interface ClusterScore {
  asks: number;
  clusters: number;
  labels: number;
  purity: number;
  inversePurity: number;
  precision: number;
  recall: number;
  f1: number;
}

/** `predicted[i]` and `gold[i]` are ask i's cluster and label. */
export function scoreClustering(
  predicted: readonly string[],
  gold: readonly string[],
): ClusterScore {
  if (predicted.length !== gold.length) throw new Error("predicted and gold differ in length");
  const n = predicted.length;
  const majorityShare = (by: readonly string[], of: readonly string[]) => {
    const groups = new Map<string, Map<string, number>>();
    by.forEach((key, i) => {
      const counts = groups.get(key) ?? new Map<string, number>();
      counts.set(of[i], (counts.get(of[i]) ?? 0) + 1);
      groups.set(key, counts);
    });
    let hit = 0;
    for (const counts of groups.values()) hit += Math.max(...counts.values());
    return n === 0 ? 0 : hit / n;
  };
  // Pairs from contingency counts, not by enumerating pairs: O(n) in the asks.
  const pairs = (k: number) => (k * (k - 1)) / 2;
  const countBy = (keys: readonly string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const both = countBy(predicted.map((p, i) => `${p}\u0000${gold[i]}`));
  let together = 0;
  for (const k of both.values()) together += pairs(k);
  let predictedPairs = 0;
  for (const k of countBy(predicted).values()) predictedPairs += pairs(k);
  let goldPairs = 0;
  for (const k of countBy(gold).values()) goldPairs += pairs(k);
  const precision = predictedPairs === 0 ? 1 : together / predictedPairs;
  const recall = goldPairs === 0 ? 1 : together / goldPairs;
  return {
    asks: n,
    clusters: new Set(predicted).size,
    labels: new Set(gold).size,
    purity: majorityShare(predicted, gold),
    inversePurity: majorityShare(gold, predicted),
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}
