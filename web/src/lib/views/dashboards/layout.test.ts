import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compacted as compactedItems,
  movedTo,
  resizedTo,
  stepped,
} from "@/lib/console/grid/layout";
import {
  cardOf,
  compacted,
  freePosition,
  gridPositionSchema,
  inReadingOrder,
  layoutsOf,
  MIN_WIDGET,
} from "@/lib/views/dashboards/layout";

test("overlaps and gaps go; nothing is lost", () => {
  const packed = compacted([
    at("a", 0, 0, 6, 6),
    at("b", 4, 0, 6, 4),
    at("c", 0, 20, 3, 2),
    at("d", 0, 0, 6, 6),
  ]);
  assert.deepEqual(
    packed.map(({ id }) => id),
    ["a", "b", "c", "d"],
  );
  for (const one of packed)
    for (const two of packed)
      if (one !== two)
        assert.ok(
          one.layout.x >= two.layout.x + two.layout.w ||
            two.layout.x >= one.layout.x + one.layout.w ||
            one.layout.y >= two.layout.y + two.layout.h ||
            two.layout.y >= one.layout.y + one.layout.h,
        );
});

test("a new widget takes the first free place", () => {
  assert.deepEqual(freePosition([]), { x: 0, y: 0, w: 6, h: 6 });
  assert.deepEqual(freePosition([at("a", 0, 0, 6, 6)]), { x: 6, y: 0, w: 6, h: 6 });
  assert.deepEqual(freePosition([at("a", 0, 0, 7, 6)]), { x: 0, y: 6, w: 6, h: 6 });
});

test("the stored places are the places of the cards, in and out of edit mode", () => {
  const stored = [at("a", 0, 0, 6, 6), at("b", 6, 0, 6, 4), at("c", 6, 4, 6, 2)];
  const cards = stored.map(cardOf);
  assert.deepEqual(
    cards.map(({ id, x, y, w, h }) => ({ id, layout: { x, y, w, h } })),
    stored,
  );
  // What edit mode draws, and what it saves when nothing was dragged.
  assert.deepEqual(
    layoutsOf(compactedItems(cards)),
    Object.fromEntries(stored.map(({ id, layout }) => [id, layout])),
  );
  assert.deepEqual(compacted(stored), stored, "a save of them changes nothing");
});

test("a drag, a resize and a step are the shared grid's, and a save keeps them", () => {
  const row = [at("a", 0, 0, 6, 6), at("b", 6, 0, 6, 6), at("c", 0, 6, 12, 4)];
  const cards = row.map(cardOf);
  for (const items of [
    movedTo(cards, "c", { x: 0, y: 0 }),
    resizedTo(cards, "a", { w: 4, h: 8 }, MIN_WIDGET),
    stepped(cards, "a", "right", MIN_WIDGET),
    stepped(cards, "a", "taller", MIN_WIDGET),
    stepped(cards, "b", "wider", MIN_WIDGET),
  ]) {
    assert.ok(items);
    const layouts = layoutsOf(items);
    assert.notDeepEqual(layouts, layoutsOf(cards));
    const saved = compacted(row.map((widget) => ({ ...widget, layout: layouts[widget.id] })));
    assert.deepEqual(layoutsOf(saved.map(cardOf)), layouts);
    for (const { layout } of saved) assert.ok(gridPositionSchema.safeParse(layout).success);
  }
  assert.deepEqual(layoutsOf(stepped(cards, "a", "right", MIN_WIDGET) ?? []), {
    a: { x: 6, y: 0, w: 6, h: 6 },
    b: { x: 0, y: 0, w: 6, h: 6 },
    c: { x: 0, y: 6, w: 12, h: 4 },
  });
  assert.equal(stepped(cards, "c", "wider", MIN_WIDGET), null);
});

test("a widget that comes back keeps its place, and what it covers goes below", () => {
  assert.deepEqual(compacted([at("a", 0, 0, 12, 6), at("b", 0, 0, 6, 4)], "b"), [
    at("a", 0, 4, 12, 6),
    at("b", 0, 0, 6, 4),
  ]);
});

test("a narrow screen reads rows, then columns", () => {
  const order = inReadingOrder([at("c", 0, 6), at("b", 6, 0), at("a", 0, 0)]);
  assert.deepEqual(
    order.map(({ id }) => id),
    ["a", "b", "c"],
  );
});

test("a place is whole cells inside the 12 columns", () => {
  const ok = (place: object) => gridPositionSchema.safeParse(place).success;
  assert.ok(ok({ x: 6, y: 0, w: 6, h: 2 }));
  for (const bad of [
    { x: 7, y: 0, w: 6, h: 2 },
    { x: 0.5, y: 0, w: 6, h: 2 },
    { x: -1, y: 0, w: 6, h: 2 },
    { x: 0, y: 0, w: 1, h: 2 },
    { x: 0, y: 0, w: 6, h: 99 },
    { x: 0, y: 0, w: 6 },
  ])
    assert.ok(!ok(bad), JSON.stringify(bad));
});

function at(id: string, x: number, y: number, w = 6, h = 6) {
  return { id, layout: { x, y, w, h } };
}
