import assert from "node:assert/strict";
import { test } from "node:test";
import {
  maskImage,
  maskPath,
  VEIL_LOOPS,
  VEIL_MS,
  VEIL_SHAPES,
  type VeilShapeName,
} from "../src/components/veil-shape-model";

const NAMES = Object.keys(VEIL_SHAPES) as VeilShapeName[];
const drawn = (name: VeilShapeName) =>
  VEIL_SHAPES[name].rows.flatMap((row, y) =>
    [...row].flatMap((cell, x) => (cell === "#" ? [`${x},${y}`] : [])),
  );

test("the mask has a square for each cell of the picture, and only those", () => {
  for (const name of NAMES) {
    const cells = [...maskPath(name).matchAll(/M(\d+) (\d+)/g)].map(([, x, y]) => `${x},${y}`);
    assert.deepEqual(cells, drawn(name), name);
    const { width, rows } = VEIL_SHAPES[name];
    for (const row of rows) assert.ok(row.length <= width, name);
  }
});

test("the mask is the same on a server and in a browser, and a valid CSS url", () => {
  for (const name of NAMES) {
    assert.equal(maskImage(name), maskImage(name));
    const [, data] = maskImage(name).match(/^url\("data:image\/svg\+xml,(.*)"\)$/) ?? [];
    assert.ok(data, name);
    assert.doesNotMatch(data, /["\s<>#]/, "escaped");
    const svg = decodeURIComponent(data);
    const { width, rows } = VEIL_SHAPES[name];
    assert.match(svg, new RegExp(`viewBox="0 0 ${width} ${rows.length}"`));
  }
  assert.notEqual(maskImage("bell"), maskImage("gauge"));
});

test("it stops by itself, at rest, well within a minute", () => {
  assert.ok(Number.isInteger(VEIL_LOOPS) && VEIL_LOOPS >= 1);
  assert.ok(VEIL_MS * VEIL_LOOPS <= 20_000);
});
