import {
  compacted,
  fitted,
  type GridItem,
  type GridMinimum,
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

/** The smallest size at which a widget's content is whole. */
export const WIDGET_MINIMUM: Readonly<Record<OverviewWidgetId, GridMinimum>> = {
  metrics: { w: 8, h: 4 },
  topology: { w: 4, h: 5 },
  health: { w: 4, h: 6 },
  attention: { w: 5, h: 4 },
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

/** The metrics on top, then the topology, then the Health score with Needs attention beside it. */
export const DEFAULT_LAYOUT: OverviewLayout = [
  { id: "metrics", x: 0, y: 0, w: 12, h: 4, hidden: false },
  { id: "topology", x: 0, y: 4, w: 12, h: 8, hidden: false },
  { id: "health", x: 0, y: 12, w: 4, h: 7, hidden: false },
  { id: "attention", x: 4, y: 12, w: 8, h: 7, hidden: false },
];

export function changeLayout(layout: OverviewLayout, change: OverviewLayoutChange): OverviewLayout {
  switch (change.kind) {
    case "reset":
      return DEFAULT_LAYOUT;
    case "show":
    case "hide": {
      const hidden = change.kind === "hide";
      return settled(
        layout.map((widget) => (widget.id === change.widget ? { ...widget, hidden } : widget)),
        hidden ? undefined : change.widget,
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

/** Every size whole, and the visible widgets compacted; `first` keeps its place. */
export function settled(
  widgets: readonly OverviewPlacement[],
  first?: OverviewWidgetId,
): OverviewLayout {
  const whole = widgets.map((widget) => fitted(widget, WIDGET_MINIMUM[widget.id]));
  const shown = compacted(
    whole.filter(({ hidden }) => !hidden),
    first,
  ) as OverviewPlacement[];
  return [...inReadingOrder(shown), ...whole.filter(({ hidden }) => hidden)];
}
