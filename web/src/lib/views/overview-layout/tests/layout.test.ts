import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeLayout,
  DEFAULT_LAYOUT,
  type OfferedWidgets,
  OVERVIEW_WIDGETS,
  type OverviewLayout,
  type OverviewLayoutChange,
  type OverviewWidgetId,
  sameLayout,
  stepChange,
  visibleWidgets,
  WIDGET_CATALOG,
} from "../domain/layout";
import {
  changeArrangement,
  layoutChangeSchema,
  readArrangement,
  storeArrangement,
} from "../domain/stored";

const places = (layout: OverviewLayout) =>
  Object.fromEntries(
    layout.map(({ id, x, y, w, h, removed }) => [id, removed ? "removed" : [x, y, w, h]]),
  );
const readLayout = (stored: unknown) => readArrangement(stored, WIDGET_CATALOG).layout;
const storeLayout = (layout: OverviewLayout) => storeArrangement({ layout, kept: [] });
const order = (layout: OverviewLayout) => visibleWidgets(layout).map(({ id }) => id);

test("the default: Metrics, then Topology, then Health with Needs attention beside it", () => {
  assert.deepEqual(order(DEFAULT_LAYOUT), ["metrics", "topology", "health", "attention"]);
  const [metrics, topology, health, attention] = DEFAULT_LAYOUT;
  assert.deepEqual([metrics.w, topology.w, health.w + attention.w], [12, 12, 12]);
  assert.deepEqual([attention.y, attention.h], [health.y, health.h]);
  assert.ok(sameLayout(readLayout(storeLayout(DEFAULT_LAYOUT)), DEFAULT_LAYOUT));
});

test("a layout that cannot be read is the default", () => {
  const whole = storeLayout(DEFAULT_LAYOUT);
  const [first, ...rest] = whole.widgets;
  for (const broken of [
    null,
    undefined,
    "text",
    [],
    {},
    { ...whole, version: 2 },
    { ...whole, widgets: "none" },
    { ...whole, widgets: [{ ...first, x: -1 }, ...rest] },
    { ...whole, widgets: [{ ...first, w: 1.5 }, ...rest] },
    { ...whole, widgets: [{ ...first, hidden: "yes" }, ...rest] },
    { ...whole, widgets: [first, first, ...rest] },
  ])
    assert.deepEqual(readLayout(broken), DEFAULT_LAYOUT, JSON.stringify(broken));
});

test("a widget that is not offered is not drawn; a missing one is at the end and visible", () => {
  const whole = storeLayout(DEFAULT_LAYOUT);
  const layout = readLayout({
    ...whole,
    widgets: [
      { id: "retired", x: 0, y: 0, w: 12, h: 5, hidden: false },
      ...whole.widgets.filter(({ id }) => id !== "metrics"),
    ],
  });
  assert.deepEqual(order(layout), ["topology", "health", "attention", "metrics"]);
  assert.deepEqual(places(layout).topology, [0, 0, 12, 8], "nothing is left free for it");
  // With nothing known, all of them are new.
  assert.deepEqual(
    order(readLayout({ version: 1, widgets: [] })).toSorted(),
    [...OVERVIEW_WIDGETS].toSorted(),
  );
});

test("a stored size below the minimum, or over the edge, is made whole", () => {
  const whole = storeLayout(DEFAULT_LAYOUT);
  const layout = readLayout({
    ...whole,
    widgets: whole.widgets.map((widget) =>
      widget.id === "metrics" ? { ...widget, x: 10, w: 2, h: 1 } : widget,
    ),
  });
  assert.deepEqual(places(layout).metrics, [4, 0, 8, 4]);
});

test("remove closes the gap, and add puts the widget back where it was", () => {
  const gone = changeLayout(DEFAULT_LAYOUT, { kind: "remove", widget: "topology" });
  assert.deepEqual(places(gone), {
    metrics: [0, 0, 12, 4],
    health: [0, 4, 4, 7],
    attention: [4, 4, 8, 7],
    topology: "removed",
  });
  const reread = readLayout(storeLayout(gone));
  const back = changeLayout(reread, { kind: "add", widget: "topology" });
  assert.deepEqual(places(back), places(DEFAULT_LAYOUT));
  assert.equal(changeLayout(DEFAULT_LAYOUT, { kind: "remove", widget: "health" }).length, 4);
});

test("all widgets can be removed", () => {
  const none = OVERVIEW_WIDGETS.reduce<OverviewLayout>(
    (layout, widget) => changeLayout(layout, { kind: "remove", widget }),
    DEFAULT_LAYOUT,
  );
  assert.deepEqual(visibleWidgets(none), []);
  assert.deepEqual(visibleWidgets(readLayout(storeLayout(none))), []);
});

test("move and resize are those of the grid; a removed widget has no place to move", () => {
  const moved = changeLayout(DEFAULT_LAYOUT, { kind: "move", widget: "attention", x: 4, y: 0 });
  assert.deepEqual(places(moved).attention, [4, 0, 8, 7]);
  const resized = changeLayout(DEFAULT_LAYOUT, { kind: "resize", widget: "metrics", w: 1, h: 1 });
  assert.deepEqual(places(resized).metrics, [0, 0, 8, 4], "no smaller than its minimum");
  const gone = changeLayout(DEFAULT_LAYOUT, { kind: "remove", widget: "health" });
  assert.ok(sameLayout(changeLayout(gone, { kind: "move", widget: "health", x: 0, y: 0 }), gone));
});

test("arrange takes the browser's places, and leaves the removed ones alone", () => {
  const gone = changeLayout(DEFAULT_LAYOUT, { kind: "remove", widget: "health" });
  const arranged = changeLayout(gone, {
    kind: "arrange",
    places: [
      { id: "attention", x: 0, y: 0, w: 12, h: 4 },
      { id: "metrics", x: 0, y: 4, w: 12, h: 4 },
      { id: "topology", x: 0, y: 8, w: 12, h: 8 },
      { id: "health", x: 0, y: 0, w: 12, h: 12 },
    ],
  });
  assert.deepEqual(order(arranged), ["attention", "metrics", "topology"]);
  assert.deepEqual(
    arranged.find(({ id }) => id === "health"),
    gone.find(({ id }) => id === "health"),
  );
});

test("a keyboard step is an arrange, null with no room, and reset is the default", () => {
  const change = stepChange(DEFAULT_LAYOUT, "topology", "up");
  assert.ok(change);
  const layout = changeLayout(DEFAULT_LAYOUT, change);
  assert.deepEqual(order(layout), ["topology", "metrics", "health", "attention"]);
  assert.equal(stepChange(DEFAULT_LAYOUT, "metrics", "up"), null);
  assert.deepEqual(changeLayout(layout, { kind: "reset" }), DEFAULT_LAYOUT);
});

test("a change from outside is checked", () => {
  assert.ok(
    layoutChangeSchema(WIDGET_CATALOG).safeParse({ kind: "remove", widget: "health" }).success,
  );
  for (const bad of [
    { kind: "remove", widget: "spend" },
    { kind: "move", widget: "health", x: 12, y: 0 },
    { kind: "resize", widget: "health", w: 4, h: 25 },
    { kind: "explode" },
  ])
    assert.equal(
      layoutChangeSchema(WIDGET_CATALOG).safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
});

/* A later widget, behind a flag. */

const ALERTS = "alerts" as OverviewWidgetId;
const FIVE: OfferedWidgets = [
  ...WIDGET_CATALOG,
  { id: ALERTS, min: { w: 3, h: 3 }, place: { x: 0, y: 19, w: 6, h: 4 } },
];
/** One visit: the page reads the row, a person changes it, the row is saved. */
const visit = (row: unknown, offered: OfferedWidgets, ...changes: OverviewLayoutChange[]) =>
  storeArrangement(
    changes.reduce(
      (at, change) => changeArrangement(at, change, offered),
      readArrangement(row, offered),
    ),
  );
const drawn = (row: unknown, offered: OfferedWidgets) =>
  places(readArrangement(row, offered).layout);
/** Topology removed, Needs attention on top: somebody's own page. */
const ARRANGED = visit(
  undefined,
  WIDGET_CATALOG,
  { kind: "remove", widget: "topology" },
  { kind: "move", widget: "attention", x: 4, y: 0 },
);

test("a fifth widget joins at the bottom one time, and the rest stays", () => {
  const { alerts, ...rest } = drawn(ARRANGED, FIVE);
  assert.deepEqual(rest, drawn(ARRANGED, WIDGET_CATALOG));
  const bottom = readArrangement(ARRANGED, FIVE).layout.filter(({ removed }) => !removed);
  assert.equal(bottom.at(-1)?.id, ALERTS);
  assert.ok(Array.isArray(alerts));
  const saved = visit(ARRANGED, FIVE, { kind: "add", widget: "topology" });
  assert.equal(saved.widgets.filter(({ id }) => id === ALERTS).length, 1);
  assert.deepEqual(drawn(saved, FIVE), drawn(visit(saved, FIVE), FIVE));
});

test("a removed fifth widget stays removed", () => {
  const saved = visit(ARRANGED, FIVE, { kind: "remove", widget: ALERTS });
  assert.equal(drawn(saved, FIVE).alerts, "removed");
  assert.equal(
    drawn(visit(saved, FIVE, { kind: "add", widget: "topology" }), FIVE).alerts,
    "removed",
  );
});

test("off and on: a removed widget stays removed, also after saves without it", () => {
  const saved = visit(ARRANGED, FIVE, { kind: "remove", widget: ALERTS });
  const without = visit(saved, WIDGET_CATALOG, { kind: "add", widget: "topology" });
  assert.equal(drawn(without, WIDGET_CATALOG).alerts, undefined);
  assert.equal(drawn(without, FIVE).alerts, "removed");
});

test("off and on: a placed widget gets its place back from what closed up over it", () => {
  for (const widget of OVERVIEW_WIDGETS) {
    const off = WIDGET_CATALOG.filter(({ id }) => id !== widget);
    const saved = visit(undefined, off);
    assert.equal(drawn(saved, off)[widget], undefined);
    const row = visit(visit(undefined, WIDGET_CATALOG), off);
    assert.deepEqual(drawn(row, WIDGET_CATALOG), places(DEFAULT_LAYOUT), widget);
    // A change elsewhere, while it is off.
    const other = off.at(-1)?.id as OverviewWidgetId;
    const changed = visit(
      row,
      off,
      { kind: "remove", widget: other },
      { kind: "add", widget: other },
    );
    assert.deepEqual(
      drawn(changed, WIDGET_CATALOG)[widget],
      places(DEFAULT_LAYOUT)[widget],
      widget,
    );
  }
});

test("two builds at once: each saves, and neither loses what the other placed", () => {
  const placed = visit(undefined, FIVE, { kind: "move", widget: ALERTS, x: 6, y: 0 });
  const older = visit(placed, WIDGET_CATALOG, { kind: "remove", widget: "health" });
  const newer = drawn(older, FIVE);
  assert.deepEqual(newer.alerts, [6, 0, 6, 4]);
  assert.equal(newer.health, "removed");
});

test("reset is the default of the offered widgets, and forgets the kept entries", () => {
  const saved = visit(ARRANGED, FIVE, { kind: "remove", widget: ALERTS });
  const reset = visit(saved, WIDGET_CATALOG, { kind: "reset" });
  assert.deepEqual(reset, storeLayout(DEFAULT_LAYOUT));
  assert.ok(Array.isArray(drawn(reset, FIVE).alerts), "the fifth joins as new");
  assert.deepEqual(
    places(changeLayout(DEFAULT_LAYOUT, { kind: "reset" }, FIVE)).alerts,
    [0, 19, 6, 4],
  );
});

test("a change for a widget that is not offered is refused; an open page's places are not", () => {
  const schema = layoutChangeSchema(WIDGET_CATALOG);
  assert.equal(schema.safeParse({ kind: "add", widget: ALERTS }).success, false);
  const drag = { kind: "arrange", places: [{ id: ALERTS, x: 0, y: 0, w: 6, h: 4 }] };
  assert.ok(schema.safeParse(drag).success);
  assert.ok(layoutChangeSchema(FIVE).safeParse({ kind: "add", widget: ALERTS }).success);
});
