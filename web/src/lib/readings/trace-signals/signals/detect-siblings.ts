import { jaccard, tokenize } from "@/lib/readings/text/cluster";
import type { ProjectStats } from "@/lib/readings/trace-signals/signals/accumulators";
import { evidenceOf, laneOf, round4 } from "@/lib/readings/trace-signals/signals/build";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import type { PairStats } from "@/lib/readings/trace-signals/signals/pairs";
import { wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type {
  CatalogEntryFact,
  DetectedSignal,
  DetectionResult,
} from "@/lib/readings/trace-signals/signals/types";

/**
 * `sibling_confusion`: two tools the agent cannot tell apart. They are listed
 * together (`coHitShare`: searches listing both, over the rarer one's
 * listings), when either is run from a list holding both the first pick is
 * close to a coin toss (`split`: the minority's share of decision turns), and
 * some turns ran both (`swaps`). Severity is the Wilson lower bound of the swap
 * share of decision turns.
 *
 * The token Jaccard of the two tools' searchable text is carried in `metrics`
 * for the reader and for Phase 2's disambiguation prompt; it never decides
 * whether the signal fires, since overlapping text is a cause, not the symptom.
 *
 * Every count here comes from pass two: with `pairPassRan` false the kind is
 * not measured, so its open signals are kept instead of counted as missed.
 */

export function detectSiblings(
  stats: ProjectStats,
  pairs: PairStats,
  catalog: readonly CatalogEntryFact[] = [],
  floors: Floors = DEFAULT_FLOORS,
  pairPassRan = true,
): DetectionResult {
  if (!pairPassRan) return { signals: [], measured: new Set() };
  const f = floors.sibling_confusion;
  const text = new Map(
    catalog
      .filter((e) => e.kind === "tool")
      .map((e) => [e.entryId, new Set(tokenize(`${e.name} ${e.searchable}`))]),
  );
  const signals: DetectedSignal[] = [];
  for (const [key, pair] of [...pairs.siblings].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (pair.swaps < f.minSwaps || pair.decisionTurns === 0) continue;
    const [a, b] = key.split("|") as [string, string];
    const listedA = stats.entries.get(`tool:${a}`)?.impressions ?? 0;
    const listedB = stats.entries.get(`tool:${b}`)?.impressions ?? 0;
    const rarer = Math.min(listedA, listedB);
    if (rarer === 0) continue;
    const coHitShare = pair.coListed / rarer;
    const split = Math.min(pair.firstA, pair.firstB) / pair.decisionTurns;
    if (coHitShare < f.minCoHitShare || split < f.minSplit) continue;
    const interval = wilson(pair.swaps, pair.decisionTurns);
    const textA = text.get(a);
    const textB = text.get(b);
    signals.push({
      kind: "sibling_confusion",
      subjectKind: "tool_pair",
      subjectKey: key,
      subjectIds: [a, b],
      entryKind: "tool",
      lane: laneOf(stats.mix),
      severity: round4(wilsonLow(pair.swaps, pair.decisionTurns)),
      impact: pair.swaps,
      n: pair.decisionTurns,
      route: "disambiguate_pair",
      metrics: {
        swaps: pair.swaps,
        decisionTurns: pair.decisionTurns,
        coListed: pair.coListed,
        coHitShare: round4(coHitShare),
        split: round4(split),
        firstA: pair.firstA,
        firstB: pair.firstB,
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
        textJaccard: textA && textB ? round4(jaccard(textA, textB)) : null,
      },
      evidence: evidenceOf(pair.evidence.values(), pair.swaps),
    });
  }
  return { signals, measured: new Set(["sibling_confusion"]) };
}
