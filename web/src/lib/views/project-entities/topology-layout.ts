import { agentTree } from "./agents-model";
import type { Topology, TopologyEdge, TopologyNode } from "./topology";

/**
 * The topology map's layout, left to right: a column per handoff depth, the
 * MCP servers in the last column. The nodes keep the graph's order, so the
 * same graph always draws the same map. An edge that skips a column passes
 * between its boxes, and an edge that goes back or stays in its column leaves
 * by the side it ends on.
 */

export interface PlacedNode extends TopologyNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge extends TopologyEdge {
  fromName: string;
  toName: string;
  /** SVG path data. */
  path: string;
  /** Stroke width in px. */
  width: number;
  label: Point;
}

export interface TopologyLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** One cubic between two points, its controls at the middle x. */
interface Segment {
  from: Point;
  to: Point;
}

export const TOPOLOGY_BOX = { width: 168, height: 44, rowGap: 28, columnGap: 104 } as const;
const PADDING = 28;
const MIN_STROKE = 1;
const MAX_STROKE = 5;
/** How far an edge within one column swings out. */
const BULGE = 36;
/** How far the edges of one box or one lane spread from its middle. */
const SPREAD = 12;
const LABEL = { width: 34, height: 13 } as const;
const LABEL_STOPS = [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85];

export function topologyLayout(graph: Topology): TopologyLayout {
  const columns = columnsOf(graph);
  if (columns.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
  const { width: boxWidth, height: boxHeight, rowGap, columnGap } = TOPOLOGY_BOX;
  const tallest = Math.max(...columns.map(stackHeight));
  const height = tallest + PADDING * 2;
  const nodes = columns.flatMap((column, index) =>
    column.map((node, row): PlacedNode => {
      const top = (height - stackHeight(column)) / 2;
      return {
        ...node,
        x: PADDING + index * (boxWidth + columnGap),
        y: top + row * (boxHeight + rowGap),
        width: boxWidth,
        height: boxHeight,
      };
    }),
  );
  return {
    nodes,
    edges: placeEdges(graph.edges, nodes),
    width: PADDING * 2 + columns.length * boxWidth + (columns.length - 1) * columnGap,
    height,
  };
}

// — Helpers ——————————————————————————————————————————————————————————————————

/** The project and the agents by handoff depth (a handoff that closes a loop does not nest), then the servers. */
function columnsOf(graph: Topology): TopologyNode[][] {
  const agents = graph.nodes.filter((node) => node.kind === "agent");
  const handoffs = graph.edges.filter((edge) => edge.kind === "handoff");
  const tree = agentTree(
    agents.map((node) => ({
      key: node.id,
      displayName: node.name,
      calls: node.count,
      errors: 0,
      errorRate: node.errorRate,
      costUsd: 0,
      p95Ms: 0,
      lastSeenAt: "",
    })),
    handoffs.map((edge) => ({ ...edge, fromName: edge.from, toName: edge.to })),
  );
  const byId = new Map(agents.map((node) => [node.id, node]));
  const columns: TopologyNode[][] = [];
  for (const row of tree) {
    const node = byId.get(row.agent.key);
    if (node) columns[row.depth] = [...(columns[row.depth] ?? []), node];
  }
  const project = graph.nodes.filter((node) => node.kind === "project");
  if (project.length > 0) columns[0] = [...(columns[0] ?? []), ...project];
  const servers = graph.nodes.filter((node) => node.kind === "mcp");
  return servers.length > 0 ? [...columns, servers] : columns;
}

function stackHeight(column: readonly unknown[]): number {
  return column.length * TOPOLOGY_BOX.height + Math.max(0, column.length - 1) * TOPOLOGY_BOX.rowGap;
}

function placeEdges(edges: readonly TopologyEdge[], nodes: readonly PlacedNode[]): PlacedEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const max = Math.max(1, ...edges.map((edge) => edge.count));
  const drawn = edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from && to && from !== to ? [{ edge, from, to }] : [];
  });
  // Both ends of every edge, so what leaves a side and what arrives at it never meet.
  const offsets = ports(
    drawn.flatMap(({ edge, from, to }) => {
      // An edge that goes back runs under the boxes, so it meets both of them lowest.
      const back = to.x < from.x;
      return [
        [edge.from, side(from, to), back ? Number.POSITIVE_INFINITY : to.y] as const,
        [edge.to, side(to, from), back ? Number.POSITIVE_INFINITY : from.y] as const,
      ];
    }),
  );
  const labels: Point[] = [];
  return drawn.map(({ edge, from, to }, index) => {
    const start = { x: edgeX(from, to), y: middle(from) + offsets[index * 2] };
    const end = { x: edgeX(to, from), y: middle(to) + offsets[index * 2 + 1] };
    const sameColumn = from.x === to.x;
    const points = sameColumn ? [start, end] : route(start, end, from, to, nodes, index);
    const segments = points.slice(1).map((point, at) => ({ from: points[at], to: point }));
    const label = sameColumn
      ? { x: start.x + BULGE, y: (start.y + end.y) / 2 }
      : labelPoint(segments, nodes, labels);
    labels.push(label);
    return {
      ...edge,
      fromName: from.name,
      toName: to.name,
      path: sameColumn
        ? `M${point(start)} C${point({ x: start.x + BULGE * 1.4, y: start.y })} ${point({ x: end.x + BULGE * 1.4, y: end.y })} ${point(end)}`
        : pathOf(segments),
      width: round(MIN_STROKE + (MAX_STROKE - MIN_STROKE) * (edge.count / max)),
      label: { x: round(label.x), y: round(label.y) },
    };
  });
}

function middle(node: PlacedNode): number {
  return node.y + node.height / 2;
}

/** The side of `node` that faces `other`; the right side within one column. */
function side(node: PlacedNode, other: PlacedNode): "left" | "right" {
  return other.x < node.x ? "left" : "right";
}

function edgeX(node: PlacedNode, other: PlacedNode): number {
  return side(node, other) === "left" ? node.x : node.x + node.width;
}

/** Where each edge meets its box, as an offset from the middle, ordered by the other end. */
function ports(ends: readonly (readonly [id: string, side: string, otherY: number])[]): number[] {
  const groups = new Map<string, number[]>();
  ends.forEach(([id, at], index) => {
    groups.set(`${id}|${at}`, [...(groups.get(`${id}|${at}`) ?? []), index]);
  });
  const offsets = new Array<number>(ends.length).fill(0);
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => compare(ends[a][2], ends[b][2]) || a - b);
    ordered.forEach((index, at) => {
      offsets[index] = spread(at, ordered.length);
    });
  }
  return offsets;
}

/** Infinity minus itself is no order. */
function compare(a: number, b: number): number {
  return a === b ? 0 : a - b;
}

function spread(index: number, count: number): number {
  if (count < 2) return 0;
  const step = Math.min(8, (SPREAD * 2) / (count - 1));
  return (index - (count - 1) / 2) * step;
}

/** The points an edge passes: through each column between its ends, in the gap nearest its straight line. */
function route(
  start: Point,
  end: Point,
  from: PlacedNode,
  to: PlacedNode,
  nodes: readonly PlacedNode[],
  index: number,
): Point[] {
  const forward = to.x > from.x;
  const between = [...new Set(nodes.map((node) => node.x))]
    .filter((x) => x > Math.min(from.x, to.x) && x < Math.max(from.x, to.x))
    .sort((a, b) => (forward ? a - b : b - a));
  const points = [start];
  for (const x of between) {
    const column = nodes.filter((node) => node.x === x);
    const at = (x - start.x) / (end.x - start.x);
    // An edge that goes back runs under the column, apart from the work that goes forward.
    const y = forward
      ? nearestLane(start.y + (end.y - start.y) * at, column)
      : Math.max(...column.map((node) => node.y + node.height)) + TOPOLOGY_BOX.rowGap / 2;
    // Edges that share a lane run beside each other.
    const lane = y + ((index % 5) - 2) * 4;
    const [near, far] = forward ? [x, x + TOPOLOGY_BOX.width] : [x + TOPOLOGY_BOX.width, x];
    points.push({ x: near, y: lane }, { x: far, y: lane });
  }
  return [...points, end];
}

/** The y nearest `wanted` that no box of the column covers. */
function nearestLane(wanted: number, column: readonly PlacedNode[]): number {
  const half = TOPOLOGY_BOX.rowGap / 2;
  const lanes = column.flatMap((node) => [node.y - half, node.y + node.height + half]);
  const first = Math.min(...lanes);
  const last = Math.max(...lanes);
  if (wanted <= first || wanted >= last) return wanted;
  return lanes.reduce((best, lane) =>
    Math.abs(lane - wanted) < Math.abs(best - wanted) ? lane : best,
  );
}

/** A point of the edge, in the open, where no box and no earlier label is; else the middle of its widest part. */
function labelPoint(
  segments: readonly Segment[],
  nodes: readonly PlacedNode[],
  taken: readonly Point[],
): Point {
  // The gaps between the columns first, then the straight runs through them.
  const gaps = segments.filter((_, at) => at % 2 === 0);
  const runs = segments.filter((_, at) => at % 2 === 1);
  const candidates = [...gaps, ...runs].flatMap((segment) =>
    LABEL_STOPS.map((at) => pointAt(segment, at)),
  );
  const free = candidates.find(
    (point) =>
      !taken.some(
        (other) =>
          Math.abs(other.x - point.x) < LABEL.width && Math.abs(other.y - point.y) < LABEL.height,
      ) &&
      !nodes.some(
        (node) =>
          point.x > node.x - LABEL.width / 2 &&
          point.x < node.x + node.width + LABEL.width / 2 &&
          point.y > node.y - LABEL.height &&
          point.y < node.y + node.height + LABEL.height,
      ),
  );
  return free ?? candidates[0];
}

function pointAt({ from, to }: Segment, t: number): Point {
  const mid = (from.x + to.x) / 2;
  const u = 1 - t;
  return {
    x: u ** 3 * from.x + 3 * u * t * mid + t ** 3 * to.x,
    y: (u ** 3 + 3 * u * u * t) * from.y + (3 * u * t * t + t ** 3) * to.y,
  };
}

function pathOf(segments: readonly Segment[]): string {
  return segments.reduce(
    (path, { from, to }) => {
      const mid = (from.x + to.x) / 2;
      return `${path} C${point({ x: mid, y: from.y })} ${point({ x: mid, y: to.y })} ${point(to)}`;
    },
    `M${point(segments[0].from)}`,
  );
}

function point({ x, y }: Point): string {
  return `${round(x)},${round(y)}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
