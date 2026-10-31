import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";

/**
 * A task's steps as a layered graph (first drawn by Tool craft for one ask,
 * now for one task): a column per step of the usual order (a tool sits one
 * column right of the tools that usually run before it), tools of the same
 * step stacked in the column, and an arrow for every "a then b" the task's
 * runs made, labelled with how often b followed a (P(b | a) within the
 * task's runs). Forward arrows are S-curves between columns; an arrow
 * against the usual order loops under the diagram. Pure; the SVG is drawn
 * from these numbers.
 */

/** One next-call edge: a then b `n` times, of `na` visits to a. */
export interface StoredIntentEdge {
  a: string;
  b: string;
  n: number;
  na: number;
}

/** A hop this sure is a dependency (the default bar for an arrow; the task page lowers it to show branches). */
export const SURE_HOP_P = 0.9;

export const FLOW_MAX_TOOLS = 8;
const NODE_H = 44;
const NODE_MIN_W = 96;
const NODE_MAX_CHARS = 20;
const NODE_PAD = 14;
const CHAR_PX = 6.6;
/** Horizontal room between columns, where the labels sit. */
const COLUMN_GAP = 84;
const ROW_GAP = 18;
const MARGIN = 20;
/** How far below the diagram the first backward loop runs, and the step per further loop. */
const LOOP_BASE = 26;
const LOOP_STEP = 20;

export interface FlowNode {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Units of the ask that called it. */
  units: number;
  /** The column (step) it sits in. */
  column: number;
}

export interface FlowArrow {
  a: string;
  b: string;
  n: number;
  na: number;
  /** n / na. */
  p: number;
  /** With the usual order (left to right). */
  forward: boolean;
  strong: boolean;
  /** Columns crossed; 0 for a loop inside one column. */
  span: number;
  /** SVG path from a's side to b's side. */
  d: string;
  labelX: number;
  labelY: number;
}

export interface IntentFlowLayout {
  width: number;
  height: number;
  nodes: FlowNode[];
  arrows: FlowArrow[];
  /** Tools left out to keep the drawing readable. */
  hidden: number;
  columns: number;
}

export interface FlowInput {
  edges: readonly StoredIntentEdge[];
  /** The task's tools with the runs that called each; names the nodes with no edge. */
  tools: readonly { toolId: string; n: number }[];
  names: Record<string, string>;
}

/**
 * The usual order as columns: of each pair, only the direction that won
 * (more a→b than b→a) counts; a tool's column is the longest such path from
 * a tool nothing precedes. A cycle that survives is cut at its weakest edge.
 * Tools with no arrows go in a last column of their own.
 */
export function layerGraph(
  tools: readonly string[],
  edges: readonly StoredIntentEdge[],
): { column: Map<string, number>; dominant: { a: string; b: string; n: number }[] } {
  const keep = new Set(tools);
  const n = new Map<string, number>();
  for (const e of edges)
    if (keep.has(e.a) && keep.has(e.b) && e.a !== e.b) n.set(`${e.a}>${e.b}`, e.n);
  let dominant: { a: string; b: string; n: number }[] = [];
  for (const [key, count] of n) {
    const [a, b] = key.split(">") as [string, string];
    const back = n.get(`${b}>${a}`) ?? 0;
    if (count > back || (count === back && a < b)) dominant.push({ a, b, n: count });
  }
  const layer = new Map<string, number>();
  for (;;) {
    const indegree = new Map<string, number>(tools.map((t) => [t, 0]));
    for (const e of dominant) indegree.set(e.b, (indegree.get(e.b) ?? 0) + 1);
    const ready = tools.filter((t) => indegree.get(t) === 0);
    layer.clear();
    for (const t of ready) layer.set(t, 0);
    const queue = [...ready];
    while (queue.length > 0) {
      const a = queue.shift()!;
      for (const e of dominant) {
        if (e.a !== a) continue;
        layer.set(e.b, Math.max(layer.get(e.b) ?? 0, (layer.get(a) ?? 0) + 1));
        indegree.set(e.b, (indegree.get(e.b) ?? 0) - 1);
        if (indegree.get(e.b) === 0) queue.push(e.b);
      }
    }
    if (layer.size === tools.length || dominant.length === 0) break;
    const inCycle = dominant.filter((e) => !layer.has(e.b));
    const weakest = inCycle.reduce((min, e) => (e.n < min.n ? e : min), inCycle[0]!);
    dominant = dominant.filter((e) => e !== weakest);
  }
  const hasArrow = new Set(dominant.flatMap((e) => [e.a, e.b]));
  const last =
    Math.max(-1, ...[...layer.entries()].filter(([t]) => hasArrow.has(t)).map(([, l]) => l)) + 1;
  const out = new Map<string, number>();
  for (const t of tools) out.set(t, hasArrow.has(t) ? (layer.get(t) ?? 0) : last);
  return { column: out, dominant };
}

/** A point on the cubic from (x1,y1) to (x2,y2) with controls at the middle x. */
function alongCubic(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number,
): { x: number; y: number } {
  const cx = (x1 + x2) / 2;
  const u = 1 - t;
  return {
    x: u ** 3 * x1 + 3 * u * u * t * cx + 3 * u * t * t * cx + t ** 3 * x2,
    y: u ** 3 * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y2,
  };
}

/** A forward arrow's curve: an S between the facing sides, or a bump over the cards in its way. */
interface Curve {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Control points' y when the arrow bumps over a card; absent for an S. */
  bumpY?: number;
}

function pointAt(c: Curve, t: number): { x: number; y: number } {
  if (c.bumpY === undefined) return alongCubic(c.x1, c.y1, c.x2, c.y2, t);
  const u = 1 - t;
  const cx1 = c.x1 + COLUMN_GAP * 0.6;
  const cx2 = c.x2 - COLUMN_GAP * 0.6;
  return {
    x: u ** 3 * c.x1 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t ** 3 * c.x2,
    y: u ** 3 * c.y1 + 3 * u * u * t * c.bumpY + 3 * u * t * t * c.bumpY + t ** 3 * c.y2,
  };
}

function pathOf(c: Curve): string {
  if (c.bumpY === undefined) {
    const cx = (c.x1 + c.x2) / 2;
    return `M${c.x1} ${c.y1} C${cx} ${c.y1} ${cx} ${c.y2} ${c.x2} ${c.y2}`;
  }
  return `M${c.x1} ${c.y1} C${c.x1 + COLUMN_GAP * 0.6} ${c.bumpY} ${c.x2 - COLUMN_GAP * 0.6} ${c.bumpY} ${c.x2} ${c.y2}`;
}

/** The point of the curve at a given x (x grows with t), by bisection. */
function curveAtX(c: Curve, x: number): { x: number; y: number } {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (pointAt(c, mid).x < x) lo = mid;
    else hi = mid;
  }
  return pointAt(c, (lo + hi) / 2);
}

/** How far above the top row a bump's control points sit. */
const BUMP_RISE = 46;

/** The label pill's size, for keeping labels off cards and each other. */
const LABEL_W = 40;
const LABEL_H = 18;

export function buildIntentFlow(
  { edges, tools, names }: FlowInput,
  opts: { maxTools?: number; minP?: number; units?: number } = {},
): IntentFlowLayout {
  const maxTools = opts.maxTools ?? FLOW_MAX_TOOLS;
  const minP = opts.minP ?? SURE_HOP_P;
  const unitsOf = new Map(tools.map((t) => [t.toolId, t.n]));
  const all = new Set([...unitsOf.keys(), ...edges.flatMap((e) => [e.a, e.b])]);
  // Dependencies only: a tool earns its place through a hop that holds at
  // least `minP` of the time, the surest (Wilson lower bound) first, until
  // the diagram is full. A tool the ask merely calls, however often, is not
  // drawn; an ask with no such hop draws nothing.
  const dependent = edges
    .filter((e) => e.a !== e.b && e.na > 0 && e.n / e.na >= minP)
    .map((e) => ({ ...e, low: wilsonLow(e.n, e.na) }))
    .sort(
      (x, y) => y.low - x.low || y.n - x.n || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1),
    );
  const kept: string[] = [];
  const keptSet = new Set<string>();
  const admit = (...ids: string[]) => {
    const fresh = ids.filter((id) => !keptSet.has(id));
    if (kept.length + fresh.length > maxTools) return;
    for (const id of fresh) {
      kept.push(id);
      keptSet.add(id);
    }
  };
  for (const e of dependent) admit(e.a, e.b);
  // Without the ask's unit count the caller is listing tools to draw, not the ask's traffic: every listed tool stays.
  if (opts.units === undefined)
    for (const [id] of [...unitsOf.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)))
      admit(id);
  const drawnSet = new Set(dependent.map((e) => `${e.a}>${e.b}`));
  const drawn = edges.filter(
    (e) => keptSet.has(e.a) && keptSet.has(e.b) && drawnSet.has(`${e.a}>${e.b}`),
  );
  const { column, dominant } = layerGraph(kept, drawn);
  const columns = kept.length === 0 ? 0 : Math.max(...kept.map((t) => column.get(t)!)) + 1;

  // One node width for the whole diagram, from the longest name.
  const labelOf = (id: string) => {
    const label = names[id] ?? id;
    return label.length > NODE_MAX_CHARS ? `${label.slice(0, NODE_MAX_CHARS - 1)}…` : label;
  };
  const nodeW = Math.max(
    NODE_MIN_W,
    ...kept.map((id) => Math.ceil(labelOf(id).length * CHAR_PX + NODE_PAD * 2)),
  );
  const byColumn: string[][] = Array.from({ length: columns }, () => []);
  for (const id of kept) byColumn[column.get(id)!]!.push(id);

  // Rows. A tool sits on the row of the tool that usually runs before it
  // (its strongest predecessor), so a chain a → b → c is one straight line;
  // when one tool fans out, its followers spread around its row, the
  // strongest nearest; chains that share nothing get rows of their own.
  // Tools in one column that would land on one row are pushed apart.
  const STEP = NODE_H + ROW_GAP;
  const row = new Map<string, number>();
  const parentOf = new Map<string, string>();
  for (const id of kept) {
    const into = dominant
      .filter((e) => e.b === id && column.get(e.a)! < column.get(id)!)
      .sort((x, y) => y.n - x.n || (x.a < y.a ? -1 : 1));
    if (into[0]) parentOf.set(id, into[0].a);
  }
  const strength = (a: string, b: string) => dominant.find((e) => e.a === a && e.b === b)?.n ?? 0;
  byColumn.forEach((col, c) => {
    const wanted = new Map<string, number>();
    if (c === 0) {
      col
        .sort((x, y) => (unitsOf.get(y) ?? 0) - (unitsOf.get(x) ?? 0) || (x < y ? -1 : 1))
        .forEach((id, i) => wanted.set(id, i * STEP));
    } else {
      const children = new Map<string, string[]>();
      const orphans: string[] = [];
      for (const id of col) {
        const parent = parentOf.get(id);
        if (parent === undefined) orphans.push(id);
        else children.set(parent, [...(children.get(parent) ?? []), id]);
      }
      for (const [parent, kids] of children) {
        kids.sort(
          (x, y) =>
            strength(parent, y) - strength(parent, x) ||
            (unitsOf.get(y) ?? 0) - (unitsOf.get(x) ?? 0) ||
            (x < y ? -1 : 1),
        );
        // Spread around the parent's row: the strongest just above the middle, then alternating down and up.
        const offsets = kids.map((_, i) =>
          i === 0 ? 0 : i % 2 === 1 ? Math.ceil(i / 2) : -Math.ceil(i / 2),
        );
        const centre = (Math.max(...offsets) + Math.min(...offsets)) / 2;
        kids.forEach((id, i) =>
          wanted.set(id, (row.get(parent) ?? 0) + (offsets[i]! - centre) * STEP),
        );
      }
      const below = Math.max(-STEP, ...[...row.values()]) + STEP;
      orphans
        .sort((x, y) => (unitsOf.get(y) ?? 0) - (unitsOf.get(x) ?? 0) || (x < y ? -1 : 1))
        .forEach((id, i) => wanted.set(id, below + i * STEP));
    }
    // Resolve the column: in wanted order, each at least a step below the last.
    const ordered = [...col].sort((x, y) => wanted.get(x)! - wanted.get(y)! || (x < y ? -1 : 1));
    let last = -Infinity;
    for (const id of ordered) {
      const y = Math.max(wanted.get(id)!, last + STEP);
      row.set(id, y);
      last = y;
    }
    byColumn[c] = ordered;
  });
  // Right to left: a tool whose followers were pushed off its row moves to
  // their middle when that row is free in its column, so the line is straight.
  for (let c = columns - 2; c >= 0; c -= 1) {
    for (const id of byColumn[c]!) {
      const kids = dominant
        .filter((e) => e.a === id && parentOf.get(e.b) === id)
        .map((e) => row.get(e.b)!);
      if (kids.length === 0) continue;
      const want = (Math.min(...kids) + Math.max(...kids)) / 2;
      if (want === row.get(id)) continue;
      const free = byColumn[c]!.every(
        (other) => other === id || Math.abs(row.get(other)! - want) >= STEP,
      );
      if (free) row.set(id, want);
    }
    byColumn[c]!.sort((x, y) => row.get(x)! - row.get(y)! || (x < y ? -1 : 1));
  }
  // A hop over two or more columns whose straight line would cross a card in
  // between bumps over it; the diagram then needs headroom above the top row.
  const inTheWay = (e: StoredIntentEdge): boolean => {
    const ca = column.get(e.a)!;
    const cb = column.get(e.b)!;
    if (cb - ca < 2) return false;
    const ya = row.get(e.a)!;
    const yb = row.get(e.b)!;
    return kept.some((id) => {
      const c = column.get(id)!;
      if (c <= ca || c >= cb) return false;
      const yLine = ya + ((yb - ya) * (c - ca)) / (cb - ca);
      return Math.abs(row.get(id)! - yLine) < STEP * 0.9;
    });
  };
  const bumps = new Set(drawn.filter((e) => column.get(e.b)! > column.get(e.a)! && inTheWay(e)));
  const minRow =
    Math.min(0, ...row.values()) - (bumps.size > 0 ? BUMP_RISE * 0.75 + LABEL_H / 2 : 0);
  const maxRow = Math.max(0, ...row.values());
  const bodyH = maxRow - minRow + NODE_H;

  const nodes: FlowNode[] = [];
  byColumn.forEach((col, c) => {
    for (const id of col)
      nodes.push({
        id,
        label: labelOf(id),
        x: MARGIN + c * (nodeW + COLUMN_GAP),
        y: MARGIN + (row.get(id)! - minRow),
        w: nodeW,
        h: NODE_H,
        units: unitsOf.get(id) ?? 0,
        column: c,
      });
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const width = columns === 0 ? 0 : MARGIN * 2 + columns * nodeW + (columns - 1) * COLUMN_GAP;

  // Backward arrows loop under the diagram, each on its own lane.
  const loops = drawn
    .filter((e) => column.get(e.b)! <= column.get(e.a)!)
    .sort((x, y) => y.n - x.n || (x.a < y.a ? -1 : 1));
  const loopLane = new Map(loops.map((e, i) => [e, i]));
  const height =
    columns === 0
      ? 0
      : MARGIN * 2 +
        bodyH +
        (loops.length > 0 ? LOOP_BASE + LOOP_STEP * (loops.length - 1) + 14 : 0);

  const curves = new Map<string, Curve>();
  const topRowY = Math.min(...nodes.map((n) => n.y));
  const arrows: FlowArrow[] = drawn
    .map((e) => {
      const from = byId.get(e.a)!;
      const to = byId.get(e.b)!;
      const p = e.na > 0 ? e.n / e.na : 0;
      const forward = column.get(e.b)! > column.get(e.a)!;
      const span = Math.abs(column.get(e.b)! - column.get(e.a)!);
      const base = { a: e.a, b: e.b, n: e.n, na: e.na, p, forward, strong: p >= minP, span };
      if (forward) {
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x;
        const y2 = to.y + to.h / 2;
        const curve: Curve = bumps.has(e)
          ? { x1, y1: from.y + 6, x2, y2: to.y + 6, bumpY: topRowY - BUMP_RISE }
          : { x1, y1, x2, y2 };
        curves.set(`${e.a}>${e.b}`, curve);
        // Placed for real below; start at the middle of the first gap.
        const at = curveAtX(curve, x1 + COLUMN_GAP / 2);
        return { ...base, d: pathOf(curve), labelX: at.x, labelY: at.y };
      }
      // A loop: down from a's bottom, along a lane under the diagram, up into b's bottom.
      const lane = loopLane.get(e) ?? 0;
      const yLane = MARGIN + bodyH + LOOP_BASE + LOOP_STEP * lane;
      const x1 = from.x + from.w / 2 + 8;
      const x2 = to.x + to.w / 2 - 8;
      const y1 = from.y + from.h;
      const y2 = to.y + to.h;
      const dir = x2 > x1 ? 12 : -12;
      const d = `M${x1} ${y1} C${x1} ${yLane} ${x1} ${yLane} ${x1 + dir} ${yLane} L${x2 - dir} ${yLane} C${x2} ${yLane} ${x2} ${yLane} ${x2} ${y2}`;
      return { ...base, d, labelX: (x1 + x2) / 2, labelY: yLane };
    })
    .sort((x, y) => y.p - x.p || y.n - x.n);
  // Labels sit in the gaps between columns, never on a card and never on
  // each other: a hop's candidates are the centres of the gaps it crosses
  // (its first gap, then its last, then the rest), and a candidate that
  // would meet a card or an earlier label is skipped. Stronger arrows place
  // first, so a habit's label keeps the obvious spot.
  const placed: { x: number; y: number }[] = [];
  const meetsCard = (x: number, y: number) =>
    nodes.some(
      (n) =>
        x + LABEL_W / 2 > n.x - 2 &&
        x - LABEL_W / 2 < n.x + n.w + 2 &&
        y + LABEL_H / 2 > n.y - 2 &&
        y - LABEL_H / 2 < n.y + n.h + 2,
    );
  const meetsLabel = (x: number, y: number) =>
    placed.some((l) => Math.abs(l.x - x) < LABEL_W && Math.abs(l.y - y) < LABEL_H);
  for (const a of arrows) {
    const c = curves.get(`${a.a}>${a.b}`);
    if (!c) {
      placed.push({ x: a.labelX, y: a.labelY });
      continue;
    }
    const gaps = Array.from(
      { length: a.span },
      (_, g) => c.x1 + g * (nodeW + COLUMN_GAP) + COLUMN_GAP / 2,
    );
    const order = gaps.length > 1 ? [gaps[0]!, gaps[gaps.length - 1]!, ...gaps.slice(1, -1)] : gaps;
    // A bump's label sits on its crest, over the card it clears.
    const candidates =
      c.bumpY === undefined
        ? order.flatMap((x) => [x, x - 14, x + 14]).map((x) => curveAtX(c, x))
        : [0.5, 0.4, 0.6, 0.3, 0.7].map((t) => pointAt(c, t));
    const spot =
      candidates.find((p) => !meetsCard(p.x, p.y) && !meetsLabel(p.x, p.y)) ??
      candidates.find((p) => !meetsLabel(p.x, p.y)) ??
      candidates[0]!;
    a.labelX = Math.round(spot.x * 10) / 10;
    a.labelY = Math.round(spot.y * 10) / 10;
    placed.push({ x: a.labelX, y: a.labelY });
  }
  return { width, height, nodes, arrows, hidden: all.size - kept.length, columns };
}
