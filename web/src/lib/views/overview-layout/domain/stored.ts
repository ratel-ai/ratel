import { z } from "zod";
import { bottomOf, GRID_COLUMNS, MAX_GRID_HEIGHT } from "@/lib/console/grid/layout";
import {
  DEFAULT_LAYOUT,
  OVERVIEW_WIDGETS,
  type OverviewLayout,
  type OverviewLayoutChange,
  settled,
} from "./layout";

/** A layout and a change as they cross a boundary: the stored row, a server action, an MCP call. Pure. */

export const LAYOUT_VERSION = 1;

/** What is stored: the version names the shape, so a later shape can read this one. */
export interface StoredOverviewLayout {
  version: typeof LAYOUT_VERSION;
  widgets: { id: string; x: number; y: number; w: number; h: number; hidden: boolean }[];
}

const cells = (low: number, high: number) => z.int().min(low).max(high);
const place = {
  x: cells(0, GRID_COLUMNS - 1),
  y: cells(0, 10_000),
  w: cells(1, GRID_COLUMNS),
  h: cells(1, MAX_GRID_HEIGHT),
};

const storedSchema = z.object({
  version: z.literal(LAYOUT_VERSION),
  widgets: z.array(z.object({ id: z.string(), ...place, hidden: z.boolean() })).max(100),
});

const widgetSchema = z.enum(OVERVIEW_WIDGETS);

/** A change as it arrives over a boundary: a server action or an MCP call. */
export const layoutChangeSchema: z.ZodType<OverviewLayoutChange> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), widget: widgetSchema, x: place.x, y: place.y }),
  z.object({ kind: z.literal("resize"), widget: widgetSchema, w: place.w, h: place.h }),
  z.object({ kind: z.enum(["show", "hide"]), widget: widgetSchema }),
  z.object({
    kind: z.literal("arrange"),
    places: z.array(z.object({ id: widgetSchema, ...place })).max(OVERVIEW_WIDGETS.length),
  }),
  z.object({ kind: z.literal("reset") }),
]);

/**
 * The layout in a stored value. A widget it does not know is dropped, a widget that is not in it
 * is added at the end and visible, and a value that does not parse reads as the default.
 */
export function readLayout(stored: unknown): OverviewLayout {
  const parsed = storedSchema.safeParse(stored);
  if (!parsed.success) return DEFAULT_LAYOUT;
  const known = parsed.data.widgets.flatMap((widget) => {
    const id = widgetSchema.safeParse(widget.id);
    return id.success ? [{ ...widget, id: id.data }] : [];
  });
  const ids = new Set(known.map(({ id }) => id));
  if (ids.size !== known.length) return DEFAULT_LAYOUT;
  const added = DEFAULT_LAYOUT.filter(({ id }) => !ids.has(id)).map((widget, index) => ({
    ...widget,
    x: 0,
    y: bottomOf(known) + index,
  }));
  return settled([...known, ...added]);
}

export function storeLayout(layout: OverviewLayout): StoredOverviewLayout {
  return {
    version: LAYOUT_VERSION,
    widgets: layout.map(({ id, x, y, w, h, hidden }) => ({ id, x, y, w, h, hidden })),
  };
}
