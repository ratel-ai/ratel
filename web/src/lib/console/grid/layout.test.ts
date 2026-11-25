import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compacted,
  type GridItem,
  inReadingOrder,
  movedTo,
  resizedTo,
  stepped,
} from "@/lib/console/grid/layout";

const MIN = { w: 2, h: 2 };
/** One wide card over two side by side. */
const ITEMS: GridItem[] = [
  { id: "top", x: 0, y: 0, w: 12, h: 3 },
  { id: "left", x: 0, y: 3, w: 4, h: 6 },
  { id: "right", x: 4, y: 3, w: 8, h: 6 },
];

const places = (items: GridItem[] | null) =>
  Object.fromEntries((items ?? []).map(({ id, x, y, w, h }) => [id, [x, y, w, h]]));

test("compaction closes the gaps above and leaves no overlap", () => {
  assert.deepEqual(places(compacted(ITEMS.slice(1))), { left: [0, 0, 4, 6], right: [4, 0, 8, 6] });
  assert.deepEqual(
    places(
      compacted([
        { id: "a", x: 0, y: 0, w: 6, h: 2 },
        { id: "b", x: 0, y: 1, w: 6, h: 2 },
      ]),
    ),
    { a: [0, 0, 6, 2], b: [0, 2, 6, 2] },
  );
});

test("a move puts the item where it was dropped and the others make room", () => {
  assert.deepEqual(places(movedTo(ITEMS, "top", { x: 0, y: 6 })), {
    top: [0, 6, 12, 3],
    left: [0, 0, 4, 6],
    right: [4, 0, 8, 6],
  });
  assert.deepEqual(places(movedTo(ITEMS, "left", { x: 0, y: 0 })), {
    left: [0, 0, 4, 6],
    top: [0, 6, 12, 3],
    right: [4, 9, 8, 6],
  });
  assert.equal(movedTo(ITEMS, "unknown", { x: 0, y: 0 }), null);
  // Outside the grid: held at its edge.
  assert.deepEqual(places(movedTo(ITEMS, "right", { x: 40, y: 3 })), places(ITEMS));
});

test("a resize stays between the minimum and the grid, and pushes what it covers", () => {
  assert.deepEqual(places(resizedTo(ITEMS, "left", { w: 6, h: 1 }, MIN)), {
    top: [0, 0, 12, 3],
    left: [0, 3, 6, 2],
    right: [4, 5, 8, 6],
  });
  assert.deepEqual(places(resizedTo(ITEMS, "right", { w: 99, h: 99 }, MIN))?.right, [0, 3, 12, 24]);
});

test("one keyboard step changes places with the neighbor, and null when there is no room", () => {
  assert.deepEqual(places(stepped(ITEMS, "top", "down", MIN)), {
    top: [0, 6, 12, 3],
    left: [0, 0, 4, 6],
    right: [4, 0, 8, 6],
  });
  assert.deepEqual(places(stepped(ITEMS, "right", "left", MIN)), {
    top: [0, 0, 12, 3],
    right: [0, 3, 8, 6],
    left: [8, 3, 4, 6],
  });
  assert.equal(stepped(ITEMS, "top", "up", MIN), null);
  assert.equal(stepped(ITEMS, "top", "left", MIN), null);
  assert.equal(stepped(ITEMS, "top", "wider", MIN), null);
  assert.deepEqual(places(stepped(ITEMS, "right", "wider", MIN))?.right, [3, 3, 9, 6]);
  assert.equal(stepped(compacted([{ ...ITEMS[0], w: 2, h: 2 }]), "top", "shorter", MIN), null);
});

test("reading order is rows, then columns", () => {
  assert.deepEqual(
    inReadingOrder(ITEMS.toReversed()).map(({ id }) => id),
    ["top", "left", "right"],
  );
});
