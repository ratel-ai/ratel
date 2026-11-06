import type { IntentGraphClusterSummaryRow } from "@/lib/readings/intent-graph/queries";
import type { IntentGraphEdgeRow } from "@/lib/readings/intent-graph/schema";
import type { IntentGraphEdgeKind } from "@/lib/readings/intent-types/wire";

/**
 * The view helpers Adaptive ranking and Fixes read. Pure: no database, no React. Cluster `members`
 * are raw user query text and must never reach logs or attributes. Owned (ADR-0030): cut from
 * upstream's `intent-graph/view.ts`, whose summary cards and force graph have no page here.
 */

/** Confirmed observations at which the ranker gives a cluster full weight (ADR-0014). */
export const SUPPORT_FULL = 3;

/** Arm weight ramp: one observation nudges, three or more carry full weight. */
export function supportRamp(support: number): number {
  if (!Number.isFinite(support) || support <= 0) return 0;
  return Math.min(1, support / SUPPORT_FULL);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The embedding model behind a graph, as a name a person can read.
 *
 * A dense graph records its model as a fingerprint the runtime derives from
 * the embedder, e.g. `hf|repo=22:BAAI/bge-small-en-v1.5|revision=40:<sha>|pool=3:cls`
 * (length-prefixed fields, so the value can contain `|`). The card shows only
 * the repo, which is the name people know the model by; the revision and
 * pooling stay in the stored graph for anyone who needs them. A model string
 * that is not such a fingerprint is shown as is, and no model means lexical.
 */
export function modelLabel(model: string | null): string {
  if (!model) return "lexical";
  const repo = /(?:^|\|)repo=(\d+):/.exec(model);
  if (!repo) return model;
  const start = repo.index + repo[0].length;
  const length = Number(repo[1]);
  const name = model.slice(start, start + length);
  return name.length === length && name.length > 0 ? name : model;
}

export interface TopEdge {
  id: string;
  weight: number;
  missing: boolean;
}

export interface ClusterEdge {
  kind: IntentGraphEdgeKind;
  id: string;
  weight: number;
  missing: boolean;
  /** Times shown at or above the pick without being picked; null when the graph did not record impressions. */
  surfaced: number | null;
  /** The runtime's damping factor on this edge, 0..1; null when unknown. */
  damper: number | null;
}

/** Pseudo-count in the runtime's passed-over damper (the core's IMPRESSION_PRIOR). */
export const IMPRESSION_PRIOR = 3;

/**
 * How much of an edge's weight survives ranking: min(1, (invoked + 3) / (surfaced + 3)).
 * A tool picked every time it was shown keeps 1; one shown ten times and picked
 * twice keeps about 0.4. It can only lower an edge, never raise it or remove it.
 */
export function edgeDamper(weight: number, surfaced: number | null): number | null {
  if (surfaced === null) return null;
  return Math.min(1, (weight + IMPRESSION_PRIOR) / (surfaced + IMPRESSION_PRIOR));
}

export interface ClusterTableRow {
  clusterId: string;
  displayLabel: string;
  hasOverride: boolean;
  memberCount: number;
  support: number;
  supportRamp: number;
  seededSupport: number;
  lastTs: Date | null;
  hasCentroid: boolean;
  toolEdgeCount: number;
  skillEdgeCount: number;
  topTool: TopEdge | null;
  topSkill: TopEdge | null;
  /** Every edge of the cluster, weight descending then id, for the drawer. */
  edges: ClusterEdge[];
  terms: string[];
}

export function missingKey(kind: IntentGraphEdgeKind, capabilityId: string): string {
  return `${kind}:${capabilityId}`;
}

function edgesByCluster(edges: readonly IntentGraphEdgeRow[]): Map<string, IntentGraphEdgeRow[]> {
  const map = new Map<string, IntentGraphEdgeRow[]>();
  for (const edge of edges) {
    const list = map.get(edge.clusterId);
    if (list) list.push(edge);
    else map.set(edge.clusterId, [edge]);
  }
  return map;
}

function topEdge(
  edges: readonly IntentGraphEdgeRow[],
  kind: IntentGraphEdgeKind,
  missing: ReadonlySet<string>,
): TopEdge | null {
  let best: IntentGraphEdgeRow | null = null;
  for (const edge of edges) {
    if (edge.kind !== kind) continue;
    if (
      best === null ||
      edge.weight > best.weight ||
      (edge.weight === best.weight && edge.capabilityId < best.capabilityId)
    ) {
      best = edge;
    }
  }
  return best
    ? {
        id: best.capabilityId,
        weight: best.weight,
        missing: missing.has(missingKey(kind, best.capabilityId)),
      }
    : null;
}

export function buildClusterTableRows(
  clusters: readonly IntentGraphClusterSummaryRow[],
  edges: readonly IntentGraphEdgeRow[],
  missing: ReadonlySet<string> = new Set(),
): ClusterTableRow[] {
  const byCluster = edgesByCluster(edges);
  const rows = clusters.map((cluster): ClusterTableRow => {
    const own = byCluster.get(cluster.clusterId) ?? [];
    return {
      clusterId: cluster.clusterId,
      displayLabel: cluster.labelOverride ?? cluster.label,
      hasOverride: cluster.labelOverride !== null,
      memberCount: cluster.memberCount,
      support: cluster.support,
      supportRamp: supportRamp(cluster.support),
      seededSupport: cluster.seededSupport,
      lastTs: cluster.lastTs,
      hasCentroid: cluster.hasCentroid,
      toolEdgeCount: own.filter((e) => e.kind === "tool").length,
      skillEdgeCount: own.filter((e) => e.kind === "skill").length,
      topTool: topEdge(own, "tool", missing),
      topSkill: topEdge(own, "skill", missing),
      edges: [...own]
        .sort((a, b) => b.weight - a.weight || (a.capabilityId < b.capabilityId ? -1 : 1))
        .map((e) => ({
          kind: e.kind,
          id: e.capabilityId,
          weight: e.weight,
          missing: missing.has(missingKey(e.kind, e.capabilityId)),
          surfaced: e.surfaced,
          damper: edgeDamper(e.weight, e.surfaced),
        })),
      terms: cluster.terms,
    };
  });
  return rows.sort(
    (a, b) =>
      b.support - a.support ||
      b.memberCount - a.memberCount ||
      (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0),
  );
}

/** Compact relative label ("just now", "3h ago", "12d ago"), pure for tests. */
export function relativeTimeLabel(date: Date | null, now: Date = new Date()): string {
  if (!date) return "never";
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

// --- cloud graph card ----------------------------------------------------------

/**
 * Where a Cloud-built graph stands, from what runtimes report. Watching: Cloud
 * builds it and compares, no runtime ranks from it. Live: a runtime enabled
 * ranking from it in its own code. Boosting: live, and some runtime changed
 * results with it in the last day.
 */
export type CloudGraphState = "watching" | "live" | "boosting";

export function cloudGraphState(input: {
  liveAt: Date | null;
  boosting: boolean;
}): CloudGraphState {
  if (input.liveAt === null) return "watching";
  return input.boosting ? "boosting" : "live";
}
