import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blobOutline,
  seededRandom,
  signedDistance,
  smoothClosedCurve,
} from "@/lib/views/intents/map/map-blobs";
import { estimateMeasure, type Measure } from "@/lib/views/intents/map/map-geometry";
import {
  type FittedName,
  fitName,
  fitNameShrinking,
  isCutName,
  lineWidths,
  NAME_LINE_HEIGHT,
  NAME_MAX_PX,
  NAME_MIN_CHARS,
  NAME_MIN_PX,
  NAME_SIZE,
  nameCircle,
  nameFontAt,
  nameRoom,
  nameSize,
  poleOf,
} from "@/lib/views/intents/map/map-names";

/** Text widths at `size`, from the 12 px estimate the map falls back to. */
const at = (size: number): Measure => {
  const twelve = estimateMeasure(12);
  return (text) => (twelve(text) * size) / 12;
};

/** Every line's box, centred as a block on the circle's centre, lies inside the circle. */
function insideCircle(name: FittedName, radius: number, measure: Measure): boolean {
  return name.lines.every((line, index) => {
    const middle = (index - (name.lines.length - 1) / 2) * name.lineHeight;
    const halfWidth = measure(line) / 2;
    const far = Math.abs(middle) + name.lineHeight / 2;
    return Math.hypot(halfWidth, far) <= radius + 1e-9;
  });
}

test("a name's size is in map units, larger for busier groups", () => {
  const range = { min: 22, max: 64 };
  assert.equal(nameSize(22, range), NAME_SIZE.min);
  assert.equal(nameSize(64, range), NAME_SIZE.max);
  assert.equal(nameSize(43, range), (NAME_SIZE.min + NAME_SIZE.max) / 2);
  assert.equal(nameSize(10, range), NAME_SIZE.min, "clamped");
});

test("names shrink as the map zooms out, are hidden below a readable size, and stop growing when zoomed in", () => {
  // Between the two limits the name keeps its map size: it scales with the drawing.
  assert.equal(nameFontAt(14, 1), 14);
  assert.equal(nameFontAt(14, 0.8), 14, "14 map units at 0.8 is 11.2 px on screen, still readable");
  assert.equal(
    nameFontAt(14, NAME_MIN_PX / 14 - 0.01),
    null,
    "below the readable size: hidden, not shrunk past reading",
  );
  assert.equal(
    nameFontAt(20, 2),
    NAME_MAX_PX / 2,
    "zoomed in, capped on screen, so more of it fits",
  );
  assert.equal(nameFontAt(14, 0), null);
});

test("a name wraps to the circle's width, fewest lines first", () => {
  const measure = at(12);
  const one = fitName("Create a task", 60, 12, measure)!;
  assert.deepEqual(one.lines, ["Create a task"]);
  const two = fitName("Search the codebase", 40, 12, measure)!;
  assert.deepEqual(two.lines, ["Search the", "codebase"]);
  assert.equal(two.lineHeight, 12 * NAME_LINE_HEIGHT);
  assert.ok(insideCircle(two, 40, measure));
  const balanced = fitName("Find where this function is defined", 70, 12, measure)!;
  assert.deepEqual(
    balanced.lines,
    ["Find where this", "function is defined"],
    "broken where the lines fill most evenly, not greedily",
  );
});

test("a name too long for its room ends in an ellipsis, and every line still fits", () => {
  const measure = at(12);
  const cut = fitName("find where this function is defined in the codebase", 34, 12, measure)!;
  assert.ok(cut.lines.length >= 1);
  assert.match(cut.lines.at(-1)!, /…$/u, "the last line ends in an ellipsis");
  assert.ok(insideCircle(cut, 34, measure));
  const word = fitName("Supercalifragilisticexpialidocious", 24, 12, measure)!;
  assert.deepEqual(word.lines.length, 1);
  assert.match(
    word.lines[0]!,
    /^Supe\S*…$/u,
    "a word wider than the room is cut, keeping its start",
  );
  assert.ok(insideCircle(word, 24, measure));
});

test("a name is hidden, never spilled, when not even a few letters fit", () => {
  const measure = at(12);
  assert.equal(fitName("Create a task", 8, 12, measure), null, "the room is smaller than a line");
  assert.equal(
    fitName("Refund a charge", 14, 12, measure),
    null,
    `fewer than ${NAME_MIN_CHARS} letters would fit`,
  );
  assert.equal(fitName("", 40, 12, measure), null);
  assert.equal(fitName("Create", 40, 0, measure), null);
  assert.deepEqual(lineWidths(1, 5, 15, 2), null, "a line taller than the circle has no width");
});

test("whatever the name, room and size, the lines never leave the circle", () => {
  const random = seededRandom(11);
  const words = [
    "find",
    "an",
    "order",
    "supercalifragilistic",
    "deploy",
    "to",
    "staging",
    "PR",
    "the",
    "customer",
    "x",
  ];
  let shown = 0;
  for (let run = 0; run < 400; run += 1) {
    const text = Array.from(
      { length: 1 + Math.floor(random() * 8) },
      () => words[Math.floor(random() * words.length)]!,
    ).join(" ");
    const radius = 6 + random() * 70;
    const size = 6 + random() * 18;
    const measure = at(size);
    const name = fitName(text, radius, size, measure);
    if (!name) continue;
    shown += 1;
    assert.ok(
      insideCircle(name, radius, measure),
      `"${text}" at ${size.toFixed(1)} in ${radius.toFixed(1)}: ${JSON.stringify(name.lines)}`,
    );
    assert.ok(name.lines.length <= 3);
    const letters = name.lines.join("").replace(/[\s…]/gu, "").length;
    assert.ok(letters >= Math.min(NAME_MIN_CHARS, text.replace(/\s/gu, "").length), "never a stub");
  }
  assert.ok(shown > 100, "most of them show");
});

test("the room shrinks around a warning mark, more as the map zooms out", () => {
  const name = { x: 0, y: 0, r: 30 };
  const badge = { x: 0, y: -40 };
  assert.equal(nameRoom(name, null, 9, 1), 30);
  assert.ok(
    Math.abs(nameRoom(name, badge, 9, 1) - 28) < 1e-9,
    "40 away, less the mark's 9 and the margin",
  );
  assert.ok(
    nameRoom(name, badge, 9, 0.5) < nameRoom(name, badge, 9, 1),
    "the mark is larger in map units when zoomed out",
  );
});

test("the visual centre: the middle of a round blob, away from its tools and from a blob that overlaps it", () => {
  const square = poleOf(
    { minX: 0, minY: 0, maxX: 100, maxY: 60 },
    (point) => Math.min(point.x, 100 - point.x, point.y, 60 - point.y),
    0.25,
  );
  assert.ok(Math.abs(square.r - 30) < 0.5 && Math.abs(square.y - 30) < 0.5);

  const centre = { x: 100, y: 100 };
  const round = blobOutline("intent_1", centre, [{ ...centre, r: 50 }]);
  const alone = nameCircle(round, [], []);
  assert.ok(
    Math.hypot(alone.x - 100, alone.y - 100) < 4,
    "a lone round blob names itself in the middle",
  );

  // Tools along the lower edge push the name up; a neighbour overlapping on the right pushes it left.
  const tools = [
    { x: 100, y: 140, r: 7 },
    { x: 88, y: 137, r: 5 },
  ];
  const neighbour = blobOutline("intent_2", { x: 185, y: 100 }, [{ x: 185, y: 100, r: 50 }]);
  const held = nameCircle(round, tools, [neighbour]);
  assert.ok(held.y < 100 && held.x < 100);
  const outline = smoothClosedCurve(round.points, 16);
  for (let step = 0; step < 32; step += 1) {
    const angle = (step / 32) * Math.PI * 2;
    const point = { x: held.x + Math.cos(angle) * held.r, y: held.y + Math.sin(angle) * held.r };
    assert.ok(signedDistance(point, outline) > 0, "the name's room is inside its blob");
    assert.ok(signedDistance(point, neighbour.points) < 0, "and outside the neighbour");
    for (const tool of tools)
      assert.ok(
        Math.hypot(point.x - tool.x, point.y - tool.y) >= tool.r - 1e-6,
        "and off its tools",
      );
  }
});

test("a name fitted into its room never leaves the blob, at any zoom", () => {
  const centre = { x: 0, y: 0 };
  const blob = blobOutline("intent_67", centre, [
    { ...centre, r: 58 },
    { x: 10, y: 40, r: 12 },
  ]);
  const room = nameCircle(blob, [{ x: 10, y: 40, r: 9 }], []);
  const outline = smoothClosedCurve(blob.points, 16);
  for (const k of [0.6, 0.8, 1, 1.5, 2.5, 4]) {
    const size = nameFontAt(18, k);
    if (size === null) continue;
    const measure = at(size);
    const name = fitName(
      "Find where this function is defined in the codebase",
      room.r,
      size,
      measure,
    );
    if (!name) continue;
    name.lines.forEach((line, index) => {
      const middle = room.y + (index - (name.lines.length - 1) / 2) * name.lineHeight;
      const half = measure(line) / 2;
      for (const corner of [
        { x: room.x - half, y: middle - name.lineHeight / 2 },
        { x: room.x + half, y: middle - name.lineHeight / 2 },
        { x: room.x - half, y: middle + name.lineHeight / 2 },
        { x: room.x + half, y: middle + name.lineHeight / 2 },
      ]) {
        assert.ok(signedDistance(corner, outline) > 0, `at zoom ${k}, "${line}" stays inside`);
      }
    });
  }
});

test("a name tries smaller sizes before it is cut, down to the floor", () => {
  const name = "Inspection scheduling";
  const wholeAt = (size: number): number | null => {
    for (let r = 10; r <= 120; r += 1) {
      const fitted = fitName(name, r, size, at(size));
      if (fitted && !isCutName(fitted)) return r;
    }
    return null;
  };
  const room = wholeAt(10)!;
  assert.ok(room < wholeAt(12)!, "smaller text needs less room");
  assert.ok(isCutName(fitName(name, room, 12, at(12))!), "cut at its own size");
  const shrunk = fitNameShrinking(name, room, 12, 10, at, 0.5)!;
  assert.equal(isCutName(shrunk), false, "whole at a smaller size");
  assert.ok(shrunk.fontSize < 12 && shrunk.fontSize >= 10);
  const tight = fitNameShrinking(name, room - 4, 12, 10, at, 0.5);
  assert.ok(
    tight === null || tight.fontSize === 12,
    "no smaller size holds it whole: cut at its own size",
  );
  assert.equal(
    fitNameShrinking("Create a task", 60, 12, 10, at, 0.5)!.fontSize,
    12,
    "fits at its own size: kept",
  );
});
