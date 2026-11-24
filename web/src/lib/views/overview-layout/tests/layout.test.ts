import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeLayout,
  DEFAULT_LAYOUT,
  layoutChangeSchema,
  OVERVIEW_WIDGETS,
  type OverviewLayout,
  readLayout,
  sameLayout,
  stepChange,
  storeLayout,
  visibleWidgets,
} from "../domain/layout";

const places = (layout: OverviewLayout) =>
  Object.fromEntries(
    layout.map(({ id, x, y, w, h, hidden }) => [id, hidden ? "hidden" : [x, y, w, h]]),
  );
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
    assert.equal(readLayout(broken), DEFAULT_LAYOUT, JSON.stringify(broken));
});

test("an unknown widget is dropped; a missing one is at the end and visible", () => {
  const whole = storeLayout(DEFAULT_LAYOUT);
  const layout = readLayout({
    ...whole,
    widgets: [
      { id: "retired", x: 0, y: 0, w: 12, h: 5, hidden: false },
      ...whole.widgets.filter(({ id }) => id !== "metrics"),
    ],
  });
  assert.deepEqual(order(layout), ["topology", "health", "attention", "metrics"]);
  assert.deepEqual(places(layout).topology, [0, 0, 12, 9], "the gap it left is closed");
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
  assert.deepEqual(places(layout).metrics, [6, 0, 6, 3]);
});

test("hide closes the gap, and show puts the widget back where it was", () => {
  const hidden = changeLayout(DEFAULT_LAYOUT, { kind: "hide", widget: "topology" });
  assert.deepEqual(places(hidden), {
    metrics: [0, 0, 12, 3],
    health: [0, 3, 4, 7],
    attention: [4, 3, 8, 7],
    topology: "hidden",
  });
  const reread = readLayout(storeLayout(hidden));
  const shown = changeLayout(reread, { kind: "show", widget: "topology" });
  assert.deepEqual(order(shown).toSorted(), [...OVERVIEW_WIDGETS].toSorted());
  assert.equal(changeLayout(DEFAULT_LAYOUT, { kind: "hide", widget: "health" }).length, 4);
});

test("all widgets can be hidden", () => {
  const none = OVERVIEW_WIDGETS.reduce<OverviewLayout>(
    (layout, widget) => changeLayout(layout, { kind: "hide", widget }),
    DEFAULT_LAYOUT,
  );
  assert.deepEqual(visibleWidgets(none), []);
  assert.deepEqual(visibleWidgets(readLayout(storeLayout(none))), []);
});

test("move and resize are those of the grid; a hidden widget has no place to move", () => {
  const moved = changeLayout(DEFAULT_LAYOUT, { kind: "move", widget: "attention", x: 4, y: 0 });
  assert.deepEqual(places(moved).attention, [4, 0, 8, 7]);
  const resized = changeLayout(DEFAULT_LAYOUT, { kind: "resize", widget: "metrics", w: 1, h: 4 });
  assert.deepEqual(places(resized).metrics, [0, 0, 6, 4], "no smaller than its minimum");
  const hidden = changeLayout(DEFAULT_LAYOUT, { kind: "hide", widget: "health" });
  assert.ok(
    sameLayout(changeLayout(hidden, { kind: "move", widget: "health", x: 0, y: 0 }), hidden),
  );
});

test("arrange takes the browser's places, and leaves the hidden ones alone", () => {
  const hidden = changeLayout(DEFAULT_LAYOUT, { kind: "hide", widget: "health" });
  const arranged = changeLayout(hidden, {
    kind: "arrange",
    places: [
      { id: "attention", x: 0, y: 0, w: 12, h: 4 },
      { id: "metrics", x: 0, y: 4, w: 12, h: 3 },
      { id: "topology", x: 0, y: 7, w: 12, h: 9 },
      { id: "health", x: 0, y: 0, w: 12, h: 12 },
    ],
  });
  assert.deepEqual(order(arranged), ["attention", "metrics", "topology"]);
  assert.deepEqual(
    arranged.find(({ id }) => id === "health"),
    hidden.find(({ id }) => id === "health"),
  );
});

test("a keyboard step is an arrange, null with no room, and reset is the default", () => {
  const change = stepChange(DEFAULT_LAYOUT, "topology", "up");
  assert.ok(change);
  const layout = changeLayout(DEFAULT_LAYOUT, change);
  assert.deepEqual(order(layout), ["topology", "metrics", "health", "attention"]);
  assert.equal(stepChange(DEFAULT_LAYOUT, "metrics", "up"), null);
  assert.equal(changeLayout(layout, { kind: "reset" }), DEFAULT_LAYOUT);
});

test("a change from outside is checked", () => {
  assert.ok(layoutChangeSchema.safeParse({ kind: "hide", widget: "health" }).success);
  for (const bad of [
    { kind: "hide", widget: "spend" },
    { kind: "move", widget: "health", x: 12, y: 0 },
    { kind: "resize", widget: "health", w: 4, h: 25 },
    { kind: "explode" },
  ])
    assert.equal(layoutChangeSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
