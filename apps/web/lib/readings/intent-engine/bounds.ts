import type {
  CapabilityEdges,
  EngineCluster,
  SourceSlice,
} from "@/lib/readings/intent-types/engine-types";

/**
 * Size bounds on what one cluster row carries. Its edge and usage maps are
 * keyed by ids the client sends (tool, skill and source ids), so without a cap
 * one API key could grow a busy cluster by megabytes per batch, and every run
 * loads, clones and rewrites it. Members are capped where they are added
 * (`MEMBER_CAP`); these cap the rest when a cluster is written, keeping the
 * biggest counts.
 */

/** Keys kept per count map (`usage`, `tools`, `skills`, `surfaced_*`), biggest first. */
export const MAX_EDGE_KEYS = 100;
/** Runtime sources kept per cluster, the most supported first. */
export const MAX_SOURCES = 10;
/** Longer tool or skill ids are not credited: no real id is this long. */
export const MAX_ID_CHARS = 200;

/** The `max` biggest counts of a map, ties by key; the map itself when it fits. */
export function capCounts(
  record: Readonly<Record<string, number>>,
  max: number = MAX_EDGE_KEYS,
): Record<string, number> {
  const entries = Object.entries(record);
  if (entries.length <= max) return { ...record };
  return Object.fromEntries(
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max),
  );
}

function capEdges<T extends CapabilityEdges>(edges: T): T {
  const out: T = { ...edges, tools: capCounts(edges.tools), skills: capCounts(edges.skills) };
  if (edges.surfaced_tools) out.surfaced_tools = capCounts(edges.surfaced_tools);
  if (edges.surfaced_skills) out.surfaced_skills = capCounts(edges.surfaced_skills);
  return out;
}

/** A copy of the cluster within the bounds above. */
export function boundCluster(cluster: EngineCluster): EngineCluster {
  const sources = Object.entries(cluster.sources);
  const kept: Record<string, SourceSlice> = {};
  for (const [id, slice] of sources
    .sort((a, b) => b[1].support - a[1].support || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_SOURCES)) {
    kept[id] = capEdges(slice);
  }
  return { ...capEdges(cluster), usage: capCounts(cluster.usage), sources: kept };
}
