import { getCompactor, type Layout, moveElement, verticalCompactor } from "react-grid-layout/core";

/**
 * Where cards are on a grid of 12 columns: whole cells, no card over another, no gap above a card.
 * The browser's grid, the stored layout and MCP share this arithmetic. Pure, and knows no page.
 */

export const GRID_COLUMNS = 12;
export const GRID_ROW_PX = 40;
export const GRID_GAP_PX = 16;
export const MAX_GRID_HEIGHT = 24;

export interface GridPlace {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridItem extends GridPlace {
  id: string;
}

/** The smallest size of a card, in cells. */
export interface GridMinimum {
  w: number;
  h: number;
}

export type GridStep =
  | "up"
  | "down"
  | "left"
  | "right"
  | "wider"
  | "narrower"
  | "taller"
  | "shorter";

/** The items with every gap above and every overlap gone; their order in the list stays. Those in `first` keep their place, and what they cover goes below them, in its own order. */
export function compacted(items: readonly GridItem[], ...first: string[]): GridItem[] {
  let apart = [...items];
  for (const kept of items.filter(({ id }) => first.includes(id))) {
    const covered = apart.some((item) => !first.includes(item.id) && overlaps(kept, item));
    if (!covered) continue;
    apart = apart.map((item) => {
      if (first.includes(item.id)) return item;
      if (item.y >= kept.y) return { ...item, y: item.y + kept.h };
      return overlaps(kept, item) ? { ...item, y: kept.y + kept.h } : item;
    });
  }
  return placed(items, verticalCompactor.compact(apart.map(cellOf), GRID_COLUMNS));
}

/** A drag: the item goes to the cell, its neighbors make room, and the rows close up. Null for an unknown id. */
export function movedTo(
  items: readonly GridItem[],
  id: string,
  at: { x: number; y: number },
): GridItem[] | null {
  const layout: Layout = items.map(cellOf);
  const item = layout.find(({ i }) => i === id);
  if (!item) return null;
  const x = clamp(at.x, 0, GRID_COLUMNS - item.w);
  const moved = moveElement(
    layout,
    item,
    x,
    Math.max(0, at.y),
    true,
    false,
    getCompactor("vertical").type,
    GRID_COLUMNS,
  );
  return placed(items, verticalCompactor.compact(moved, GRID_COLUMNS));
}

/** A resize by the corner: the size is held between the minimum and the grid, and what it covers goes below. Null for an unknown id. */
export function resizedTo(
  items: readonly GridItem[],
  id: string,
  size: { w: number; h: number },
  minimum: GridMinimum,
): GridItem[] | null {
  if (!items.some((item) => item.id === id)) return null;
  return compacted(
    items.map((item) => (item.id === id ? fitted({ ...item, ...size }, minimum) : item)),
    id,
  );
}

/** One step from the keyboard. Past the neighbors of a row, they change places with it. Null when there is no room for the step. */
export function stepped(
  items: readonly GridItem[],
  id: string,
  step: GridStep,
  minimum: GridMinimum,
): GridItem[] | null {
  const me = items.find((item) => item.id === id);
  if (!me) return null;
  const others = items.filter((item) => item !== me);
  const sameColumns = others.filter((item) => crosses(item.x, item.w, me.x, me.w));
  const sameRows = others.filter((item) => crosses(item.y, item.h, me.y, me.h));
  const next = new Map<string, GridItem>();
  switch (step) {
    case "up": {
      const above = sameColumns.filter(({ y }) => y < me.y).map(({ y }) => y);
      if (above.length === 0) return null;
      const y = Math.max(...above);
      next.set(me.id, { ...me, y });
      for (const item of sameColumns) if (item.y === y) next.set(item.id, { ...item, y: y + me.h });
      break;
    }
    case "down": {
      const below = sameColumns.filter(({ y }) => y > me.y).map(({ y }) => y);
      if (below.length === 0) return null;
      const row = sameColumns.filter(({ y }) => y === Math.min(...below));
      for (const item of row) next.set(item.id, { ...item, y: me.y });
      next.set(me.id, { ...me, y: me.y + Math.max(...row.map(({ h }) => h)) });
      break;
    }
    case "left": {
      if (me.x === 0) return null;
      const beside = sameRows.find((item) => item.x + item.w === me.x);
      next.set(me.id, { ...me, x: beside ? beside.x : me.x - 1 });
      if (beside) next.set(beside.id, { ...beside, x: beside.x + me.w });
      break;
    }
    case "right": {
      if (me.x + me.w === GRID_COLUMNS) return null;
      const beside = sameRows.find((item) => item.x === me.x + me.w);
      next.set(me.id, { ...me, x: beside ? me.x + beside.w : me.x + 1 });
      if (beside) next.set(beside.id, { ...beside, x: me.x });
      break;
    }
    default: {
      const size = {
        wider: { w: me.w + 1, h: me.h },
        narrower: { w: me.w - 1, h: me.h },
        taller: { w: me.w, h: me.h + 1 },
        shorter: { w: me.w, h: me.h - 1 },
      }[step];
      const resized = fitted({ ...me, ...size }, minimum);
      if (samePlace(resized, me)) return null;
      next.set(me.id, resized);
    }
  }
  const result = compacted(
    items.map((item) => next.get(item.id) ?? item),
    id,
  );
  return result.every((item, index) => samePlace(item, items[index])) ? null : result;
}

/** Rows, then columns: what a narrow screen and an agent read them in. */
export function inReadingOrder<T extends GridPlace>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => a.y - b.y || a.x - b.x);
}

/** The item inside the grid, no smaller than its minimum. At the right edge it grows to the left. */
export function fitted<T extends GridPlace>(item: T, minimum: GridMinimum): T {
  const w = clamp(item.w, minimum.w, GRID_COLUMNS);
  const h = clamp(item.h, minimum.h, MAX_GRID_HEIGHT);
  return { ...item, w, h, x: clamp(item.x, 0, GRID_COLUMNS - w), y: Math.max(0, item.y) };
}

/** The row below the last item. */
export function bottomOf(items: readonly GridPlace[]): number {
  return Math.max(0, ...items.map(({ y, h }) => y + h));
}

export function samePlace(a: GridPlace, b: GridPlace): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export function overlaps(a: GridPlace, b: GridPlace): boolean {
  return crosses(a.x, a.w, b.x, b.w) && crosses(a.y, a.h, b.y, b.h);
}

function cellOf({ id, x, y, w, h }: GridItem) {
  return { i: id, x, y, w, h };
}

function placed(items: readonly GridItem[], layout: Layout): GridItem[] {
  const places = new Map(layout.map(({ i, x, y, w, h }) => [i, { x, y, w, h }]));
  return items.map((item) => ({ ...item, ...places.get(item.id) }));
}

function crosses(start: number, size: number, otherStart: number, otherSize: number): boolean {
  return start < otherStart + otherSize && otherStart < start + size;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
