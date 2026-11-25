import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DotShape } from "../src/components/dot-shape";
import {
  DOT_SHAPE_LOOPS,
  DOT_SHAPE_MS,
  DOT_SHAPES,
  type DotShapeName,
  dotLayers,
} from "../src/components/dot-shape-model";

const NAMES = Object.keys(DOT_SHAPES) as DotShapeName[];
const cells = (path: string) => [...path.matchAll(/M(\d+) (\d+)/g)].map(([, x, y]) => `${x},${y}`);
const drawn = (name: DotShapeName) =>
  DOT_SHAPES[name].rows.flatMap((row, y) =>
    [...row].flatMap((cell, x) => (cell === "#" ? [`${x},${y}`] : [])),
  );

test("the same shape always has the same dots: server and browser agree", () => {
  for (const name of NAMES) assert.deepEqual(dotLayers(name), dotLayers(name));
  assert.notEqual(dotLayers("bell")[0].path, dotLayers("gauge")[0].path);
});

test("the dots of the shape are exactly its bitmap, and no noise is on it", () => {
  for (const name of NAMES) {
    const layers = dotLayers(name);
    const of = (kind: string) =>
      layers.filter((layer) => layer.kind === kind).flatMap(({ path }) => cells(path));
    assert.deepEqual(of("shape").sort(), drawn(name).sort(), name);
    const noise = of("noise");
    assert.equal(new Set(noise).size, noise.length);
    for (const cell of noise) assert.ok(!drawn(name).includes(cell), `${name} ${cell}`);
    const { width, rows } = DOT_SHAPES[name];
    for (const row of rows) assert.ok(row.length <= width, name);
    const share = noise.length / (width * rows.length - drawn(name).length);
    assert.ok(share > 0.2 && share < 0.45, `${name} noise ${share}`);
  }
});

test("formed, every dot of the shape stands out from every dot of noise", () => {
  for (const name of NAMES) {
    const layers = dotLayers(name);
    const formed = (kind: string) => layers.filter((l) => l.kind === kind).map((l) => l.formed);
    assert.ok(Math.min(...formed("shape")) >= 2 * Math.max(...formed("noise")), name);
    const shimmer = layers.filter((l) => l.kind === "noise").map((l) => l.shimmer);
    assert.ok(Math.min(...formed("shape")) >= 2 * Math.max(...shimmer), name);
  }
});

test("dissolved, the shape cannot be read: its dots are as mixed as the noise", () => {
  for (const name of NAMES) {
    const mean = (kind: string) => {
      const of = dotLayers(name).filter((layer) => layer.kind === kind);
      const dots = of.reduce((sum, layer) => sum + cells(layer.path).length, 0);
      // A cell without a noise dot is a dark one, as in the shape's own mix.
      return of.reduce((sum, layer) => sum + cells(layer.path).length * layer.noise, 0) / dots;
    };
    const { width, rows } = DOT_SHAPES[name];
    const open = width * rows.length - drawn(name).length;
    const around =
      (mean("noise") *
        dotLayers(name)
          .filter((l) => l.kind === "noise")
          .flatMap((l) => cells(l.path)).length) /
      open;
    assert.ok(Math.abs(mean("shape") - around) < 0.08, `${name} ${mean("shape")} ${around}`);
  }
});

test("few enough layers and dots for four at once", () => {
  for (const name of NAMES) {
    const layers = dotLayers(name);
    assert.ok(layers.length <= 12, name);
    assert.ok(layers.flatMap(({ path }) => cells(path)).length <= 1_000, name);
  }
});

test("a layer's delay never eats the hold: the whole shape holds for 2 s in each loop", () => {
  const css = readFileSync(new URL("../src/ratel.css", import.meta.url), "utf8");
  const frames = css.match(/@keyframes dot-shape \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const at = [...frames.matchAll(/(\d+)%/g)].map(([, percent]) => Number(percent));
  assert.equal(at[0], 0);
  assert.equal(at.at(-1), 100);
  const delays = dotLayers("bell").map(({ delayMs }) => delayMs);
  const formedFrom = Math.max(...at.filter((percent) => percent < 60));
  const hold = ((100 - formedFrom) / 100) * DOT_SHAPE_MS - Math.max(...delays);
  assert.ok(hold >= 1_900, `${hold}`);
  assert.match(css, /prefers-reduced-motion: no-preference\) \{\s*\[data-dot-shape-run/);
  assert.match(css, /\[inert\]/, "nothing moves while a page is arranged");
  assert.ok(Number.isInteger(DOT_SHAPE_LOOPS), "it ends where it starts: formed");
});

test("at first it is still, formed, and hidden from a screen reader", () => {
  const html = renderToStaticMarkup(createElement(DotShape, { name: "bell" }));
  assert.match(html, /^<span[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /data-dot-shape-run/);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ""), /\S/, "no words, no numbers");
});
