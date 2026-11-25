import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { GridCells } from "@/components/console/grid/GridCells";
import { widgetBodies } from "@/components/console/home/focused/widget-bodies";
import { VIEW_META_KEY } from "@/lib/mcp/apps/types";
import type { FocusedOverviewData } from "@/lib/views/home/focused-load";
import { visibleWidgets } from "@/lib/views/overview-layout/domain/layout";
import { render, visibleText } from "@/lib/views/tasks/test-support";
import fixtures from "./fixtures";
import { readOverviewView } from "./overview";

// tsx compiles the console's components with the classic runtime from this package.
Object.assign(globalThis, { React });

/** The overview view reads its fixtures, and draws the person's widgets in their order. */

function viewOf(name: string) {
  const result = fixtures[name]?.result as { _meta?: Record<string, unknown> } | undefined;
  // As it arrives: JSON.
  return readOverviewView({
    view: JSON.parse(JSON.stringify(result?._meta?.[VIEW_META_KEY] ?? null)) ?? undefined,
  });
}

function draw(name: string) {
  const view = viewOf(name);
  assert.ok(view, name);
  const data: FocusedOverviewData = { ...view.overview, lastEventAt: null };
  const bodies = widgetBodies(data, view.linked, (peek) => `${data.root}?peek=${peek}`);
  const cards = visibleWidgets(data.layout);
  const html = render(
    React.createElement(
      React.Fragment,
      null,
      GridCells({ cards, children: (card) => bodies[card.id] }),
    ),
  );
  return { html, text: visibleText(html), ids: cards.map(({ id }) => id) };
}

test("default: the four widgets", () => {
  const { html, text, ids } = draw("get_overview");
  assert.deepEqual(ids, ["metrics", "topology", "health", "attention"]);
  assert.match(text, /Runs .*141.*Failed runs .*Median duration .*Spend/);
  assert.match(text, /Retries after errors/);
  assert.match(html, /data-health-score="\d+"/);
  assert.match(html, /data-topology-node="agent"/);
  assert.match(html, /href="[^"]*\?peek=context"/, "a Panel opens in the console");
});

test("a removed widget is absent, and the rest keep the person's order", () => {
  const { html, ids } = draw("get_overview · removed widget");
  assert.equal(ids[0], "attention");
  assert.ok(!ids.includes("topology"));
  assert.doesNotMatch(html, /data-topology/);
});

test("without a score, the gauge says why", () => {
  const { html, text } = draw("get_overview · no score");
  assert.match(text, /Too few turns: 12 of the 50/);
  assert.doesNotMatch(html, /data-health-score=/);
});

test("no data is read as no data, and a failed read costs its widget", () => {
  assert.equal(viewOf("get_overview · no data")?.overview.hasTelemetry, false);
  const { text } = draw("get_overview · failed reads");
  assert.match(text, /These numbers did not load/);
  assert.match(text, /The map did not load/);
  assert.match(text, /Retries after errors/);
});

test("a host that passed the text only has no view", () => {
  assert.equal(viewOf("get_overview · text only"), null);
  assert.equal(readOverviewView({ view: { kind: "trace" } }), null);
});
