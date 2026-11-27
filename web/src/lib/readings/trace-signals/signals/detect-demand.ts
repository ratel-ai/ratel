import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import type { ClusterFact, DetectionResult } from "@/lib/readings/trace-signals/signals/types";
import type { TurnSourceMix } from "@/lib/readings/trace-signals/view";

/**
 * Demand signals: what users ask for, read from the stored intent graph rather
 * than from this window's turns.
 *
 * - `fragmented_intents`: most of the graph's clusters are singletons (an ask
 *   seen once). Measured but never emitted: it is the intent engine's learning
 *   state, not a problem with the customer's agent. Measuring it still resolves
 *   any card opened before. Not measured when the project has no graph, or the
 *   table is absent.
 * - `cooccurring_intents` is Phase 2 (needs captured conversations and per-turn
 *   intents): declared in the catalog, never emitted here.
 */

export function detectDemand(
  clusters: readonly ClusterFact[] | null,
  _mix: TurnSourceMix,
  _floors: Floors = DEFAULT_FLOORS,
): DetectionResult {
  if (clusters === null || clusters.length === 0) return { signals: [], measured: new Set() };
  return { signals: [], measured: new Set(["fragmented_intents"]) };
}
