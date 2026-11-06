import type {
  ArmSearchSpan,
  CapabilityComparison,
  CapabilityComparisonSet,
  CapabilityHit,
} from "./types";

interface CapabilityRanks {
  type: CapabilityHit["type"];
  id: string;
  ranksByArm: Map<string, RankStats>;
}

interface RankStats {
  sum: number;
  count: number;
}

export function compareCapabilities(
  baselineArm: string,
  arms: string[],
  searchSpans: ArmSearchSpan[],
): CapabilityComparisonSet {
  const requestedArms = new Set(arms);
  const relevantSpans = deduplicateSearchSpans(
    searchSpans.filter((span) => requestedArms.has(span.arm)),
  );
  const capabilities = collectCapabilityRanks(relevantSpans, requestedArms);
  const hasRankings =
    capabilities.size > 0 &&
    arms.every((arm) => relevantSpans.some((span) => span.arm === arm)) &&
    relevantSpans.every(
      (span) => span.reportedHitCount !== null && span.hits.length === span.reportedHitCount,
    );

  return {
    hasRankings,
    rows: hasRankings
      ? [...capabilities.values()]
          .map((capability) => compareCapability(capability, baselineArm, arms))
          .sort(compareRows)
      : [],
    reportedHitMetrics: arms.map((arm) => reportedHitMetric(arm, relevantSpans)),
  };
}

function reportedHitMetric(
  arm: string,
  searchSpans: ArmSearchSpan[],
): CapabilityComparisonSet["reportedHitMetrics"][number] {
  const armSpans = searchSpans.filter((span) => span.arm === arm);
  const hasUnknownCount = armSpans.some(({ reportedHitCount }) => reportedHitCount === null);
  const total = hasUnknownCount
    ? null
    : armSpans.reduce((sum, span) => sum + (span.reportedHitCount ?? 0), 0);
  return {
    arm,
    total,
    searchSpanCount: armSpans.length,
    averagePerSearch:
      total === null ? null : armSpans.length === 0 ? null : total / armSpans.length,
  };
}

function deduplicateSearchSpans(searchSpans: ArmSearchSpan[]): ArmSearchSpan[] {
  const seen = new Set<string>();
  return searchSpans.filter((span) => {
    const key = JSON.stringify([span.arm, span.traceId, span.spanId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectCapabilityRanks(
  searchSpans: ArmSearchSpan[],
  requestedArms: Set<string>,
): Map<string, CapabilityRanks> {
  const capabilities = new Map<string, CapabilityRanks>();

  for (const span of searchSpans) {
    if (!requestedArms.has(span.arm)) continue;
    for (const hit of bestCapabilityHits(span.hits)) {
      const key = JSON.stringify([hit.type, hit.id]);
      const capability = capabilities.get(key) ?? {
        type: hit.type,
        id: hit.id,
        ranksByArm: new Map<string, RankStats>(),
      };
      const stats = capability.ranksByArm.get(span.arm) ?? { sum: 0, count: 0 };
      stats.sum += hit.rank;
      stats.count += 1;
      capability.ranksByArm.set(span.arm, stats);
      capabilities.set(key, capability);
    }
  }

  return capabilities;
}

function bestCapabilityHits(hits: CapabilityHit[]): CapabilityHit[] {
  const bestHits = new Map<string, CapabilityHit>();
  for (const hit of hits) {
    const key = JSON.stringify([hit.type, hit.id]);
    const best = bestHits.get(key);
    if (!best || hit.rank < best.rank) {
      bestHits.set(key, hit);
    }
  }
  return [...bestHits.values()];
}

function compareCapability(
  capability: CapabilityRanks,
  baselineArm: string,
  arms: string[],
): CapabilityComparison {
  const baselineStats = capability.ranksByArm.get(baselineArm);
  const baselineAverageRank = averageRank(baselineStats);
  const armComparisons = arms.map((arm) => {
    const stats = capability.ranksByArm.get(arm);
    const appearances = stats?.count ?? 0;
    const averageRankForArm = averageRank(stats);
    return {
      arm,
      appearances,
      averageRank: averageRankForArm,
      rankDelta:
        averageRankForArm === null || baselineAverageRank === null
          ? null
          : averageRankForArm - baselineAverageRank,
      absent: appearances === 0,
    };
  });
  const comparableDeltas = armComparisons.flatMap(({ arm, rankDelta }) =>
    arm === baselineArm || rankDelta === null ? [] : [Math.abs(rankDelta)],
  );

  return {
    type: capability.type,
    id: capability.id,
    baselineAppearances: baselineStats?.count ?? 0,
    baselineAverageRank,
    arms: armComparisons,
    maxAbsoluteRankDelta: comparableDeltas.length === 0 ? null : Math.max(...comparableDeltas),
  };
}

function averageRank(stats: RankStats | undefined): number | null {
  return !stats || stats.count === 0 ? null : stats.sum / stats.count;
}

function compareRows(left: CapabilityComparison, right: CapabilityComparison): number {
  const leftDelta = left.maxAbsoluteRankDelta;
  const rightDelta = right.maxAbsoluteRankDelta;
  if (leftDelta === null && rightDelta !== null) return 1;
  if (leftDelta !== null && rightDelta === null) return -1;
  if (leftDelta !== null && rightDelta !== null && leftDelta !== rightDelta) {
    return rightDelta - leftDelta;
  }
  return compareStrings(left.type, right.type) || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
