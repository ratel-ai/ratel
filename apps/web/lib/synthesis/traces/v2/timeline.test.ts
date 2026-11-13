import assert from "node:assert/strict";
import { test } from "node:test";
import { NBSP } from "./format";
import {
  hasChildren,
  nearestVisible,
  timelineKeyMove,
  timelineShape,
  timeTicks,
  visibleRows,
} from "./timeline";

const plain = (text: string) => text.replaceAll(NBSP, " ");

// root
// ├─ model
// │  ├─ tool a
// │  └─ tool b
// └─ search
// orphan
const DEPTHS = [0, 1, 2, 2, 1, 0];

test("the tree shape comes from preorder depths in one pass", () => {
  const shape = timelineShape(DEPTHS);
  assert.deepEqual(shape.parent, [-1, 0, 1, 1, 0, -1]);
  assert.deepEqual(shape.subtreeEnd, [4, 3, 2, 3, 4, 5]);
  assert.equal(hasChildren(shape, 1), true);
  assert.equal(hasChildren(shape, 2), false);
});

test("a deep chain stays linear", () => {
  const depths = Array.from({ length: 5000 }, (_, index) => index);
  const started = performance.now();
  const shape = timelineShape(depths);
  assert.equal(shape.subtreeEnd[0], 4999);
  assert.ok(performance.now() - started < 200, "5,000 nested spans shape quickly");
});

test("collapsing a span hides its subtree and nothing else", () => {
  const shape = timelineShape(DEPTHS);
  assert.deepEqual(visibleRows(shape, new Set()), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(visibleRows(shape, new Set([1])), [0, 1, 4, 5]);
  assert.deepEqual(visibleRows(shape, new Set([0])), [0, 5]);
  assert.equal(
    nearestVisible(shape, new Set([1]), 3),
    1,
    "a hidden selection surfaces at its collapsed ancestor",
  );
  assert.equal(nearestVisible(shape, new Set([0, 1]), 3), 0);
});

test("the keyboard walks the tree like a tree view", () => {
  const shape = timelineShape(DEPTHS);
  const open = new Set<number>();
  assert.deepEqual(timelineKeyMove("ArrowDown", 0, shape, open), { select: 1 });
  assert.deepEqual(timelineKeyMove("ArrowUp", 0, shape, open), { select: 0 }, "the top stays put");
  assert.deepEqual(
    timelineKeyMove("ArrowLeft", 1, shape, open),
    { toggle: 1 },
    "left closes an open span",
  );
  assert.deepEqual(
    timelineKeyMove("ArrowLeft", 2, shape, open),
    { select: 1 },
    "left on a leaf goes to its parent",
  );
  assert.deepEqual(
    timelineKeyMove("ArrowRight", 1, shape, new Set([1])),
    { toggle: 1 },
    "right opens a closed span",
  );
  assert.deepEqual(
    timelineKeyMove("ArrowRight", 1, shape, open),
    { select: 2 },
    "right on an open span steps in",
  );
  assert.equal(timelineKeyMove("ArrowRight", 2, shape, open), null);
  assert.deepEqual(
    timelineKeyMove("ArrowDown", 1, shape, new Set([1])),
    { select: 4 },
    "down skips a closed subtree",
  );
  assert.deepEqual(timelineKeyMove("End", 0, shape, open), { select: 5 });
  assert.equal(timelineKeyMove("x", 0, shape, open), null);
});

test("axis ticks land on clean steps from zero to the run's duration", () => {
  assert.deepEqual(
    timeTicks(2772).map((tick) => tick.label.replaceAll("\u00a0", " ")),
    ["0 ms", "1 s", "2 s"],
  );
  assert.deepEqual(
    timeTicks(1000).map((tick) => [plain(tick.label), tick.ratio]),
    [
      ["0 ms", 0],
      ["500 ms", 0.5],
      ["1 s", 1],
    ],
  );
  assert.deepEqual(
    timeTicks(181).map((tick) => plain(tick.label)),
    ["0 ms", "50 ms", "100 ms", "150 ms"],
  );
  assert.deepEqual(
    timeTicks(0).map((tick) => tick.ratio),
    [0],
    "a zero-length run still has an origin",
  );
});
