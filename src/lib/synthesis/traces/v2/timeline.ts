/**
 * The full trace's timeline: a collapsible span tree on a shared time axis.
 * The waterfall model arrives in preorder with depths (`buildTraceWaterfall`);
 * these helpers derive the tree shape once, list the rows a set of collapsed
 * spans leaves visible, and move the selection by keyboard. All O(rows), so a
 * 5,000-span trace stays quick.
 */

import { formatDuration } from "./format";

export interface TimelineShape {
  /** Index of each row's parent, or -1 for a root. */
  parent: number[];
  /** Index of each row's last descendant (itself when it has none). */
  subtreeEnd: number[];
}

export function timelineShape(depths: readonly number[]): TimelineShape {
  const parent = new Array<number>(depths.length).fill(-1);
  const subtreeEnd = depths.map((_, index) => index);
  // Preorder: a row's subtree ends right before the next row at its depth or
  // shallower, which is exactly when it leaves the stack.
  const stack: number[] = [];
  for (let index = 0; index < depths.length; index += 1) {
    const depth = depths[index];
    while (stack.length > 0 && depths[stack[stack.length - 1]] >= depth) {
      subtreeEnd[stack.pop()!] = index - 1;
    }
    parent[index] = stack.length > 0 ? stack[stack.length - 1] : -1;
    stack.push(index);
  }
  for (const open of stack) subtreeEnd[open] = depths.length - 1;
  return { parent, subtreeEnd };
}

export function hasChildren(shape: TimelineShape, index: number): boolean {
  return shape.subtreeEnd[index] > index;
}

/** Rows not hidden under a collapsed ancestor, in order. */
export function visibleRows(shape: TimelineShape, collapsed: ReadonlySet<number>): number[] {
  const rows: number[] = [];
  let index = 0;
  while (index < shape.parent.length) {
    rows.push(index);
    index = collapsed.has(index) ? shape.subtreeEnd[index] + 1 : index + 1;
  }
  return rows;
}

/** The first row on the way up from `index` that is not hidden by a collapsed ancestor. */
export function nearestVisible(
  shape: TimelineShape,
  collapsed: ReadonlySet<number>,
  index: number,
): number {
  let visible = index;
  for (let ancestor = shape.parent[index]; ancestor >= 0; ancestor = shape.parent[ancestor]) {
    if (collapsed.has(ancestor)) visible = ancestor;
  }
  return visible;
}

export type TimelineMove = { select: number } | { toggle: number } | null;

/**
 * Tree keyboard (WAI-ARIA tree view): up and down move through visible rows,
 * right opens a closed row or steps into it, left closes an open row or steps
 * out to its parent, Home and End jump.
 */
export function timelineKeyMove(
  key: string,
  current: number,
  shape: TimelineShape,
  collapsed: ReadonlySet<number>,
): TimelineMove {
  const rows = visibleRows(shape, collapsed);
  const position = rows.indexOf(current);
  if (rows.length === 0) return null;
  switch (key) {
    case "ArrowDown":
    case "j":
      return { select: rows[Math.min(rows.length - 1, position + 1)] };
    case "ArrowUp":
    case "k":
      return { select: rows[Math.max(0, position - 1)] };
    case "Home":
      return { select: rows[0] };
    case "End":
      return { select: rows[rows.length - 1] };
    case "ArrowRight":
      if (!hasChildren(shape, current)) return null;
      return collapsed.has(current) ? { toggle: current } : { select: current + 1 };
    case "ArrowLeft":
      if (hasChildren(shape, current) && !collapsed.has(current)) return { toggle: current };
      return shape.parent[current] >= 0 ? { select: shape.parent[current] } : null;
    default:
      return null;
  }
}

export interface TimeTick {
  ms: number;
  /** Position on the axis, 0 to 1. */
  ratio: number;
  label: string;
}

/** Clean ticks for a span of `durationMs`: 0, then steps of 1, 2 or 5 × 10ⁿ. */
export function timeTicks(durationMs: number, target = 4): TimeTick[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    return [{ ms: 0, ratio: 0, label: formatDuration(0) }];
  const rough = durationMs / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ??
    rough;
  const ticks: TimeTick[] = [];
  for (let ms = 0; ms <= durationMs + step * 1e-9; ms += step) {
    ticks.push({ ms, ratio: Math.min(1, ms / durationMs), label: formatDuration(ms) });
  }
  return ticks;
}
