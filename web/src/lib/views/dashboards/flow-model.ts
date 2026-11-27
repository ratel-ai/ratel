import type { FlowEdge } from "@/lib/synthesis/metrics/flow";
import { CHART_SLOTS } from "@/lib/views/dashboards/chart-model";

/** What the flow widget draws: one column per step, a node once in each column it is in. Pure. */

export interface FlowModelNode {
  id: string;
  name: string;
  /** Its column, from 1. */
  step: number;
  /** The color slot of its name, from 0; null past the last one. */
  slot: number | null;
}

export interface FlowModelLink {
  source: string;
  target: string;
  value: number;
  edge: FlowEdge;
}

export interface FlowModel {
  nodes: FlowModelNode[];
  links: FlowModelLink[];
  columns: number;
}

export function flowModel(edges: readonly FlowEdge[]): FlowModel {
  const nodes = new Map<string, FlowModelNode>();
  const traces = new Map<string, number>();
  for (const { source, target, step, count } of edges) {
    for (const [name, at] of [
      [source, step],
      [target, step + 1],
    ] as const) {
      nodes.set(nodeId(name, at), { id: nodeId(name, at), name, step: at, slot: null });
      traces.set(name, (traces.get(name) ?? 0) + count);
    }
  }
  // The color follows the entity: one slot per name in every column.
  const ranked = [...traces].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const slots = new Map(ranked.slice(0, CHART_SLOTS).map(([name], slot) => [name, slot]));
  return {
    nodes: [...nodes.values()].map((node) => ({ ...node, slot: slots.get(node.name) ?? null })),
    links: edges.map((edge) => ({
      source: nodeId(edge.source, edge.step),
      target: nodeId(edge.target, edge.step + 1),
      value: edge.count,
      edge,
    })),
    columns: Math.max(0, ...[...nodes.values()].map(({ step }) => step)),
  };
}

function nodeId(name: string, step: number): string {
  return `${step}:${name}`;
}
