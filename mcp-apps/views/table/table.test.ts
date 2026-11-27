import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readToolResult } from "../../shell/state";
import type { ViewFixture } from "../../shell/types";
import fixtures from "./fixtures";
import { cellText, readTable } from "./table";

// This package's tsconfig does not reach web/src, so tsx compiles its JSX to React.createElement.
Object.assign(globalThis, { React });
const { TableBody } = await import("./table-body");

test("the table view shows the summary, each column with its type, and each value", () => {
  const html = render(fixtures.run_rql);
  assert.match(html, /3 rows of 3 columns: model, calls, cost\./);
  for (const header of ["model", "calls", "cost"]) assert.match(html, new RegExp(`>${header}<`));
  assert.match(html, />integer</);
  assert.match(html, />claude-sonnet-5-5</);
  assert.match(html, />1,234</);
  assert.match(html, />18\.4512</);
  assert.match(html, />null</);
  assert.doesNotMatch(html, /The first rows only/);
});

test("a cut table says so, and an empty one says no row matched", () => {
  const dense = render(fixtures["run_rql · dense"]);
  assert.match(dense, /The first rows only/);
  assert.equal(dense.match(/<tr/g)?.length, 101, "a header and 100 rows");
  assert.match(render(fixtures["run_rql · empty"]), /No row matched in this window/);
});

test("the data of a table is read, and anything else is not", () => {
  assert.equal(readTable({ data: { columns: [{ name: "a" }], rows: [] } }), null);
  assert.equal(readTable({ data: null }), null);
  assert.equal(readTable({ data: { summary: "x" } }), null);
  assert.deepEqual(readTable({ data: { columns: [], rows: [[1], "x"] } })?.rows, [[1]]);
  assert.equal(cellText(["a", "b"]), '["a","b"]');
  assert.equal(cellText(false), "false");
  assert.equal(cellText(0.123456), "0.1235");
});

function render(fixture: ViewFixture): string {
  const read = readToolResult(fixture.result ?? {});
  assert.ok(read.ok);
  return renderToStaticMarkup(React.createElement(TableBody, { result: read.value }));
}
