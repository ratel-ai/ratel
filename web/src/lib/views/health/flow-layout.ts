import type { FlowEdgeKind, FlowModel, FlowTint } from "@/lib/readings/trace-signals/view";
import {
  buildColumns,
  type ColumnRow,
  type ColumnSet,
  type FlowColumnRole,
  type FlowRowKind,
  type RowEdge,
} from "@/lib/views/health/flow-columns";
import {
  clamp01,
  compareText,
  FLOW_QUIET_ID,
  KIND_RANK,
  prepareFlow,
} from "@/lib/views/health/flow-prepare";
import {
  bracketPath,
  fitPorts,
  PORT_GAP,
  type Point,
  ribbonPath,
  round,
  stackCentred,
  stackHeight,
} from "@/lib/views/health/flow-route";

export {
  FLOW_MORE_PREFIX,
  FLOW_VISIBLE_ROWS,
  type FlowColumnRole,
  type FlowRowKind,
} from "@/lib/views/health/flow-columns";
export {
  FLOW_MAX_TOOLS,
  FLOW_QUIET_ID,
  FLOW_SEARCH_ID,
  prepareFlow,
  quietLabel,
} from "@/lib/views/health/flow-prepare";

/**
 * The tool flow map's layout: a pure, deterministic Sankey-style drawing.
 *
 * Not a force simulation, and nothing is measured in the browser. The
 * adaptive-ranking lesson (#193) is that a graph has to stay put: the same
 * model draws the same picture on every render, on the server and in the
 * browser, in whatever order its nodes and edges arrive.
 *
 * 1. Fold (`flow-prepare.ts`). The busiest 40 tools stay; the rest join the
 *    quiet plate, and their edges are re-pointed at it and merged.
 * 2. Columns (`flow-columns.ts`). Search, Picked, Then, Unreached. Rows are
 *    sorted by the turns through them. A column past 14 rows shows its 12
 *    heaviest (magnet and buried tools always among them) above a "+N more"
 *    row; the unfolded layout, `expanded`, shows all of them. Quiet "ran next"
 *    ribbons are marked minor and drawn only in focus.
 * 3. Place. Columns left to right; spare width goes to the gap the "ran next"
 *    ribbons cross, so they stay long and gentle. Rows stack top down with
 *    room for the ribbons they carry. Labels that do not fit are cut with an
 *    ellipsis; the full name is on hover.
 * 4. Route (`flow-route.ts`). Search is a tall bar; each pick leaves it at its
 *    own port, level with its tool, so picks run straight across. A tool's
 *    "ran next" ribbons leave an outlet bar past the column's labels, stacked
 *    in the order of their targets, and arrive at an inlet bar stacked in the
 *    order of their sources, so no two ribbons from one tool cross. Ribbon
 *    width grows with the square root of its turns.
 *
 * Every coordinate is rounded to a tenth so the output serializes identically.
 */

/** The narrowest coordinate system; wider maps grow past it rather than squeeze. */
export const FLOW_MIN_WIDTH = 1040;
/**
 * The widest drawing the layout aims for: about the map card's inner width at
 * a 1440 px desktop (1,086 px there), so it renders at about 1:1. Past it,
 * labels are cut shorter; the SVG scales whatever is left.
 */
export const FLOW_MAX_WIDTH = 1100;

const G = {
  padX: 16,
  padTop: 44,
  padBottom: 16,
  barWidth: 20,
  /** Search bar reaches this far past its first and last pick. */
  barOverhang: 10,
  rowPitch: 26,
  rowGap: 6,
  labelGap: 8,
  /** Mono label size in layout units; the renderer uses the same number. */
  labelFont: 11.5,
  /** Mono advance is 0.6em, so label widths are known without measuring text. */
  charWidth: 11.5 * 0.6,
  /** From the longest label to the outlet bar, and extra room for sibling brackets. */
  outletGap: 14,
  bracketRoom: 16,
  portBar: 3,
  inletGap: 4,
  minRadius: 6,
  radiusSpan: 7,
  foldRadius: 8,
  quietRadius: 9,
  minRibbon: 1.5,
  maxRibbon: 10,
} as const;

/** Label lengths tried in turn until the drawing fits its width. */
const LABEL_FITS = [30, 24, 20, 16] as const;

interface Gap {
  min: number;
  max: number;
}

/** The gap before each column; "ran next" ribbons take spare width first. */
const GAPS: Record<Exclude<FlowColumnRole, "search">, Gap> = {
  picked: { min: 56, max: 150 },
  then: { min: 120, max: 320 },
  unreached: { min: 44, max: 110 },
};
const SPARE_ORDER: readonly Exclude<FlowColumnRole, "search">[] = ["then", "picked", "unreached"];

export const FLOW_LABEL_FONT = G.labelFont;

const COLUMN_TITLE: Record<FlowColumnRole, string> = {
  search: "Search",
  picked: "Picked",
  then: "Then",
  unreached: "No search led here",
};

export interface FlowLayoutColumn {
  index: number;
  role: FlowColumnRole;
  /** Column heading: "Search", "Picked", "Then", "No search led here". */
  title: string;
  /** Left edge and width of the column, header included. */
  x: number;
  width: number;
  /** Rows folded behind this column's "+N more" row. */
  hidden: number;
}

/** A stack of ribbon ends: an outlet or inlet bar. */
export interface FlowPortBar {
  x: number;
  top: number;
  bottom: number;
  /** Every ribbon on it is minor, so at rest it has nothing to gather. */
  quiet: boolean;
}

export interface FlowLayoutNode {
  /** Unique within a layout: the tool id, `id@then` for its row in Then, `more@role` for a fold. */
  key: string;
  /** The model's id, shared by a tool's rows in Picked and Then. */
  id: string;
  kind: FlowRowKind;
  column: FlowColumnRole;
  /** The full label, for aria and the tooltip. */
  label: string;
  /** The label as drawn, cut with an ellipsis when the column is narrow. */
  text: string;
  tint: FlowTint;
  signalIds: readonly string[];
  invocations: number;
  impressions: number;
  /** For the quiet plate: how many tools it folds. */
  quietCount: number | null;
  /** For a fold row: how many rows it holds; 0 on "Show fewer". */
  moreCount: number | null;
  /** Turns through the row as drawn. */
  weight: number;
  /** Position within the column, top to bottom. */
  order: number;
  x: number;
  y: number;
  r: number;
  /** The search bar's height; 0 for a plate. */
  h: number;
  labelX: number;
  labelEnd: number;
  inlet: FlowPortBar | null;
  outlet: FlowPortBar | null;
}

export interface FlowLayoutEdge {
  /** `from>to` in row keys, `a~b` for sibling pairs; unique within a layout. */
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
  /** A quiet path: drawn only while one of its ends is in focus. */
  minor: boolean;
  /** SVG path data. */
  path: string;
  width: number;
  opacity: number;
  /** Where the ribbon leaves and arrives, for its count label in focus. */
  start: Point;
  end: Point;
  /** Draw-in order: picks, then "ran next", then sibling brackets. */
  step: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  columns: readonly FlowLayoutColumn[];
  nodes: readonly FlowLayoutNode[];
  edges: readonly FlowLayoutEdge[];
  totalTools: number;
  /** Whether this is the unfolded layout. */
  expanded: boolean;
  /** True when some column folds (or, expanded, could fold): the map offers a toggle. */
  foldable: boolean;
}

export interface FlowLayoutOptions {
  /** Unfold every column; the "+N more" rows become "Show fewer". */
  expanded?: boolean;
  /** The widest drawing wanted, in layout units. Defaults to {@link FLOW_MAX_WIDTH}. */
  maxWidth?: number;
}

/* - Sizes ------------------------------------------------------------------- */

function truncate(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

function radiusOf(row: ColumnRow, maxInvocations: number): number {
  if (row.kind === "more") return G.foldRadius;
  if (row.kind === "quiet") return G.quietRadius;
  const share = maxInvocations > 0 ? row.invocations / maxInvocations : 0;
  return round(G.minRadius + G.radiusSpan * Math.sqrt(share));
}

function ribbonWidth(count: number, maxCount: number): number {
  const share = maxCount > 0 ? count / maxCount : 0;
  return round(G.minRibbon + (G.maxRibbon - G.minRibbon) * Math.sqrt(clamp01(share)));
}

function edgeOpacity(edge: RowEdge, aggregate: boolean): number {
  if (edge.kind === "sibling") return 0.75;
  if (aggregate) return 0.16;
  const base = edge.kind === "pick" ? 0.22 : 0.28;
  const tinted = edge.tint === "none" ? 0 : 0.14;
  return Math.round((base + 0.26 * clamp01(edge.confidence) + tinted) * 100) / 100;
}

/* - Horizontal -------------------------------------------------------------- */

interface ColumnX {
  role: FlowColumnRole;
  left: number;
  right: number;
  plateX: number;
  labelX: number;
  labelChars: number;
  /** Picked only: where sibling brackets turn and where outlets stand. */
  spine: number;
  port: number;
}

/** The width a column takes, given how many label characters it may show. */
function columnShape(
  set: ColumnSet,
  radius: ReadonlyMap<string, number>,
  maxChars: number,
  brackets: boolean,
) {
  if (set.role === "search") return { width: G.barWidth, plateR: 0, chars: 0, inlet: 0, tail: 0 };
  const plateR = Math.max(...set.rows.map((row) => radius.get(row.key) ?? G.minRadius));
  const chars = Math.min(maxChars, Math.max(...set.rows.map((row) => row.label.length)));
  const inlet = set.role === "then" ? G.portBar + G.inletGap : 0;
  const tail = set.role === "picked" ? G.outletGap + (brackets ? G.bracketRoom : 0) + G.portBar : 0;
  return {
    width: inlet + 2 * plateR + G.labelGap + chars * G.charWidth + tail,
    plateR,
    chars,
    inlet,
    tail,
  };
}

function placeColumns(
  sets: readonly ColumnSet[],
  radius: ReadonlyMap<string, number>,
  brackets: boolean,
  maxWidth: number,
): { columns: ColumnX[]; width: number } {
  const gapsOf = sets.slice(1).map((set) => GAPS[set.role as Exclude<FlowColumnRole, "search">]);
  let shapes = sets.map((set) => columnShape(set, radius, LABEL_FITS[0], brackets));
  const natural = (list: typeof shapes) =>
    2 * G.padX +
    list.reduce((total, shape) => total + shape.width, 0) +
    gapsOf.reduce((t, gap) => t + gap.min, 0);
  for (const chars of LABEL_FITS) {
    shapes = sets.map((set) => columnShape(set, radius, chars, brackets));
    if (natural(shapes) <= maxWidth) break;
  }
  const width = Math.max(FLOW_MIN_WIDTH, natural(shapes));
  let spare = width - natural(shapes);
  const gaps = gapsOf.map((gap) => gap.min);
  for (const role of SPARE_ORDER) {
    const index = sets.findIndex((set) => set.role === role) - 1;
    if (index < 0) continue;
    const grow = Math.min(spare, gapsOf[index].max - gaps[index]);
    gaps[index] += grow;
    spare -= grow;
  }
  let left = G.padX + spare / 2;
  const columns = sets.map((set, i): ColumnX => {
    if (i > 0) left += gaps[i - 1];
    const shape = shapes[i];
    const plateLeft = left + shape.inlet;
    const labelX = plateLeft + 2 * shape.plateR + G.labelGap;
    const labelEnd = labelX + shape.chars * G.charWidth;
    const column: ColumnX = {
      role: set.role,
      left,
      right: left + shape.width,
      plateX: set.role === "search" ? left + G.barWidth / 2 : plateLeft + shape.plateR,
      labelX,
      labelChars: shape.chars,
      spine: labelEnd + 12,
      port: left + shape.width - G.portBar,
    };
    left += shape.width;
    return column;
  });
  return { columns, width };
}

/* - Vertical ---------------------------------------------------------------- */

interface Stacks {
  /** Edge key to the centre of its ribbon at each end. */
  startY: Map<string, number>;
  endY: Map<string, number>;
  /** The lowest ribbon end, for the drawing's height. */
  bottom: number;
}

type Sized = RowEdge & { width: number };

/**
 * Row heights. Rows stack top down with room for their plate and the pick
 * that reaches them; a busy tool's stack of "ran next" ribbons is fitted
 * beside the column afterwards, so one heavy tool does not spread its column.
 */
function placeRows(
  sets: readonly ColumnSet[],
  edges: readonly Sized[],
  radius: ReadonlyMap<string, number>,
) {
  const outOf = new Map<string, Sized[]>();
  const into = new Map<string, Sized[]>();
  for (const edge of edges) {
    if (edge.kind === "sibling") continue;
    outOf.set(edge.from, [...(outOf.get(edge.from) ?? []), edge]);
    into.set(edge.to, [...(into.get(edge.to) ?? []), edge]);
  }
  const half = (row: ColumnRow) => {
    const picks = (into.get(row.key) ?? []).filter((e) => e.kind === "pick").map((e) => e.width);
    return Math.max(radius.get(row.key) ?? G.minRadius, stackHeight(picks) / 2);
  };

  const y = new Map<string, number>();
  const extent = new Map<string, number>();
  let bottom: number = G.padTop;
  for (const set of sets) {
    if (set.role === "search") continue;
    let previous: number | null = null;
    let cursor: number = G.padTop;
    for (const row of set.rows) {
      const ext = half(row);
      cursor =
        previous === null
          ? G.padTop + Math.max(ext, G.rowPitch / 2)
          : cursor + Math.max(G.rowPitch, previous + ext + G.rowGap);
      y.set(row.key, round(cursor));
      extent.set(row.key, ext);
      previous = ext;
    }
    bottom = Math.max(bottom, cursor + Math.max(previous ?? 0, G.rowPitch / 2));
  }
  return { y, extent, bottom, outOf, into };
}

/** Clear space between two tools' port stacks. */
const BLOCK_GAP = 5;

/**
 * Fits each row's stack of ribbon ends as one block, as close to level with
 * its row as the blocks above allow, then stacks the ribbons inside it. Only
 * the ribbons drawn at rest take room; the quiet ones, seen only in focus,
 * continue the stack below its block, where the dimmed rows do not mind them.
 */
function fitBlocks(
  rows: readonly ColumnRow[],
  lists: ReadonlyMap<string, Sized[]>,
  rowY: (key: string) => number,
  order: (a: Sized, b: Sized) => number,
  into: Map<string, number>,
): number {
  const owners = rows.filter((row) => (lists.get(row.key)?.length ?? 0) > 0);
  const majors = owners.map((row) =>
    lists
      .get(row.key)!
      .filter((e) => !e.minor)
      .sort(order),
  );
  const minors = owners.map((row) =>
    lists
      .get(row.key)!
      .filter((e) => e.minor)
      .sort(order),
  );
  const heights = majors.map((list) => stackHeight(list.map((e) => e.width)));
  const centres = fitPorts(
    owners.map((row) => rowY(row.key)),
    heights,
    G.padTop - G.rowPitch / 2,
    Number.POSITIVE_INFINITY,
    BLOCK_GAP,
  );
  let lowest = 0;
  owners.forEach((_, i) => {
    stackCentred(
      majors[i].map((e) => e.width),
      centres[i],
    ).forEach((value, j) => into.set(majors[i][j].key, value));
    let cursor =
      majors[i].length > 0
        ? centres[i] + heights[i] / 2 + PORT_GAP
        : centres[i] - minors[i][0].width / 2;
    for (const edge of minors[i]) {
      into.set(edge.key, round(cursor + edge.width / 2));
      cursor += edge.width + PORT_GAP;
    }
    lowest = Math.max(lowest, centres[i] + heights[i] / 2, cursor);
  });
  return lowest;
}

function portStacks(
  sets: readonly ColumnSet[],
  edges: readonly Sized[],
  rows: ReturnType<typeof placeRows>,
  bar: { top: number; bottom: number },
): Stacks {
  const startY = new Map<string, number>();
  const endY = new Map<string, number>();
  const rowY = (key: string) => rows.y.get(key) ?? 0;
  const byTarget = (a: RowEdge, b: RowEdge) => rowY(a.to) - rowY(b.to) || compareText(a.to, b.to);

  // Picks leave the search bar level with the tool they lead to, where they can.
  const picks = edges.filter((edge) => edge.kind === "pick").sort(byTarget);
  const pickY = fitPorts(
    picks.map((edge) => rowY(edge.to)),
    picks.map((edge) => edge.width),
    bar.top + 2,
    bar.bottom - 2,
  );
  picks.forEach((edge, i) => {
    startY.set(edge.key, pickY[i]);
    endY.set(edge.key, rowY(edge.to));
  });

  // Outlets in the order of their targets, inlets in the order of their sources' ports.
  const picked = sets.find((set) => set.role === "picked")?.rows ?? [];
  const then = sets.find((set) => set.role === "then")?.rows ?? [];
  const sequences = (lists: ReadonlyMap<string, Sized[]>) =>
    new Map([...lists].map(([key, list]) => [key, list.filter((e) => e.kind === "sequence")]));
  const outBottom = fitBlocks(picked, sequences(rows.outOf), rowY, byTarget, startY);
  const bySource = (a: Sized, b: Sized) =>
    (startY.get(a.key) ?? 0) - (startY.get(b.key) ?? 0) || compareText(a.from, b.from);
  const inBottom = fitBlocks(then, sequences(rows.into), rowY, bySource, endY);
  return { startY, endY, bottom: Math.max(outBottom, inBottom) };
}

/* - Assembly ---------------------------------------------------------------- */

/** A port bar's extent: its ribbons, reaching to its row so the leader always meets it. */
function bounds(
  values: readonly number[],
  widths: readonly number[],
  rowY: number,
): { top: number; bottom: number } | null {
  if (values.length === 0) return null;
  return {
    top: round(Math.min(rowY - 1.5, ...values.map((v, i) => v - widths[i] / 2))),
    bottom: round(Math.max(rowY + 1.5, ...values.map((v, i) => v + widths[i] / 2))),
  };
}

/**
 * Lays out a flow model. Pure and deterministic: the same model, in any node or
 * edge order, gives the same layout.
 */
export function layoutFlow(model: FlowModel, options: FlowLayoutOptions = {}): FlowLayout {
  const expanded = options.expanded ?? false;
  const graph = prepareFlow(model);
  const empty: FlowLayout = {
    width: FLOW_MIN_WIDTH,
    height: 0,
    columns: [],
    nodes: [],
    edges: [],
    totalTools: model.totalTools,
    expanded,
    foldable: false,
  };
  if (graph.nodes.length === 0) return empty;

  const { columns: sets, edges: rowEdges, foldable } = buildColumns(graph, expanded);
  const rows = sets.flatMap((set) => set.rows);
  const maxInvocations = Math.max(
    0,
    ...rows
      .filter((row) => row.kind === "tool" || row.kind === "skill")
      .map((row) => row.invocations),
  );
  const radius = new Map(rows.map((row) => [row.key, radiusOf(row, maxInvocations)]));
  const maxCount = Math.max(1, ...rowEdges.filter((e) => e.kind !== "sibling").map((e) => e.count));
  const sized = rowEdges.map((edge) => ({
    ...edge,
    width: edge.kind === "sibling" ? 1.25 : ribbonWidth(edge.count, maxCount),
  }));

  const brackets = sized.some((edge) => edge.kind === "sibling");
  const { columns, width } = placeColumns(
    sets,
    radius,
    brackets,
    options.maxWidth ?? FLOW_MAX_WIDTH,
  );
  const columnOf = new Map(columns.map((column) => [column.role, column]));
  const placed = placeRows(sets, sized, radius);

  // The search bar spans every tool a search led to, a little past each end.
  const pickTargets = sized.filter((edge) => edge.kind === "pick").map((edge) => edge.to);
  const targetTops = pickTargets.map(
    (key) => (placed.y.get(key) ?? 0) - (placed.extent.get(key) ?? 0),
  );
  const targetBottoms = pickTargets.map(
    (key) => (placed.y.get(key) ?? 0) + (placed.extent.get(key) ?? 0),
  );
  const barTop =
    pickTargets.length > 0 ? Math.min(...targetTops) - G.barOverhang : G.padTop - G.barOverhang;
  const barBottom =
    pickTargets.length > 0
      ? Math.max(...targetBottoms) + G.barOverhang
      : G.padTop + 3 * G.barOverhang;
  const bar = { top: round(barTop), bottom: round(barBottom) };
  const stacks = portStacks(sets, sized, placed, bar);
  const height = round(Math.max(placed.bottom, bar.bottom, stacks.bottom) + G.padBottom);

  const nodes: FlowLayoutNode[] = sets.flatMap((set) => {
    const column = columnOf.get(set.role)!;
    return set.rows.map((row, order): FlowLayoutNode => {
      // A port bar spans the ribbons drawn at rest, or the quiet ones when that is all it has.
      const atRest = (list: readonly Sized[]) => {
        const sequences = list.filter((e) => e.kind === "sequence");
        const major = sequences.filter((e) => !e.minor);
        return major.length > 0 ? major : sequences;
      };
      const outs = atRest(placed.outOf.get(row.key) ?? []);
      const ins = atRest(placed.into.get(row.key) ?? []);
      const ownY = placed.y.get(row.key) ?? 0;
      const outBounds = bounds(
        outs.map((e) => stacks.startY.get(e.key) ?? 0),
        outs.map((e) => e.width),
        ownY,
      );
      const inBounds = bounds(
        ins.map((e) => stacks.endY.get(e.key) ?? 0),
        ins.map((e) => e.width),
        ownY,
      );
      const search = set.role === "search";
      const text = search
        ? row.label
        : row.kind === "more" && row.moreCount
          ? `+${row.moreCount} more`
          : truncate(row.label, column.labelChars);
      return {
        key: row.key,
        id: row.id,
        kind: row.kind,
        column: set.role,
        label: row.label,
        text,
        tint: row.tint,
        signalIds: row.signalIds,
        invocations: row.invocations,
        impressions: row.impressions,
        quietCount: row.quietCount,
        moreCount: row.moreCount,
        weight: row.weight,
        order,
        x: round(column.plateX),
        y: search ? round((bar.top + bar.bottom) / 2) : (placed.y.get(row.key) ?? 0),
        r: search ? G.barWidth / 2 : (radius.get(row.key) ?? G.minRadius),
        h: search ? round(bar.bottom - bar.top) : 0,
        labelX: round(search ? column.left : column.labelX),
        labelEnd: round(search ? column.right : column.labelX + text.length * G.charWidth),
        inlet:
          set.role === "then" && inBounds
            ? { x: round(column.left), ...inBounds, quiet: ins.every((e) => e.minor) }
            : null,
        outlet:
          set.role === "picked" && outBounds
            ? { x: round(column.port), ...outBounds, quiet: outs.every((e) => e.minor) }
            : null,
      };
    });
  });

  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const picked = columnOf.get("picked");
  const siblingIndex = new Map(
    sized
      .filter((edge) => edge.kind === "sibling")
      .sort((a, b) => compareText(a.key, b.key))
      .map((edge, i) => [edge.key, i]),
  );
  const edges: FlowLayoutEdge[] = sized
    .map((edge): FlowLayoutEdge => {
      const source = byKey.get(edge.from)!;
      const target = byKey.get(edge.to)!;
      const aggregate = [source, target].some(
        (node) => node.kind === "more" || node.id === FLOW_QUIET_ID,
      );
      let start: Point;
      let end: Point;
      let path: string;
      if (edge.kind === "sibling") {
        start = { x: round(source.labelEnd + 5), y: source.y };
        end = { x: round(target.labelEnd + 5), y: target.y };
        path = bracketPath(
          start,
          end,
          (picked?.spine ?? source.labelEnd + 10) + (siblingIndex.get(edge.key)! % 3) * 3,
        );
      } else if (edge.kind === "pick") {
        start = { x: round(source.x + G.barWidth / 2), y: stacks.startY.get(edge.key)! };
        end = { x: round(target.x - target.r - 1), y: stacks.endY.get(edge.key) ?? target.y };
        path = ribbonPath(start, end);
      } else {
        start = {
          x: round((source.outlet?.x ?? source.labelEnd) + G.portBar),
          y: stacks.startY.get(edge.key)!,
        };
        end = { x: round(target.inlet?.x ?? target.x - target.r), y: stacks.endY.get(edge.key)! };
        path = ribbonPath(start, end);
      }
      return {
        key: edge.key,
        from: edge.from,
        to: edge.to,
        fromId: edge.fromId,
        toId: edge.toId,
        kind: edge.kind,
        count: edge.count,
        confidence: Math.round(edge.confidence * 100) / 100,
        tint: edge.tint === "dead" ? "none" : edge.tint,
        signalIds: edge.signalIds,
        minor: edge.minor,
        path,
        width: edge.width,
        opacity: edgeOpacity(edge, aggregate),
        start,
        end,
        step: KIND_RANK[edge.kind],
      };
    })
    .sort(
      (a, b) =>
        a.step - b.step ||
        // Wider ribbons first, so thin ones are painted on top and stay visible.
        b.width - a.width ||
        compareText(a.from, b.from) ||
        compareText(a.to, b.to),
    );

  return {
    width: round(width),
    height,
    columns: columns.map((column, index) => ({
      index,
      role: column.role,
      title: COLUMN_TITLE[column.role],
      x: round(column.left),
      width: round(column.right - column.left),
      hidden: sets[index].hidden,
    })),
    nodes,
    edges,
    totalTools: model.totalTools,
    expanded,
    foldable,
  };
}
