import { z } from "zod";
import {
  bottomOf,
  compacted,
  fitted,
  GRID_COLUMNS,
  type GridItem,
  type GridMinimum,
  type GridStep,
  inReadingOrder,
  MAX_GRID_HEIGHT,
  movedTo,
  resizedTo,
  samePlace,
  stepped,
} from "@/lib/console/grid/layout";

/**
 * The Overview as one person arranged it in one project: which widgets, and where. Pure: the
 * stored value comes in as `unknown`, and every function gives a layout that can be drawn.
 */

export const OVERVIEW_WIDGETS = ["metrics", "topology", "health", "attention"] as const;
export type OverviewWidgetId = (typeof OVERVIEW_WIDGETS)[number];

export const LAYOUT_VERSION = 1;

/** The smallest size at which a widget's content is whole. */
export const WIDGET_MINIMUM: Readonly<Record<OverviewWidgetId, GridMinimum>> = {
  metrics: { w: 6, h: 3 },
  topology: { w: 4, h: 5 },
  health: { w: 3, h: 6 },
  attention: { w: 4, h: 4 },
};

export interface OverviewPlacement extends GridItem {
  id: OverviewWidgetId;
  /** Kept with its place, so showing it again puts it back. */
  hidden: boolean;
}

/** Every widget once, the visible ones compacted, in the order people read them; the hidden ones last. */
export type OverviewLayout = readonly OverviewPlacement[];

export type OverviewLayoutChange =
  | { kind: "move"; widget: OverviewWidgetId; x: number; y: number }
  | { kind: "resize"; widget: OverviewWidgetId; w: number; h: number }
  | { kind: "show" | "hide"; widget: OverviewWidgetId }
  /** Where the grid in a browser left the visible widgets. */
  | { kind: "arrange"; places: readonly OverviewPlace[] }
  | { kind: "reset" };

export type OverviewPlace = Pick<OverviewPlacement, "id" | "x" | "y" | "w" | "h">;

/** What is stored: the version names the shape, so a later shape can read this one. */
export interface StoredOverviewLayout {
  version: typeof LAYOUT_VERSION;
  widgets: { id: string; x: number; y: number; w: number; h: number; hidden: boolean }[];
}

/** The metrics on top, then the topology, then the Health score with Needs attention beside it. */
export const DEFAULT_LAYOUT: OverviewLayout = [
  { id: "metrics", x: 0, y: 0, w: 12, h: 3, hidden: false },
  { id: "topology", x: 0, y: 3, w: 12, h: 9, hidden: false },
  { id: "health", x: 0, y: 12, w: 4, h: 7, hidden: false },
  { id: "attention", x: 4, y: 12, w: 8, h: 7, hidden: false },
];

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

export function changeLayout(layout: OverviewLayout, change: OverviewLayoutChange): OverviewLayout {
  switch (change.kind) {
    case "reset":
      return DEFAULT_LAYOUT;
    case "show":
    case "hide": {
      const hidden = change.kind === "hide";
      return settled(
        layout.map((widget) => (widget.id === change.widget ? { ...widget, hidden } : widget)),
      );
    }
    case "move":
      return withPlaces(layout, movedTo(visibleWidgets(layout), change.widget, change));
    case "resize":
      return withPlaces(
        layout,
        resizedTo(visibleWidgets(layout), change.widget, change, WIDGET_MINIMUM[change.widget]),
      );
    case "arrange":
      return withPlaces(layout, change.places);
  }
}

/** The change one keyboard step makes; null when there is no room for it. */
export function stepChange(
  layout: OverviewLayout,
  widget: OverviewWidgetId,
  step: GridStep,
): Extract<OverviewLayoutChange, { kind: "arrange" }> | null {
  const items = stepped(visibleWidgets(layout), widget, step, WIDGET_MINIMUM[widget]);
  return (
    items && {
      kind: "arrange",
      places: items.map(({ id, x, y, w, h }) => ({ id: id as OverviewWidgetId, x, y, w, h })),
    }
  );
}

/** In reading order. */
export function visibleWidgets(layout: OverviewLayout): OverviewPlacement[] {
  return inReadingOrder(layout.filter(({ hidden }) => !hidden));
}

export function sameLayout(a: OverviewLayout, b: OverviewLayout): boolean {
  const other = new Map(b.map((widget) => [widget.id, widget]));
  return a.every((widget) => {
    const match = other.get(widget.id);
    return match?.hidden === widget.hidden && samePlace(match, widget);
  });
}

/** Hidden widgets keep the place they had. */
function withPlaces(layout: OverviewLayout, places: readonly GridItem[] | null): OverviewLayout {
  if (!places) return layout;
  const moved = new Map(places.map(({ id, x, y, w, h }) => [id, { x, y, w, h }]));
  return settled(
    layout.map((widget) => (widget.hidden ? widget : { ...widget, ...moved.get(widget.id) })),
  );
}

function settled(widgets: readonly OverviewPlacement[]): OverviewLayout {
  const whole = widgets.map((widget) => fitted(widget, WIDGET_MINIMUM[widget.id]));
  const shown = compacted(whole.filter(({ hidden }) => !hidden)) as OverviewPlacement[];
  return [...inReadingOrder(shown), ...whole.filter(({ hidden }) => hidden)];
}
