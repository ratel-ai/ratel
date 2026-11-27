import type { FlowQuery } from "@/lib/contracts/query";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import type { MetricsDb } from "@/lib/synthesis/metrics/query";
import {
  loadTraceSteps,
  type SteppedTrace,
  TRACE_CAP,
  type TraceSample,
  type TraceStep,
} from "@/lib/synthesis/metrics/steps";

export interface FlowEdge {
  source: string;
  target: string;
  /** The source's place on the path, from 1. The target is at the next one. */
  step: number;
  /** Traces that made this move at this step. */
  count: number;
}

export interface FlowResult {
  kind: "flow";
  /** The most traces first, then by step. */
  edges: FlowEdge[];
  /** Edges left out by the edge limit. */
  moreEdges: number;
  sample: TraceSample;
}

/** How traces move between tools, skills or agents, over the newest traces up to the cap. */
export async function runFlow(
  projectId: string,
  query: FlowQuery,
  scope: QueryScope,
  db: MetricsDb,
  cap = TRACE_CAP,
): Promise<FlowResult> {
  const { sample, traces } = await loadTraceSteps(
    projectId,
    query.filters,
    scope,
    [query.node],
    db,
    cap,
  );
  return { kind: "flow", ...flowEdges(traces, query), sample };
}

/** Pure: the moves of every trace's path, counted by step. */
export function flowEdges(
  traces: readonly Pick<SteppedTrace, "steps">[],
  query: Pick<FlowQuery, "node" | "start" | "end" | "steps" | "edges">,
): Pick<FlowResult, "edges" | "moreEdges"> {
  const counts = new Map<string, FlowEdge>();
  for (const trace of traces) {
    const path = flowPath(trace.steps, query);
    for (const [index, target] of path.slice(1).entries()) {
      const edge = { source: path[index], target, step: index + 1 };
      const key = JSON.stringify(edge);
      const counted = counts.get(key);
      if (counted) counted.count += 1;
      else counts.set(key, { ...edge, count: 1 });
    }
  }
  const edges = [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.step - b.step ||
      compare(a.source, b.source) ||
      compare(a.target, b.target),
  );
  return {
    edges: edges.slice(0, query.edges),
    moreEdges: Math.max(0, edges.length - query.edges),
  };
}

/** The nodes a trace went through. Empty for a trace without the start or the end. */
function flowPath(
  steps: readonly TraceStep[],
  { node, start, end, steps: limit }: Pick<FlowQuery, "node" | "start" | "end" | "steps">,
): string[] {
  let path = steps.filter(({ kind }) => kind === node).map(({ name }) => name);
  // Every span of an agent or a skill names it: staying there is no move. A second call is one.
  if (node !== "tool") path = path.filter((name, index) => name !== path[index - 1]);
  if (start !== undefined) path = from(path, path.indexOf(start));
  path = path.slice(0, limit);
  if (end === undefined) return path;
  const last = path.indexOf(end, start === undefined ? 0 : 1);
  return path.slice(0, last + 1);
}

function from(path: string[], index: number): string[] {
  return index < 0 ? [] : path.slice(index);
}

/** The order of the bytes, so it does not move with a locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
