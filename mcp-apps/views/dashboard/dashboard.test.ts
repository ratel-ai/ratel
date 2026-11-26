import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WIDGET_KINDS } from "@/lib/views/dashboards/types";
import { readToolResult } from "../../shell/state";
import type { ViewFixture } from "../../shell/types";
import fixtures, { KINDS } from "./fixtures";
import { readDashboard, readText } from "./model";

// This package's tsconfig does not reach web/src, so tsx compiles its JSX to React.createElement.
Object.assign(globalThis, { React });
const { Dashboard } = await import("./dashboard");

const SAYS: Readonly<Record<string, RegExp>> = {
  number: /1\.2k|1,234/i,
  line: /Latency p95 by model, by day/,
  bar: /Traces by model, by day/,
  table: /42\.5/,
  flow: /Tool flow/,
  step_flow: /refund_payment, step 3: 120 traces, often fails/,
  funnel: /Refunded/,
  clusters: /Where is my order/,
  geography: /1,060 of 1,234 traces have a location/,
};

test("the dashboard view renders a widget of each kind a widget can hold", () => {
  assert.deepEqual(
    [...new Set(Object.values(KINDS).map(({ widget }) => widget?.query.kind))].sort(),
    [...WIDGET_KINDS].sort(),
  );
  const html = render(fixtures.get_dashboard);
  for (const [id, says] of Object.entries(SAYS)) {
    const body = html.split(`data-widget="${id}"`)[1]?.split("</section>")[0] ?? "";
    assert.match(body, says, id);
    assert.doesNotMatch(body, /could not be read|needs attention/, id);
  }
});

test("a widget has its place on the stored grid, in reading order", () => {
  const html = render(fixtures.get_dashboard);
  assert.match(html, /--cell-column:4 \/ span 9;--cell-row:1 \/ span 8/);
  const order = [...html.matchAll(/data-widget="(\w+)"/g)].map(([, id]) => id);
  assert.deepEqual(order, Object.keys(KINDS));
});

test("a broken widget, a missing scorer and a failed read say what is wrong", () => {
  const html = render(fixtures["get_dashboard · needs attention"]);
  for (const says of [/Unknown measure/, /No scorer named/, /could not be read/])
    assert.match(html, says);
});

test("a dashboard without widgets, and one query, render", () => {
  assert.match(render(fixtures["get_dashboard · empty"]), /No widgets yet/);
  assert.match(render(fixtures.query_monitoring), /Latency p95 by model, by day/);
});

test("two queries show side by side, with the way to Explore", () => {
  const html = render(fixtures["query_monitoring · two queries"]);
  assert.match(html, /--cell-column:1 \/ span 6;--cell-row:1 \/ span 10/);
  assert.match(html, /--cell-column:7 \/ span 6;--cell-row:1 \/ span 10/);
  assert.match(html, /Latency p95 by model, by day/);
  assert.match(html, /refund_payment, step 3: 120 traces, often fails/);
  assert.match(html, /Open in Ratel/);
  const text = render(fixtures["query_monitoring · two queries, text only"]);
  for (const says of [/>Explore</, /Tool step flow by intent/, /Open in Ratel/])
    assert.match(text, says);
});

test("the step flow is drawn with its columns, its ribbons and its links", () => {
  const html = render(fixtures.get_dashboard);
  for (const lane of [
    "Start: 370",
    "1st call: 350",
    "2nd call: 350",
    "3rd call: 210",
    "Later: 120",
  ])
    assert.match(html, new RegExp(`aria-label="${lane}"`));
  assert.match(html, /Ended after step 2: 140 traces/);
  assert.match(html, /data-journey-ribbon="c1:search_orders/);
  assert.match(html, /traces\/turns\?[^"]*facetTool=search_orders/);
});

test("a host that passed the text only gets each widget in one line", () => {
  const html = render(fixtures["get_dashboard · text only"]);
  assert.match(html, /Tool flow/);
  assert.match(html, /1,234 in 30 days/);
  assert.match(render(fixtures["query_monitoring · text only"]), /claude-sonnet-5-5 2\.4 s/);
  assert.equal(readDashboard({ view: { kind: "trace" } }), null);
  assert.deepEqual(readText(null).widgets.length, 1);
});

test("clusters are a table with a link to the console, and the map is not in the bundle", () => {
  const html = render(fixtures.get_dashboard);
  assert.match(html, /\/project\/[\w-]+\/intents\/map/);
  const built = readFileSync(new URL("../../dist/dashboard.html", import.meta.url), "utf8");
  assert.doesNotMatch(built, /"data-asks-pack":/);
});

test("the built view parses nothing: zod is not in it", () => {
  const html = readFileSync(new URL("../../dist/dashboard.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /ZodError|_zod/);
});

function render(fixture: ViewFixture): string {
  const read = readToolResult(fixture.result ?? {});
  assert.ok(read.ok);
  return renderToStaticMarkup(
    React.createElement(Dashboard, { result: read.value, openInConsole: () => {} }),
  );
}
