export type RankingChange = "stable" | "moved" | "dropped" | "added";

export interface RankingDiffEntry {
  id: string;
  change: RankingChange;
  servedRank: number | null;
  shadowRank: number | null;
}

export type RankingDiffSummary = Record<RankingChange, number>;

/**
 * How an experiment's telemetry says it should be read. `ranking-shadow` means
 * the SDK exported per-selection comparison records (shadow ranking parity);
 * `generic` keeps the span-aggregate A/B view. Extensible union — a future
 * ratel-vs-full-catalog A/B becomes its own kind.
 */
export type ExperimentKind = "ranking-shadow" | "generic";

/** Pick the detail view that fits the experiment's exported telemetry. */
export function resolveExperimentKind({
  comparisonCount,
}: {
  comparisonCount: number;
}): ExperimentKind {
  return comparisonCount > 0 ? "ranking-shadow" : "generic";
}

/** Align two ranked id lists (served vs shadow) into per-id change entries. */
export function diffRankings(served: string[], shadow: string[]): RankingDiffEntry[] {
  const shadowRankById = new Map(shadow.map((id, index) => [id, index + 1]));
  const servedIds = new Set(served);
  const servedEntries = served.map((id, index): RankingDiffEntry => {
    const servedRank = index + 1;
    const shadowRank = shadowRankById.get(id) ?? null;
    return {
      id,
      change: shadowRank === null ? "dropped" : shadowRank === servedRank ? "stable" : "moved",
      servedRank,
      shadowRank,
    };
  });
  const addedEntries = shadow.flatMap((id, index): RankingDiffEntry[] =>
    servedIds.has(id) ? [] : [{ id, change: "added", servedRank: null, shadowRank: index + 1 }],
  );
  return [...servedEntries, ...addedEntries];
}

/** Count diff entries by change kind. */
export function summarizeRankingDiff(entries: RankingDiffEntry[]): RankingDiffSummary {
  const summary: RankingDiffSummary = {
    stable: 0,
    moved: 0,
    dropped: 0,
    added: 0,
  };
  for (const entry of entries) {
    summary[entry.change] += 1;
  }
  return summary;
}
