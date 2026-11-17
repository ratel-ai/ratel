import type { IntentGraphDocument, IntentGraphIntent } from "@/lib/readings/intent-types/wire";

/**
 * Keeping a Cloud-built graph inside the store's caps (RC-659).
 *
 * The caps (`MAX_INTENT_GRAPH_CLUSTERS`, `MAX_INTENT_GRAPH_BYTES`) keep one
 * graph document, and the cluster and edge rows projected from it, small
 * enough to rewrite on every fold. Nothing upstream bounds the count: the
 * SDK's learner evicts a cluster only after about two years without an
 * observation, and Cloud forgets one only after `RUNTIME_EVENT_RETENTION_DAYS`.
 * A busy project whose asks name different records each time ("8 hours for
 * Rossi at site A") seeds a lexical cluster per ask and reaches the cap in days.
 *
 * Two steps, in the fold's order:
 * 1. Above [`COMPACT_PRESSURE_CLUSTERS`] the graph is compacted under pressure
 *    (`./compact.ts`): fragments that agree on their edges and share wording
 *    merge whether or not they have settled or matured. This is what shrinks
 *    such a graph, since its clusters mostly say the same thing.
 * 2. [`trimIntentGraph`] then cuts whatever is still over a cap, keeping the
 *    strongest clusters. A safety net: a graph compaction cannot shrink keeps
 *    learning instead of failing the job on every run.
 */

/**
 * Clusters above which a graph is compacted under pressure: half the store's
 * cluster cap, so a growing graph is merged well before it is trimmed, and a
 * graph below it keeps the settle-first compaction that ranks best.
 */
export const COMPACT_PRESSURE_CLUSTERS = 2_500;

export interface IntentGraphCaps {
  maxClusters: number;
  maxBytes: number;
}

export interface TrimResult {
  /** The same object when nothing was cut. */
  graph: IntentGraphDocument;
  dropped: number;
}

/**
 * Which cluster stays when one has to go: more confirmed observations first
 * (support is what the ranker weighs a cluster by), then the most recently
 * observed, then the learner's id so the cut is deterministic.
 */
function keepOrder(a: IntentGraphIntent, b: IntentGraphIntent): number {
  return (
    b.support - a.support ||
    (b.last_ts ?? 0) - (a.last_ts ?? 0) ||
    a.id.localeCompare(b.id, "en", { numeric: true })
  );
}

/**
 * The graph cut to `caps`: the strongest clusters (see `keepOrder`) that fit
 * both the cluster count and the serialized byte size, in their original
 * order. Sizes are measured as `JSON.stringify` writes the document, which is
 * how the fold stores it. A graph already inside both caps is returned as is.
 */
export function trimIntentGraph(graph: IntentGraphDocument, caps: IntentGraphCaps): TrimResult {
  const intents = graph.intents;
  const overhead = Buffer.byteLength(JSON.stringify({ ...graph, intents: [] }), "utf8");
  const sizes = intents.map((intent) => Buffer.byteLength(JSON.stringify(intent), "utf8"));
  const total =
    overhead + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, intents.length - 1);
  if (intents.length <= caps.maxClusters && total <= caps.maxBytes) return { graph, dropped: 0 };

  const ranked = intents
    .map((_, index) => index)
    .sort((a, b) => keepOrder(intents[a]!, intents[b]!));
  const kept = new Set<number>();
  let bytes = overhead;
  for (const index of ranked) {
    if (kept.size >= caps.maxClusters) break;
    // One comma between array elements.
    const cost = sizes[index]! + (kept.size > 0 ? 1 : 0);
    if (bytes + cost > caps.maxBytes) break;
    kept.add(index);
    bytes += cost;
  }
  const trimmed = intents.filter((_, index) => kept.has(index));
  return { graph: { ...graph, intents: trimmed }, dropped: intents.length - trimmed.length };
}
