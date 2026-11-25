import {
  compacted,
  fitted,
  type GridItem,
  type GridMinimum,
  type GridPlace,
  type GridStep,
  inReadingOrder,
  movedTo,
  resizedTo,
  samePlace,
  stepped,
} from "@/lib/console/grid/layout";

/**
 * The Overview as one person arranged it in one project: which widgets, and where. Pure, and
 * every function gives a layout that can be drawn. What is stored is in `stored.ts`.
 */

export const OVERVIEW_WIDGETS = ["metrics", "topology", "health", "attention"] as const;
export type OverviewWidgetId = (typeof OVERVIEW_WIDGETS)[number];

export interface OverviewWidget {
  id: OverviewWidgetId;
  /** The smallest size at which its content is whole. */
  min: GridMinimum;
  /** Where it is in the default layout. */
  place: GridPlace;
}

/** The widgets that are offered: the page, the dialog and the default layout know no other. */
export type OfferedWidgets = readonly OverviewWidget[];

/** The metrics on top, then the topology, then the Health score with Needs attention beside it. */
export const WIDGET_CATALOG: OfferedWidgets = [
  { id: "metrics", min: { w: 8, h: 4 }, place: { x: 0, y: 0, w: 12, h: 4 } },
  { id: "topology", min: { w: 4, h: 5 }, place: { x: 0, y: 4, w: 12, h: 8 } },
  { id: "health", min: { w: 4, h: 6 }, place: { x: 0, y: 12, w: 4, h: 7 } },
  { id: "attention", min: { w: 5, h: 4 }, place: { x: 4, y: 12, w: 8, h: 7 } },
];

export interface OverviewPlacement extends GridItem {
  id: OverviewWidgetId;
  /** Kept with its place, so adding it again puts it back. */
  removed: boolean;
}

/** Every offered widget once, the visible ones compacted, in the order people read them; the removed ones last. */
export type OverviewLayout = readonly OverviewPlacement[];

export type OverviewLayoutChange =
  | { kind: "move"; widget: OverviewWidgetId; x: number; y: number }
  | { kind: "resize"; widget: OverviewWidgetId; w: number; h: number }
  | { kind: "add" | "remove"; widget: OverviewWidgetId }
  /** Where the grid in a browser left the visible widgets. */
  | { kind: "arrange"; places: readonly OverviewPlace[] }
  | { kind: "reset" };

/** A place from a browser, which may draw a widget that is no longer offered. */
export type OverviewPlace = GridItem;

/** What a person without a stored layout sees. */
export const DEFAULT_LAYOUT: OverviewLayout = defaultLayout(WIDGET_CATALOG);

export function changeLayout(
  layout: OverviewLayout,
  change: OverviewLayoutChange,
  offered: OfferedWidgets = WIDGET_CATALOG,
): OverviewLayout {
  switch (change.kind) {
    case "reset":
      return defaultLayout(offered);
    case "add":
    case "remove": {
      const removed = change.kind === "remove";
      return settled(
        layout.map((widget) => (widget.id === change.widget ? { ...widget, removed } : widget)),
        offered,
        removed ? [] : [change.widget],
      );
    }
    case "move":
      return withPlaces(layout, movedTo(visibleWidgets(layout), change.widget, change), offered);
    case "resize":
      return withPlaces(
        layout,
        resizedTo(
          visibleWidgets(layout),
          change.widget,
          change,
          widgetMinimum(change.widget, offered),
        ),
        offered,
      );
    case "arrange":
      return withPlaces(layout, change.places, offered);
  }
}

/** The change one keyboard step makes; null when there is no room for it. */
export function stepChange(
  layout: OverviewLayout,
  widget: OverviewWidgetId,
  step: GridStep,
  offered: OfferedWidgets = WIDGET_CATALOG,
): Extract<OverviewLayoutChange, { kind: "arrange" }> | null {
  const items = stepped(visibleWidgets(layout), widget, step, widgetMinimum(widget, offered));
  return (
    items && {
      kind: "arrange",
      places: items.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
    }
  );
}

/** The default layout of the offered widgets. */
export function defaultLayout(offered: OfferedWidgets): OverviewLayout {
  return settled(
    offered.map(({ id, place }) => ({ id, ...place, removed: false })),
    offered,
  );
}

/** In reading order. */
export function visibleWidgets(layout: OverviewLayout): OverviewPlacement[] {
  return inReadingOrder(layout.filter(({ removed }) => !removed));
}

export function widgetMinimum(
  widget: OverviewWidgetId,
  offered: OfferedWidgets = WIDGET_CATALOG,
): GridMinimum {
  return offered.find(({ id }) => id === widget)?.min ?? { w: 1, h: 1 };
}

export function sameLayout(a: OverviewLayout, b: OverviewLayout): boolean {
  if (a.length !== b.length) return false;
  const other = new Map(b.map((widget) => [widget.id, widget]));
  return a.every((widget) => {
    const match = other.get(widget.id);
    return match?.removed === widget.removed && samePlace(match, widget);
  });
}

/** Every size whole, and the visible widgets compacted; those in `first` keep their place. */
export function settled(
  widgets: readonly OverviewPlacement[],
  offered: OfferedWidgets,
  first: readonly OverviewWidgetId[] = [],
): OverviewLayout {
  const whole = widgets.map((widget) => fitted(widget, widgetMinimum(widget.id, offered)));
  const visible = compacted(
    whole.filter(({ removed }) => !removed),
    ...first,
  ) as OverviewPlacement[];
  return [...inReadingOrder(visible), ...whole.filter(({ removed }) => removed)];
}

/** Removed widgets keep the place they had. */
function withPlaces(
  layout: OverviewLayout,
  places: readonly GridItem[] | null,
  offered: OfferedWidgets,
): OverviewLayout {
  if (!places) return layout;
  const moved = new Map<string, GridPlace>(
    places.map(({ id, x, y, w, h }) => [id, { x, y, w, h }]),
  );
  return settled(
    layout.map((widget) => (widget.removed ? widget : { ...widget, ...moved.get(widget.id) })),
    offered,
  );
}
