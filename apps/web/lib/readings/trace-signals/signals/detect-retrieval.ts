import type { ProjectStats } from "@/lib/readings/trace-signals/signals/accumulators";
import {
  entrySubject,
  evidenceOf,
  laneOf,
  round4,
  sortedEntries,
} from "@/lib/readings/trace-signals/signals/build";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import {
  median,
  quantile,
  wilson,
  wilsonHigh,
  wilsonLow,
} from "@/lib/readings/trace-signals/signals/severity";
import { parseEntryKey } from "@/lib/readings/trace-signals/signals/turn-facts";
import type { DetectedSignal, DetectionResult } from "@/lib/readings/trace-signals/signals/types";

/**
 * Retrieval signals: what search put in front of the agent, against what it
 * ran. All read pass one (`accumulators.ts`); none needs pairs.
 *
 * - `first_try_miss`: the agent had to search again for the same thing before
 *   it found the tool. n = turns whose first call of it was offered by a
 *   search; k = those whose offering search retried the ask of the search
 *   before it (`same-ask.ts`) and that earlier search did not list the tool. A
 *   later search for a new need in a multi-step turn is not a miss. Routes to
 *   adaptive ranking when most misses had the tool in an older list for the
 *   same ask, just too low; else to a description rewrite.
 * - `buried_tool`: picked from a list where it sat at the buried rank or lower.
 * - `magnet`: listed often in the top three, picked almost never.
 * - `padding_share`: lists longer than the agent uses, by pick rank or by the
 *   score-gap junk estimate.
 * - `unstable_intent`: turns opening with the same query hash start on many
 *   different entries.
 */

const UNSTABLE_INTENT_MAX = 10;

export function detectRetrieval(
  stats: ProjectStats,
  floors: Floors = DEFAULT_FLOORS,
): DetectionResult {
  const entries = sortedEntries(stats.entries);
  const signals: DetectedSignal[] = [
    ...entries.flatMap((entry) => firstTryMiss(entry, floors)),
    ...entries.flatMap((entry) => buriedTool(entry, floors)),
    ...entries.flatMap((entry) => magnet(entry, stats, floors)),
    ...paddingShare(stats, floors),
    ...unstableIntent(stats, floors),
  ];
  return {
    signals,
    measured: new Set([
      "first_try_miss",
      "buried_tool",
      "magnet",
      "padding_share",
      "unstable_intent",
    ]),
  };
}

type Entry = ReturnType<typeof sortedEntries>[number];

function firstTryMiss(entry: Entry, floors: Floors): DetectedSignal[] {
  const f = floors.first_try_miss;
  const n = entry.offeredTurns;
  const k = entry.laterSearchTurns;
  const low = wilsonLow(k, n);
  if (n < f.minN || k < f.minK || low < f.minLow) return [];
  const interval = wilson(k, n);
  const lowInFirst = entry.inFirstSearchLow * 2 >= k;
  return [
    {
      kind: "first_try_miss",
      ...entrySubject(entry),
      lane: laneOf(entry.mix),
      severity: round4(low),
      impact: entry.extraSearches,
      n,
      route: lowInFirst ? "adaptive_ranking" : "rewrite_description",
      metrics: {
        k,
        n,
        share: round4(k / n),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
        extraSearches: entry.extraSearches,
        inFirstSearchLow: entry.inFirstSearchLow,
      },
      evidence: evidenceOf(entry.evidence.firstTry.values(), k),
    },
  ];
}

function buriedTool(entry: Entry, floors: Floors): DetectedSignal[] {
  const f = floors.buried_tool;
  const n = entry.offeredTurns;
  const k = entry.buriedTurns;
  const low = wilsonLow(k, n);
  if (n < f.minN || k < f.minK || low < f.minLow) return [];
  const interval = wilson(k, n);
  return [
    {
      kind: "buried_tool",
      ...entrySubject(entry),
      lane: laneOf(entry.mix),
      severity: round4(low),
      impact: k,
      n,
      route: "adaptive_ranking",
      metrics: {
        k,
        n,
        share: round4(k / n),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
        medianRank: median(entry.buriedRanks.values()) ?? f.minRank,
        minRank: f.minRank,
        rankBands: [...entry.rankBands],
      },
      evidence: evidenceOf(entry.evidence.buried.values(), k),
    },
  ];
}

/**
 * A magnet is listed often, picked almost never, and takes prominent slots
 * doing it. The pick-rate bound is over all its listings. What makes it a
 * magnet rather than filler are its top-3 listings (`impressionsTop3`), the
 * slots it takes from the right tool: it needs a count of them
 * (`minTop3Impressions`) and a share of searches whose top three it took, as a
 * Wilson lower bound (`minTop3Low`), so a tool that pads ranks 8 to 10 of long
 * lists never qualifies however often it is listed.
 *
 * Severity follows every other kind: the Wilson lower bound of the bad rate,
 * here the share of its top-3 slots that were wasted (every pick counted
 * against it, so a stray pick only lowers it). Ranked on the same scale as the
 * rest of the list, a real magnet leads; the top-3 listings are its impact.
 */
function magnet(entry: Entry, stats: ProjectStats, floors: Floors): DetectedSignal[] {
  const f = floors.magnet;
  const impressions = entry.impressions;
  const top3 = entry.impressionsTop3;
  const picks = entry.picks;
  if (impressions < f.minImpressions || top3 < f.minTop3Impressions || picks > f.maxPicks)
    return [];
  if (wilsonHigh(picks, impressions) > f.maxHigh) return [];
  const searches = stats.listingSearches[entry.targetType];
  const prominence = wilsonLow(top3, Math.max(searches, top3));
  if (prominence < f.minTop3Low) return [];
  const listed = wilson(impressions, Math.max(searches, impressions));
  return [
    {
      kind: "magnet",
      ...entrySubject(entry),
      lane: laneOf(stats.mix),
      severity: round4(wilsonLow(Math.max(0, top3 - picks), top3)),
      impact: top3,
      n: impressions,
      route: "rewrite_description",
      metrics: {
        impressions,
        picks,
        searches,
        listShare: round4(impressions / Math.max(searches, impressions)),
        pickShare: round4(picks / impressions),
        low: round4(listed?.low ?? 0),
        high: round4(listed?.high ?? 1),
        impressionsTop3: entry.impressionsTop3,
      },
      evidence: evidenceOf(entry.evidence.magnet.values(), entry.listedTurns),
    },
  ];
}

function paddingShare(stats: ProjectStats, floors: Floors): DetectedSignal[] {
  const f = floors.padding_share;
  const searches = stats.listingSearches.tool + stats.listingSearches.skill;
  if (searches < f.minSearches) return [];
  const pickRankP95 = quantile(stats.pickRanks.values(), 0.95);
  const medianTopK = median(stats.topKs.values());
  const byRank =
    pickRankP95 !== null &&
    medianTopK !== null &&
    pickRankP95 <= f.maxPickRankP95 &&
    medianTopK >= f.minMedianTopK;
  const junkLow = wilsonLow(stats.junkHits, stats.scoredHits);
  const byJunk = stats.scoredHits > 0 && junkLow >= f.minJunkLow;
  if (!byRank && !byJunk) return [];
  const topPicks = stats.picks - stats.picksBelowCutoff;
  const severity = Math.max(byJunk ? junkLow : 0, byRank ? wilsonLow(topPicks, stats.picks) : 0);
  const junk = stats.scoredHits > 0;
  const interval = junk
    ? wilson(stats.junkHits, stats.scoredHits)
    : wilson(stats.picksBelowCutoff, stats.picks);
  const suggestedTopK = Math.max(f.pickCutoff, Math.ceil(pickRankP95 ?? f.pickCutoff));
  return [
    {
      kind: "padding_share",
      subjectKind: "project",
      subjectKey: "project",
      subjectIds: [],
      entryKind: "tool",
      lane: laneOf(stats.mix),
      severity: round4(severity),
      impact: junk ? stats.junkHits : searches * Math.max(0, (medianTopK ?? 0) - suggestedTopK),
      n: junk ? stats.scoredHits : stats.picks,
      route: suggestedTopK < (medianTopK ?? 0) ? "lower_top_k" : "rewrite_description",
      metrics: {
        searches,
        scoredHits: stats.scoredHits,
        junkHits: stats.junkHits,
        junkShare: junk ? round4(stats.junkHits / stats.scoredHits) : null,
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
        medianTopK,
        pickRankP95,
        picks: stats.picks,
        picksBelowCutoff: stats.picksBelowCutoff,
        belowCutoffShare: stats.picks > 0 ? round4(stats.picksBelowCutoff / stats.picks) : 0,
        pickCutoff: f.pickCutoff,
        suggestedTopK,
        byRank,
        byJunk,
      },
      evidence: evidenceOf(stats.paddingEvidence.values(), stats.turnsWithSearch, stats.mix),
    },
  ];
}

function unstableIntent(stats: ProjectStats, floors: Floors): DetectedSignal[] {
  const f = floors.unstable_intent;
  const found: DetectedSignal[] = [];
  for (const [hash, query] of [...stats.queries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (query.n < f.minN || query.firstEntries.size < f.minDistinct) continue;
    const ranked = [...query.firstEntries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const top = ranked[0]![1];
    if (top / query.n >= f.maxTopShare) continue;
    const interval = wilson(top, query.n);
    const entries = ranked.slice(0, 5).map(([key]) => parseEntryKey(key));
    found.push({
      kind: "unstable_intent",
      subjectKind: "query_cluster",
      subjectKey: `q:${hash}`,
      subjectIds: entries.map((e) => e.id),
      entryKind: entries[0]?.targetType ?? "tool",
      lane: laneOf(stats.mix),
      severity: round4(wilsonLow(query.n - top, query.n)),
      impact: query.n - top,
      n: query.n,
      route: "adaptive_ranking",
      metrics: {
        n: query.n,
        distinct: query.firstEntries.size,
        top,
        topShare: round4(top / query.n),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
      },
      evidence: evidenceOf(query.evidence, query.n),
    });
  }
  return found
    .sort((a, b) => b.severity - a.severity || b.impact - a.impact)
    .slice(0, UNSTABLE_INTENT_MAX);
}
