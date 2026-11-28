import {
  bottomOf,
  compacted,
  fitted,
  GRID_COLUMNS,
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

export const OVERVIEW_WIDGETS = ["metrics", "topology", "health", "attention", "alerts"] as const;
export type OverviewWidgetId = (typeof OVERVIEW_WIDGETS)[number];

const DASHBOARD = "dashboard:";
/** A widget of a dashboard, by reference: what it shows is the dashboard's. */
export type DashboardItemId = `${typeof DASHBOARD}${string}`;
export type OverviewItemId = OverviewWidgetId | DashboardItemId;

/** The dashboard widgets one Overview can have: each one is a read of the page. */
export const MAX_DASHBOARD_ITEMS = 12;
const DASHBOARD_ITEM_MINIMUM: GridMinimum = { w: 2, h: 2 };

export interface DashboardItemRef {
  dashboardId: string;
  widgetId: string;
}

/** What an entry takes from its source as it is added: its name, for the history and for when the source is gone, and its size. */
export interface DashboardItemSource {
  title: string;
  w: number;
  h: number;
}

export interface OverviewWidget {
  id: OverviewWidgetId;
  /** The smallest size at which its content is whole. */
  min: GridMinimum;
  /** Where it is in the default layout. */
  place: GridPlace;
}

/** What every surface calls each widget, and a history entry too. */
export const WIDGET_TITLES: Readonly<Record<OverviewWidgetId, string>> = {
  metrics: "Metrics",
  topology: "Agents and MCP servers",
  health: "Health score",
  attention: "Needs attention",
  alerts: "Alerts",
};

/** The widgets that are offered: the page, the dialog and the default layout know no other. */
export type OfferedWidgets = readonly OverviewWidget[];

/** The metrics on top, then the topology, then the Health score with Needs attention beside it, then the alerts. */
export const WIDGET_CATALOG: OfferedWidgets = [
  { id: "metrics", min: { w: 8, h: 3 }, place: { x: 0, y: 0, w: 12, h: 3 } },
  { id: "topology", min: { w: 4, h: 4 }, place: { x: 0, y: 3, w: 12, h: 7 } },
  { id: "health", min: { w: 4, h: 5 }, place: { x: 0, y: 10, w: 4, h: 6 } },
  { id: "attention", min: { w: 5, h: 3 }, place: { x: 4, y: 10, w: 8, h: 6 } },
  { id: "alerts", min: { w: 4, h: 3 }, place: { x: 0, y: 16, w: 12, h: 4 } },
];

export interface OverviewPlacement extends GridItem {
  id: OverviewItemId;
  /** Kept with its place, so adding it again puts it back. A dashboard widget is forgotten instead. */
  removed: boolean;
  /** A dashboard widget's name as it was added. */
  title?: string;
}

/** Every offered widget once and the dashboard widgets, the visible ones compacted, in the order people read them; the removed ones last. */
export type OverviewLayout = readonly OverviewPlacement[];

export type OverviewLayoutChange =
  | { kind: "move"; widget: OverviewItemId; x: number; y: number }
  | { kind: "resize"; widget: OverviewItemId; w: number; h: number }
  | { kind: "remove"; widget: OverviewItemId }
  /** `source`: of a dashboard widget, which is not added without it. */
  | { kind: "add"; widget: OverviewItemId; source?: DashboardItemSource }
  /** Where the grid in a browser left the visible widgets. `widget`: the one the person took; the others made room. */
  | { kind: "arrange"; places: readonly OverviewPlace[]; widget?: string }
  | { kind: "reset" };

/** A place from a browser, which may draw a widget that is no longer offered. */
export type OverviewPlace = GridItem;

/** What a person without a stored layout sees, with every widget offered. */
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
      if (isDashboardItem(change.widget)) return changeItem(layout, change, offered);
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
  widget: OverviewItemId,
  step: GridStep,
  offered: OfferedWidgets = WIDGET_CATALOG,
): Extract<OverviewLayoutChange, { kind: "arrange" }> | null {
  const items = stepped(visibleWidgets(layout), widget, step, widgetMinimum(widget, offered));
  return (
    items && {
      kind: "arrange",
      widget,
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

/** One widget on its own, as wide as the grid: its place in a person's layout, and its removal, do not count. */
export function onlyWidget({ id, place }: OverviewWidget): OverviewLayout {
  return [{ id, x: 0, y: 0, w: GRID_COLUMNS, h: place.h, removed: false }];
}

/** In reading order. */
export function visibleWidgets(layout: OverviewLayout): OverviewPlacement[] {
  return inReadingOrder(layout.filter(({ removed }) => !removed));
}

export function widgetMinimum(
  widget: OverviewItemId,
  offered: OfferedWidgets = WIDGET_CATALOG,
): GridMinimum {
  if (isDashboardItem(widget)) return DASHBOARD_ITEM_MINIMUM;
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
  first: readonly OverviewItemId[] = [],
): OverviewLayout {
  const whole = widgets.map((widget) => fitted(widget, widgetMinimum(widget.id, offered)));
  const visible = compacted(
    whole.filter(({ removed }) => !removed),
    ...first,
  ) as OverviewPlacement[];
  return [...inReadingOrder(visible), ...whole.filter(({ removed }) => removed)];
}

export function isDashboardItem(id: string): id is DashboardItemId {
  return id.startsWith(DASHBOARD);
}

export function dashboardItemId(dashboardId: string, widgetId: string): DashboardItemId {
  return `${DASHBOARD}${dashboardId}:${widgetId}`;
}

/** Null for a reference that cannot be read. */
export function parseDashboardItem(id: string): DashboardItemRef | null {
  const [, dashboardId, widgetId] = REFERENCE.exec(id) ?? [];
  return dashboardId && widgetId ? { dashboardId, widgetId } : null;
}

/** What a surface calls an entry, from the layout alone. */
export function placementTitle({ id, title }: Pick<OverviewPlacement, "id" | "title">): string {
  return isDashboardItem(id) ? (title ?? "Dashboard widget") : WIDGET_TITLES[id];
}

/** Another one has room. */
export function roomForDashboardItem(layout: OverviewLayout): boolean {
  return layout.filter(({ id }) => isDashboardItem(id)).length < MAX_DASHBOARD_ITEMS;
}

const REFERENCE = /^dashboard:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):([\s\S]+)$/i;

function changeItem(
  layout: OverviewLayout,
  change: Extract<OverviewLayoutChange, { kind: "add" | "remove" }>,
  offered: OfferedWidgets,
): OverviewLayout {
  const { widget: id } = change;
  const others = layout.filter((entry) => entry.id !== id);
  if (change.kind === "remove") return settled(others, offered);
  if (others.length < layout.length || !change.source || !roomForDashboardItem(layout))
    return layout;
  const { title, w, h } = change.source;
  const y = bottomOf(visibleWidgets(layout));
  return settled([...layout, { id, x: 0, y, w, h, removed: false, title }], offered);
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
