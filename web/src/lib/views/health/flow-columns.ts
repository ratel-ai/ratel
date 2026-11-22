import type { FlowEdgeKind, FlowNodeKind, FlowTint } from "@/lib/readings/trace-signals/view";
import {
  compareText,
  FLOW_QUIET_ID,
  FLOW_SEARCH_ID,
  KIND_RANK,
  type PreparedEdge,
  type PreparedGraph,
  type PreparedNode,
} from "@/lib/views/health/flow-prepare";

/**
 * Step 2 of the tool flow map's layout (`flow-layout.ts`): which column each
 * tool is a row of, the order of the rows, which rows fold behind a "+N more"
 * row, and which ribbons are drawn at rest.
 *
 * Four columns, left to right: Search, Picked (every tool a search led to, or
 * that something ran after), Then (every tool that ran after another), and
 * Unreached (tools with no path at all). A tool that was both picked and ran
 * after another is a row in Picked and in Then; hovering either lights both.
 * Every `a then b` ribbon therefore runs from Picked to Then, one column over,
 * and never crosses a column in between or loops back.
 */

/** Rows a column shows before it folds the rest behind a "+N more" row. */
export const FLOW_VISIBLE_ROWS = 12;
/** Of those, at most this many are held for magnet and buried tools the busy ones would push out. */
const FLAGGED_ROWS = FLOW_VISIBLE_ROWS / 2;
/** A column folds only when that hides more than this many rows. */
const FOLD_SLACK = 2;
/** "Ran next" ribbons drawn at rest: the busiest ones, down to a share of the busiest. */
const MAJOR_SEQUENCES = 10;
const MAJOR_SHARE = 0.05;

export type FlowColumnRole = "search" | "picked" | "then" | "unreached";
export type FlowRowKind = FlowNodeKind | "more";

export const FLOW_MORE_PREFIX = "more@";

export interface ColumnRow {
  /** Unique within a layout: the tool id in Picked and Unreached, `id@then` in Then, `more@role` for a fold. */
  key: string;
  /** The model's id; the same for a tool's two rows. `more@role` for a fold. */
  id: string;
  kind: FlowRowKind;
  role: FlowColumnRole;
  label: string;
  tint: FlowTint;
  signalIds: readonly string[];
  invocations: number;
  impressions: number;
  quietCount: number | null;
  /** For a fold: how many rows it holds, or 0 on the "Show fewer" row of an unfolded column. */
  moreCount: number | null;
  /** The turns through this row as drawn; orders the column. */
  weight: number;
}

export interface RowEdge {
  key: string;
  /** Row keys. */
  from: string;
  to: string;
  /** Model ids of the two ends. */
  fromId: string;
  toId: string;
  kind: FlowEdgeKind;
  count: number;
  confidence: number;
  tint: FlowTint;
  signalIds: readonly string[];
  /** A quiet path, drawn only while one of its tools is in focus. */
  minor: boolean;
}

export interface ColumnSet {
  role: FlowColumnRole;
  rows: ColumnRow[];
  /** Rows folded behind this column's "+N more" row. */
  hidden: number;
}

export interface Columns {
  columns: ColumnSet[];
  edges: RowEdge[];
  /** True when some column is long enough to fold, whether or not it is folded now. */
  foldable: boolean;
}

const TITLE_ROLE_ORDER: readonly FlowColumnRole[] = ["search", "picked", "then", "unreached"];

function thenKey(id: string): string {
  return `${id}@then`;
}

function moreKey(role: FlowColumnRole): string {
  return `${FLOW_MORE_PREFIX}${role}`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function totals(
  edges: readonly PreparedEdge[],
  kind: FlowEdgeKind,
  end: "from" | "to",
): Map<string, number> {
  const out = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind === kind) out.set(edge[end], (out.get(edge[end]) ?? 0) + edge.count);
  }
  return out;
}

function toRow(node: PreparedNode, role: FlowColumnRole, weight: number): ColumnRow {
  return {
    key: role === "then" ? thenKey(node.id) : node.id,
    id: node.id,
    kind: node.kind,
    role,
    label: node.label,
    tint: node.tint,
    signalIds: node.signalIds,
    invocations: node.invocations,
    impressions: node.impressions,
    quietCount: node.quietCount,
    moreCount: null,
    weight,
  };
}

/** Heaviest first, then busiest, then by id; the quiet plate always last. */
function compareRows(a: ColumnRow, b: ColumnRow): number {
  const quiet = Number(a.id === FLOW_QUIET_ID) - Number(b.id === FLOW_QUIET_ID);
  return (
    quiet ||
    b.weight - a.weight ||
    b.invocations - a.invocations ||
    b.impressions - a.impressions ||
    compareText(a.id, b.id)
  );
}

function moreRow(role: FlowColumnRole, hidden: readonly ColumnRow[]): ColumnRow {
  const count = hidden.length;
  return {
    key: moreKey(role),
    id: moreKey(role),
    kind: "more",
    role,
    label: count > 0 ? `${count} more ${count === 1 ? "tool" : "tools"}` : "Show fewer",
    tint: "none",
    signalIds: [],
    invocations: sum(hidden.map((row) => row.invocations)),
    impressions: sum(hidden.map((row) => row.impressions)),
    quietCount: null,
    moreCount: count,
    weight: sum(hidden.map((row) => row.weight)),
  };
}

/** Magnet and buried tools stay in sight even when busier tools fill the column. */
function isFlagged(row: ColumnRow): boolean {
  return row.tint === "magnet" || row.tint === "buried";
}

type Arrange = (rows: readonly ColumnRow[]) => ColumnRow[];

/**
 * The rows a column shows, in order, and the ones its fold row holds. Folds
 * only when it would hide more than {@link FOLD_SLACK} rows; unfolded, a long
 * column ends on a "Show fewer" row instead. Which rows show is always by
 * weight; `arrange` may then order the ones that show.
 */
function foldColumn(
  role: FlowColumnRole,
  all: readonly ColumnRow[],
  expanded: boolean,
  arrange: Arrange = (rows) => [...rows],
): { rows: ColumnRow[]; hidden: ColumnRow[]; foldable: boolean } {
  const sorted = [...all].sort(compareRows);
  const quiet = sorted.filter((row) => row.id === FLOW_QUIET_ID);
  const tools = sorted.filter((row) => row.id !== FLOW_QUIET_ID);
  const foldable = tools.length > FLOW_VISIBLE_ROWS + FOLD_SLACK;
  if (!foldable) return { rows: [...arrange(tools), ...quiet], hidden: [], foldable };
  if (expanded)
    return { rows: [...arrange(tools), ...quiet, moreRow(role, [])], hidden: [], foldable };
  const keep = new Set(
    tools
      .filter(isFlagged)
      .slice(0, FLAGGED_ROWS)
      .map((row) => row.key),
  );
  for (const row of tools) {
    if (keep.size >= FLOW_VISIBLE_ROWS) break;
    keep.add(row.key);
  }
  const hidden = tools.filter((row) => !keep.has(row.key));
  return {
    rows: [...arrange(tools.filter((row) => keep.has(row.key))), moreRow(role, hidden), ...quiet],
    hidden,
    foldable,
  };
}

/**
 * Orders Then by where its ribbons come from: each row at the turn-weighted
 * mean position of the sources of its ribbons drawn at rest, the heavier row
 * first on a tie; rows reached only by quiet paths go last. That is what
 * keeps thick "ran next" ribbons flat and out of an X.
 */
function bySources(
  edges: readonly PreparedEdge[],
  minor: ReadonlySet<string>,
  position: ReadonlyMap<string, number>,
): Arrange {
  return (rows) => {
    const centre = new Map<string, number>();
    for (const row of rows) {
      const from = edges.filter(
        (edge) => edge.kind === "sequence" && edge.to === row.id && !minor.has(minorKey(edge)),
      );
      const total = sum(from.map((edge) => edge.count));
      const weighted = sum(
        from.map((edge) => edge.count * (position.get(edge.from) ?? position.size)),
      );
      centre.set(row.key, total > 0 ? weighted / total : Number.POSITIVE_INFINITY);
    }
    return [...rows].sort((a, b) => {
      const ca = centre.get(a.key)!;
      const cb = centre.get(b.key)!;
      return (ca === cb ? 0 : ca < cb ? -1 : 1) || compareRows(a, b);
    });
  };
}

function minorKey(edge: Pick<PreparedEdge, "kind" | "from" | "to">): string {
  return `${edge.kind}:${edge.from}>${edge.to}`;
}

/** Which "ran next" ribbons and sibling brackets are quiet: drawn only in focus. */
function minorKeys(edges: readonly PreparedEdge[]): Set<string> {
  const sequences = edges
    .filter((edge) => edge.kind === "sequence")
    .sort((a, b) => b.count - a.count || compareText(a.from, b.from) || compareText(a.to, b.to));
  const busiest = sequences[0]?.count ?? 0;
  const minor = new Set<string>();
  sequences.forEach((edge, rank) => {
    const major =
      edge.signalIds.length > 0 || (rank < MAJOR_SEQUENCES && edge.count >= MAJOR_SHARE * busiest);
    if (!major) minor.add(minorKey(edge));
  });
  // Sibling brackets are drawn only in focus: the pair's plates already carry
  // the buried tint, and a stack of brackets at rest reads as noise.
  for (const edge of edges) {
    if (edge.kind === "sibling") minor.add(minorKey(edge));
  }
  return minor;
}

function edgeKey(kind: FlowEdgeKind, from: string, to: string): string {
  return kind === "sibling" ? `${from}~${to}` : `${from}>${to}`;
}

/** Points each model edge at its rows, re-points folded rows at their fold, and merges. */
function rowEdges(
  edges: readonly PreparedEdge[],
  minor: ReadonlySet<string>,
  display: ReadonlyMap<string, string>,
  idOf: ReadonlyMap<string, string>,
): RowEdge[] {
  const merged = new Map<string, RowEdge & { weighted: number }>();
  const sorted = [...edges].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      compareText(a.from, b.from) ||
      compareText(a.to, b.to),
  );
  for (const edge of sorted) {
    const fromRow = edge.kind === "pick" ? FLOW_SEARCH_ID : edge.from;
    const toRow = edge.kind === "sequence" ? thenKey(edge.to) : edge.to;
    const from = display.get(fromRow);
    const to = display.get(toRow);
    if (!from || !to) continue;
    // A sibling pair with a folded tool no longer names two rows.
    if (edge.kind === "sibling" && (from !== fromRow || to !== toRow)) continue;
    const key = edgeKey(edge.kind, from, to);
    const isMinor = minor.has(minorKey(edge));
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, {
        key,
        from,
        to,
        fromId: idOf.get(from) ?? from,
        toId: idOf.get(to) ?? to,
        kind: edge.kind,
        count: edge.count,
        confidence: edge.confidence,
        tint: edge.tint,
        signalIds: edge.signalIds,
        minor: isMinor,
        weighted: edge.confidence * edge.count,
      });
      continue;
    }
    const count = seen.count + edge.count;
    const weighted = seen.weighted + edge.confidence * edge.count;
    merged.set(key, {
      ...seen,
      count,
      weighted,
      confidence: weighted / count,
      tint: seen.tint === edge.tint ? seen.tint : "none",
      signalIds: [...new Set([...seen.signalIds, ...edge.signalIds])],
      minor: seen.minor && isMinor,
    });
  }
  return [...merged.values()].map(({ weighted: _weighted, ...edge }) => edge);
}

/** Step 2: the columns, their rows in order, and the ribbons between rows. */
export function buildColumns(graph: PreparedGraph, expanded: boolean): Columns {
  const { nodes, edges } = graph;
  const picks = totals(edges, "pick", "to");
  const out = totals(edges, "sequence", "from");
  const into = totals(edges, "sequence", "to");
  const paired = new Set(
    edges.filter((edge) => edge.kind === "sibling").flatMap((edge) => [edge.from, edge.to]),
  );

  const rowsOf: Record<FlowColumnRole, ColumnRow[]> = {
    search: [],
    picked: [],
    then: [],
    unreached: [],
  };
  for (const node of nodes) {
    if (node.kind === "search") {
      rowsOf.search.push(toRow(node, "search", sum([...picks.values()])));
      continue;
    }
    const pickIn = picks.get(node.id) ?? 0;
    const seqOut = out.get(node.id) ?? 0;
    const seqIn = into.get(node.id) ?? 0;
    const picked = pickIn > 0 || seqOut > 0 || paired.has(node.id);
    if (picked) rowsOf.picked.push(toRow(node, "picked", Math.max(pickIn, seqOut)));
    if (seqIn > 0) rowsOf.then.push(toRow(node, "then", seqIn));
    if (!picked && seqIn === 0) rowsOf.unreached.push(toRow(node, "unreached", node.invocations));
  }

  let foldable = false;
  const display = new Map<string, string>();
  const idOf = new Map<string, string>();
  const columns: ColumnSet[] = [];
  const minor = minorKeys(edges);
  // A tool's place in Picked as drawn; a folded tool sits where its fold row does.
  const position = new Map<string, number>();
  for (const role of TITLE_ROLE_ORDER) {
    const all = rowsOf[role];
    if (all.length === 0) continue;
    const folded =
      role === "search"
        ? { rows: all, hidden: [], foldable: false }
        : foldColumn(
            role,
            all,
            expanded,
            role === "then" ? bySources(edges, minor, position) : undefined,
          );
    if (role === "picked") {
      folded.rows.forEach((row, i) => position.set(row.id, i));
      const fold = folded.rows.findIndex((row) => row.kind === "more");
      for (const row of folded.hidden) position.set(row.id, fold);
    }
    foldable ||= folded.foldable;
    for (const row of folded.rows) {
      display.set(row.key, row.key);
      idOf.set(row.key, row.id);
    }
    for (const row of folded.hidden) display.set(row.key, moreKey(role));
    columns.push({ role, rows: folded.rows, hidden: folded.hidden.length });
  }
  return { columns, edges: rowEdges(edges, minor, display, idOf), foldable };
}
