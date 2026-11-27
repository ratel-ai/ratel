import { z } from "zod";
import {
  compacted as compactedItems,
  GRID_COLUMNS,
  type GridItem,
  inReadingOrder as itemsInReadingOrder,
  MAX_GRID_HEIGHT,
  overlaps,
} from "@/lib/console/grid/layout";
import type { GridPosition, Widget, WidgetChart } from "@/lib/views/dashboards/types";

/**
 * Where widgets are: cells of the shared card grid, whose arithmetic is `lib/console/grid`. What is
 * a dashboard's own is here: the sizes and the first free place. Pure.
 */

export const MIN_WIDGET = { w: 2, h: 2 } as const;
/** A new widget: half a row. */
export const DEFAULT_SIZE = { w: 6, h: 6 } as const;
/** A new step flow: the whole row, as high as its columns. */
const STEP_FLOW_SIZE = { w: GRID_COLUMNS, h: 10 } as const;

export const gridPositionSchema = z
  .strictObject({
    x: z.int().min(0),
    y: z.int().min(0).max(10_000),
    w: z.int().min(MIN_WIDGET.w).max(GRID_COLUMNS),
    h: z.int().min(MIN_WIDGET.h).max(MAX_GRID_HEIGHT),
  })
  .refine(({ x, w }) => x + w <= GRID_COLUMNS);

type Placed = Pick<Widget, "id" | "layout">;

/** A widget as a card of the shared grid (`lib/console/grid`). */
export function cardOf<W extends Placed>(widget: W): GridItem & { widget: W } {
  const { x, y, w, h } = widget.layout;
  return { id: widget.id, x, y, w, h, widget };
}

/** Where the grid left the cards, as it is stored. */
export function layoutsOf(items: readonly GridItem[]): Record<string, GridPosition> {
  return Object.fromEntries(items.map(({ id, x, y, w, h }) => [id, { x, y, w, h }]));
}

/**
 * The widgets with every gap above and every overlap gone; their order in the list stays. `first`
 * keeps its place, and what it covers goes below it.
 */
export function compacted<W extends Placed>(widgets: readonly W[], first?: string): W[] {
  const layouts = layoutsOf(compactedItems(widgets.map(cardOf), ...(first ? [first] : [])));
  return widgets.map((widget) => ({ ...widget, layout: layouts[widget.id] ?? widget.layout }));
}

/** The size a new widget of a chart has. */
export function defaultSize(chart: WidgetChart): Pick<GridPosition, "w" | "h"> {
  return chart === "step_flow" ? STEP_FLOW_SIZE : DEFAULT_SIZE;
}

/** The first free place for a widget, left to right and top to bottom. */
export function freePosition(
  widgets: readonly Pick<Widget, "layout">[],
  { w, h }: Pick<GridPosition, "w" | "h"> = DEFAULT_SIZE,
): GridPosition {
  for (let y = 0; ; y += 1)
    for (let x = 0; x + w <= GRID_COLUMNS; x += 1) {
      const place = { x, y, w, h };
      if (!widgets.some(({ layout }) => overlaps(layout, place))) return place;
    }
}

/** Rows, then columns: what a narrow screen and an agent read them in. */
export function inReadingOrder<W extends Placed>(widgets: readonly W[]): W[] {
  return itemsInReadingOrder(widgets.map(cardOf)).map(({ widget }) => widget);
}
