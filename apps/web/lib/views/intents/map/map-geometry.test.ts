import assert from "node:assert/strict";
import { test } from "node:test";
import {
  centreOn,
  constrainView,
  fitTransform,
  labelWidth,
  lerpTransform,
  placeLabelChoices,
  radiusFor,
  restingLabelIds,
  zoomFloor,
} from "@/lib/views/intents/map/map-geometry";

test("a mono name is wider than a sans one", () => {
  assert.ok(labelWidth("ripgrep", 12, true) > labelWidth("ripgrep", 12));
});

test("at rest only the busiest share is labelled, at least a few", () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ id: `t${index}`, weight: index }));
  const resting = restingLabelIds(items);
  assert.equal(resting.size, 6, "15% of 40");
  assert.ok(resting.has("t39") && resting.has("t34") && !resting.has("t33"));
  assert.equal(restingLabelIds(items.slice(0, 5)).size, 3, "never fewer than three");
});

test("a label takes its first free spot, clear of other labels and of other circles", () => {
  const spot = (x: number, y: number, tag: string) => ({
    id: tag,
    x,
    y,
    width: 60,
    height: 16,
    tag,
  });
  const circles = [
    { id: "a", x: 100, y: 100, r: 20 },
    { id: "b", x: 100, y: 150, r: 20 },
  ];
  const placed = placeLabelChoices(
    [
      // Below "a" runs into circle "b"; above is free.
      { id: "a", owners: ["a"], spots: [spot(100, 131, "below"), spot(100, 69, "above")] },
      // Inside its own circle is fine: the owner does not block.
      { id: "b", owners: ["b"], spots: [spot(100, 150, "inside")] },
      // Every spot taken or off screen: left off.
      { id: "c", spots: [spot(100, 69, "clash"), spot(-10, 0, "off")] },
    ],
    circles,
    { width: 400, height: 300 },
  );
  assert.equal(placed.get("a")?.tag, "above");
  assert.equal(placed.get("b")?.tag, "inside");
  assert.equal(placed.has("c"), false);
  const lit = placeLabelChoices(
    [{ id: "a", owners: ["a"], blockers: new Set(["a"]), spots: [spot(100, 131, "below")] }],
    circles,
  );
  assert.equal(lit.get("a")?.tag, "below", "a lit label may sit over a dimmed circle");
  const brushing = placeLabelChoices(
    [{ id: "a", spots: [{ ...spot(100, 131, "inside"), owners: ["a", "b"] }] }],
    circles,
  );
  assert.equal(brushing.get("a")?.tag, "inside", "a spot may name its own owners");
  // Circles are soft; a warning badge is hard.
  const marks = [
    { id: "a", x: 100, y: 100, r: 20, soft: true },
    { id: "b", x: 100, y: 150, r: 20, soft: true },
    { id: "badge:c", x: 250, y: 150, r: 9 },
  ];
  const crowded = placeLabelChoices(
    [
      {
        id: "busy",
        owners: ["a"],
        fallback: true,
        spots: [spot(-40, 0, "off"), spot(100, 131, "over b"), spot(100, 69, "over nothing")],
      },
      {
        id: "quiet",
        owners: ["a"],
        fallback: true,
        spots: [
          spot(100, 72, "on busy's label"),
          spot(250, 150, "on a badge"),
          spot(100, 160, "over b too"),
        ],
      },
      { id: "plain", owners: ["a"], spots: [spot(100, 131, "over b")] },
    ],
    marks,
    { width: 400, height: 300 },
  );
  assert.equal(
    crowded.get("busy")?.tag,
    "over nothing",
    "a fallback label still prefers a clean spot",
  );
  assert.equal(
    crowded.get("quiet")?.tag,
    "over b too",
    "with none clean, it sits over a neighbour's circle, never on a label or a badge",
  );
  assert.equal(crowded.has("plain"), false, "without fallback a crowded label waits for a zoom");
  // Text drawn elsewhere (a group's name) is never covered, fallback or not.
  const named = placeLabelChoices(
    [{ id: "tool", fallback: true, spots: [spot(100, 69, "on the name"), spot(300, 69, "clear")] }],
    [],
    { width: 400, height: 300 },
    3,
    [{ id: "name:a", x: 100, y: 69, width: 80, height: 30 }],
  );
  assert.equal(named.get("tool")?.tag, "clear");
});

test("fit and fly-to keep the drawing in view", () => {
  const bounds = { minX: -110, minY: -60, maxX: 110, maxY: 60 };
  const fit = fitTransform(bounds, 800, 400, 20);
  assert.equal(fit.k, 2, "capped at the largest zoom");
  assert.equal(fit.x, 400);
  assert.equal(fit.y, 200);
  const small = fitTransform(bounds, 300, 200, 20);
  assert.ok(small.k < 2 && small.k > 1);
  assert.deepEqual(centreOn({ x: 10, y: 20 }, 200, 100, 2), { k: 2, x: 80, y: 10 });
  const from = { x: 0, y: 0, k: 1 };
  const to = { x: 100, y: 50, k: 2 };
  assert.deepEqual(lerpTransform(from, to, 0), from);
  assert.deepEqual(lerpTransform(from, to, 1), to);
  assert.ok(lerpTransform(from, to, 0.5).x > 50, "eases out: past halfway at half time");
});

test("radius tracks area, not the raw number", () => {
  const range = { min: 3, max: 9 };
  assert.equal(radiusFor(0, 100, range), 3);
  assert.equal(radiusFor(100, 100, range), 9);
  assert.equal(radiusFor(25, 100, range), 6, "a quarter of the calls is half the extra radius");
  assert.equal(radiusFor(5, 0, range), 3);
});

test("a drawing that fits stays whole in the view: it can be nudged, never pushed out", () => {
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  const view = { width: 400, height: 300 };
  // Dragged far left and up: the drawing's start stops at the view's edge.
  assert.deepEqual(constrainView({ x: -500, y: -400, k: 1 }, view, bounds), { x: 0, y: 0, k: 1 });
  // Dragged far right and down: its end stops at the other edge.
  assert.deepEqual(constrainView({ x: 900, y: 900, k: 1 }, view, bounds), { x: 300, y: 250, k: 1 });
  // Anywhere inside is left alone.
  assert.deepEqual(constrainView({ x: 120, y: 40, k: 1 }, view, bounds), { x: 120, y: 40, k: 1 });
});

test("a drawing larger than the view always fills part of it", () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const view = { width: 400, height: 200 };
  const far = constrainView({ x: -5000, y: 5000, k: 2 }, view, bounds);
  // Dragged off to the left: its right edge stays 35% into the view.
  assert.equal(far.x + 1000 * 2, 400 * 0.35);
  // Dragged off downwards: its top stays 35% from the bottom.
  assert.equal(far.y, 200 - 200 * 0.35);
  assert.equal(far.k, 2);
});

test("zooming out stops a little past the fitted view, and never below the hard floor", () => {
  assert.equal(zoomFloor(1), 0.8);
  assert.equal(zoomFloor(1.35), 1.08);
  assert.equal(zoomFloor(0.1), 0.08);
  assert.equal(zoomFloor(0.2), 0.16);
  assert.equal(zoomFloor(0.01), 0.01, "the fitted view is always reachable, even below the floor");
});
