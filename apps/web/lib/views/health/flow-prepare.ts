import type {
  FlowEdge,
  FlowEdgeKind,
  FlowModel,
  FlowNode,
  FlowNodeKind,
  FlowTint,
} from "@/lib/readings/trace-signals/view";

/**
 * Step 1 of the tool flow map's layout (`flow-layout.ts`): keep the busiest
 * tools as plates, fold the rest into one quiet plate, and re-point, clean and
 * merge the edges onto what is kept. Everything is sorted before it is read, so
 * the result does not depend on the order the model arrives in.
 */

/** Tools and skills drawn as their own plate; the rest fold into the quiet plate. */
export const FLOW_MAX_TOOLS = 40;
export const FLOW_SEARCH_ID = "search";
export const FLOW_QUIET_ID = "quiet";

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export interface PreparedNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  tint: FlowTint;
  signalIds: readonly string[];
  invocations: number;
  impressions: number;
  quietCount: number | null;
}

export interface PreparedEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  count: number;
  confidence: number;
  tint: FlowTint;
  signalIds: readonly string[];
}

export const KIND_RANK: Record<FlowEdgeKind, number> = { pick: 0, sequence: 1, sibling: 2 };

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function weight(node: Pick<FlowNode, "invocations" | "impressions">): number {
  return node.invocations + node.impressions;
}

/** Busiest first, then by id: the one order every tie falls back to. */
export function byWeightThenId(a: PreparedNode, b: PreparedNode): number {
  return weight(b) - weight(a) || compareText(a.id, b.id);
}

export function quietLabel(count: number): string {
  return `and ${count} quiet ${count === 1 ? "tool" : "tools"}`;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function toPrepared(node: FlowNode): PreparedNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    tint: node.tint,
    signalIds: [...node.signalIds],
    invocations: Math.max(0, node.invocations),
    impressions: Math.max(0, node.impressions),
    quietCount: node.kind === "quiet" ? (node.quietCount ?? 0) : null,
  };
}

function buildQuiet(
  model: FlowNode | undefined,
  folded: readonly PreparedNode[],
): PreparedNode | null {
  if (!model && folded.length === 0) return null;
  const base = model ? toPrepared(model) : null;
  const count = (base?.quietCount ?? 0) + folded.length;
  return {
    id: FLOW_QUIET_ID,
    kind: "quiet",
    label: count > 0 ? quietLabel(count) : (base?.label ?? quietLabel(0)),
    tint: base?.tint ?? "none",
    signalIds: unique([...(base?.signalIds ?? []), ...folded.flatMap((node) => node.signalIds)]),
    invocations: (base?.invocations ?? 0) + folded.reduce((sum, node) => sum + node.invocations, 0),
    impressions: (base?.impressions ?? 0) + folded.reduce((sum, node) => sum + node.impressions, 0),
    quietCount: count,
  };
}

function compareEdgesForMerge(a: FlowEdge, b: FlowEdge): number {
  return (
    compareText(a.from, b.from) ||
    compareText(a.to, b.to) ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    a.count - b.count ||
    a.confidence - b.confidence ||
    compareText(a.tint, b.tint)
  );
}

/** Re-points edges at kept plates, drops what cannot be drawn, merges duplicates. */
function prepareEdges(
  edges: readonly FlowEdge[],
  target: ReadonlyMap<string, string>,
): PreparedEdge[] {
  const merged = new Map<string, PreparedEdge & { weighted: number }>();
  for (const edge of [...edges].sort(compareEdgesForMerge)) {
    const from = target.get(edge.from);
    const to = target.get(edge.to);
    if (!from || !to || from === to || edge.count <= 0) continue;
    // A sibling pair folded into the quiet plate no longer names two tools.
    if (edge.kind === "sibling" && (from === FLOW_QUIET_ID || to === FLOW_QUIET_ID)) continue;
    const [a, b] = edge.kind === "sibling" && compareText(to, from) < 0 ? [to, from] : [from, to];
    const key = `${edge.kind}:${a}>${b}`;
    const confidence = clamp01(edge.confidence);
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, {
        from: a,
        to: b,
        kind: edge.kind,
        count: edge.count,
        confidence,
        tint: edge.tint,
        signalIds: [...edge.signalIds],
        weighted: confidence * edge.count,
      });
      continue;
    }
    const count = seen.count + edge.count;
    const weighted = seen.weighted + confidence * edge.count;
    merged.set(key, {
      ...seen,
      count,
      weighted,
      confidence: weighted / count,
      tint: seen.tint === edge.tint ? seen.tint : "none",
      signalIds: unique([...seen.signalIds, ...edge.signalIds]),
    });
  }
  return [...merged.values()].map(({ weighted: _weighted, ...edge }) => edge);
}

export interface PreparedGraph {
  nodes: PreparedNode[];
  edges: PreparedEdge[];
}

/** Step 1: keep the busiest tools, fold the rest into the quiet plate. */
export function prepareFlow(model: FlowModel): PreparedGraph {
  const seen = new Set<string>();
  const nodes = [...model.nodes]
    .sort((a, b) => compareText(a.id, b.id) || weight(b) - weight(a))
    .filter((node) => (seen.has(node.id) ? false : (seen.add(node.id), true)));

  const searchModel = nodes.find((node) => node.kind === "search");
  const quietModel = nodes.find((node) => node.kind === "quiet");
  const tools = nodes
    .filter((node) => node.kind === "tool" || node.kind === "skill")
    .map(toPrepared)
    .sort(byWeightThenId);
  if (tools.length === 0 && !quietModel) return { nodes: [], edges: [] };

  const kept = tools.slice(0, FLOW_MAX_TOOLS);
  const folded = tools.slice(FLOW_MAX_TOOLS);
  const quiet = buildQuiet(quietModel, folded);
  const search: PreparedNode = searchModel
    ? { ...toPrepared(searchModel), id: FLOW_SEARCH_ID }
    : {
        id: FLOW_SEARCH_ID,
        kind: "search",
        label: "Search",
        tint: "none",
        signalIds: [],
        invocations: 0,
        impressions: 0,
        quietCount: null,
      };

  const target = new Map<string, string>();
  target.set(searchModel?.id ?? FLOW_SEARCH_ID, FLOW_SEARCH_ID);
  for (const node of kept) target.set(node.id, node.id);
  if (quietModel) target.set(quietModel.id, FLOW_QUIET_ID);
  for (const node of folded) target.set(node.id, FLOW_QUIET_ID);

  return {
    nodes: [search, ...kept, ...(quiet ? [quiet] : [])],
    edges: prepareEdges(model.edges, target),
  };
}
