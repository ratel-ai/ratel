import { round4 } from "@/lib/readings/trace-signals/signals/build";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import { wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type {
  ClusterFact,
  DetectedSignal,
  DetectionResult,
} from "@/lib/readings/trace-signals/signals/types";
import type { TurnSourceMix } from "@/lib/readings/trace-signals/view";

/**
 * Demand signals: what users ask for, read from the stored intent graph rather
 * than from this window's turns.
 *
 * - `fragmented_intents`: most of the graph's clusters are singletons (an ask
 *   seen once), so adaptive ranking has nothing to generalize from. Severity is
 *   the Wilson lower bound of the singleton share. Not measured (never emitted,
 *   never marked missed) when the project has no graph, or the table is absent.
 * - `cooccurring_intents` is Phase 2 (needs captured conversations and per-turn
 *   intents): declared in the catalog, never emitted here.
 */

export function detectDemand(
  clusters: readonly ClusterFact[] | null,
  mix: TurnSourceMix,
  floors: Floors = DEFAULT_FLOORS,
): DetectionResult {
  if (clusters === null || clusters.length === 0) return { signals: [], measured: new Set() };
  const f = floors.fragmented_intents;
  const total = clusters.length;
  const singletons = clusters.filter((c) => c.memberCount <= 1).length;
  const low = wilsonLow(singletons, total);
  if (total < f.minClusters || low < f.minLow) {
    return { signals: [], measured: new Set(["fragmented_intents"]) };
  }
  const interval = wilson(singletons, total);
  const signal: DetectedSignal = {
    kind: "fragmented_intents",
    subjectKind: "project",
    subjectKey: "project",
    subjectIds: [],
    entryKind: "tool",
    lane: "runtime",
    severity: round4(low),
    impact: singletons,
    n: total,
    route: "run_extraction",
    metrics: {
      singletons,
      clusters: total,
      share: round4(singletons / total),
      low: round4(interval?.low ?? 0),
      high: round4(interval?.high ?? 1),
    },
    evidence: { turnIds: [], traceEventIds: [], totalTurns: 0, turnSourceMix: mix },
  };
  return { signals: [signal], measured: new Set(["fragmented_intents"]) };
}
