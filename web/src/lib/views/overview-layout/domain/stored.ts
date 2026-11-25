import { z } from "zod";
import { bottomOf, GRID_COLUMNS, MAX_GRID_HEIGHT, overlaps } from "@/lib/console/grid/layout";
import {
  changeLayout,
  defaultLayout,
  type OfferedWidgets,
  type OverviewLayout,
  type OverviewLayoutChange,
  type OverviewPlacement,
  type OverviewWidgetId,
  settled,
} from "./layout";

/** A layout and a change as they cross a boundary: the stored row, a server action, an MCP call. Pure. */

/** The shape of a row. A widget that comes or goes is no new shape. */
export const LAYOUT_VERSION = 1;

/** What is stored: the version names the shape, so a later shape can read this one. */
export interface StoredOverviewLayout {
  version: typeof LAYOUT_VERSION;
  /** `hidden`: the person removed it. */
  widgets: readonly StoredWidget[];
}

interface StoredWidget {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hidden: boolean;
}

/** A person's layout, and their entries of widgets that are not offered now: never drawn, only kept. */
export interface OverviewArrangement {
  layout: OverviewLayout;
  kept: readonly StoredWidget[];
}

const MAX_WIDGETS = 100;
const cells = (low: number, high: number) => z.int().min(low).max(high);
const place = {
  x: cells(0, GRID_COLUMNS - 1),
  y: cells(0, 10_000),
  w: cells(1, GRID_COLUMNS),
  h: cells(1, MAX_GRID_HEIGHT),
};

const storedSchema = z.object({
  version: z.literal(LAYOUT_VERSION),
  widgets: z.array(z.object({ id: z.string(), ...place, hidden: z.boolean() })).max(MAX_WIDGETS),
});

/** A change as it arrives over a boundary: a server action or an MCP call. */
export function layoutChangeSchema(offered: OfferedWidgets): z.ZodType<OverviewLayoutChange> {
  const widget = z.enum(offered.map(({ id }) => id));
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("move"), widget, x: place.x, y: place.y }),
    z.object({ kind: z.literal("resize"), widget, w: place.w, h: place.h }),
    z.object({ kind: z.enum(["add", "remove"]), widget }),
    z.object({
      kind: z.literal("arrange"),
      // Any id: a page that is open while the list changes still draws the old one.
      places: z.array(z.object({ id: z.string(), ...place })).max(MAX_WIDGETS),
    }),
    z.object({ kind: z.literal("reset") }),
  ]);
}

/**
 * The arrangement in a stored value, for the widgets that are offered now. One that is not in it
 * is added at the end and visible. One that is in it but not offered is kept. A value that does
 * not parse, or that names a widget twice, reads as the default.
 */
export function readArrangement(stored: unknown, offered: OfferedWidgets): OverviewArrangement {
  const entries = storedWidgets(stored);
  if (!entries) return { layout: defaultLayout(offered), kept: [] };
  const named = new Set(entries.map(({ id }) => id));
  const ids = new Set<string>(offered.map(({ id }) => id));
  const known = entries
    .filter(({ id }) => ids.has(id))
    .map(
      ({ hidden, ...entry }): OverviewPlacement => ({
        ...entry,
        id: entry.id as OverviewWidgetId,
        removed: hidden,
      }),
    );
  const bottom = bottomOf(known);
  const added = offered
    .filter(({ id }) => !named.has(id))
    .map(
      ({ id, place: at }, index): OverviewPlacement => ({
        ...at,
        id,
        x: 0,
        y: bottom + index,
        removed: false,
      }),
    );
  return {
    layout: settled([...known, ...added], offered, returning(known)),
    kept: entries.filter(({ id }) => !ids.has(id)),
  };
}

/** There is a stored value, and this build cannot read it: a later version's, or a broken one. */
export function isUnreadable(stored: unknown): boolean {
  return stored !== undefined && storedWidgets(stored) === null;
}

/** Reset is the only change that forgets the kept entries. */
export function changeArrangement(
  { layout, kept }: OverviewArrangement,
  change: OverviewLayoutChange,
  offered: OfferedWidgets,
): OverviewArrangement {
  return {
    layout: changeLayout(layout, change, offered),
    kept: change.kind === "reset" ? [] : kept,
  };
}

/** The kept entries come first: see `returning`. */
export function storeArrangement({ layout, kept }: OverviewArrangement): StoredOverviewLayout {
  return {
    version: LAYOUT_VERSION,
    widgets: [
      ...kept,
      ...layout.map(({ id, x, y, w, h, removed }) => ({ id, x, y, w, h, hidden: removed })),
    ],
  };
}

function storedWidgets(stored: unknown): readonly StoredWidget[] | null {
  const parsed = storedSchema.safeParse(stored);
  if (!parsed.success) return null;
  const { widgets } = parsed.data;
  return new Set(widgets.map(({ id }) => id)).size === widgets.length ? widgets : null;
}

/**
 * The widgets that are offered again after a save without them. The rest closed up over their
 * place, and only they are stored before what they overlap: they get the place back.
 */
function returning(known: readonly OverviewPlacement[]): OverviewWidgetId[] {
  const visible = known.filter(({ removed }) => !removed);
  return visible
    .filter((widget, index) => visible.slice(index + 1).some((other) => overlaps(widget, other)))
    .toSorted((a, b) => a.y - b.y)
    .map(({ id }) => id);
}
