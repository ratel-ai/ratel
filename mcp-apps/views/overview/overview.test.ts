import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { VIEW_META_KEY } from "@/lib/mcp/apps/types";
import { OVERVIEW_WIDGETS } from "@/lib/views/overview-layout/domain/layout";
import { render, visibleText } from "@/lib/views/tasks/test-support";
import view from "./bindings";
import fixtures from "./fixtures";
import { HistoryBody } from "./history-body";
import { type OverviewView, readHistoryView, readOverviewView } from "./overview";
import { OverviewBody } from "./overview-body";

// tsx compiles the console's components with the classic runtime from this package.
Object.assign(globalThis, { React });

/** The overview view reads its fixtures, and draws the person's widgets in their order. */

function arrived(name: string) {
  const result = fixtures[name]?.result as { _meta?: Record<string, unknown> } | undefined;
  // As it arrives: JSON.
  return { view: JSON.parse(JSON.stringify(result?._meta?.[VIEW_META_KEY] ?? null)) ?? undefined };
}

const viewOf = (name: string) => readOverviewView(arrived(name));

function draw(name: string, change: (view: OverviewView) => OverviewView = (view) => view) {
  const read = viewOf(name);
  assert.ok(read, name);
  return drawView(change(read));
}

/** React numbers the ids of a document in order. */
const withoutIds = (html: string) => html.replace(/_R_\w*_|[«:]r\w+[»:]/g, "");

function drawView(view: OverviewView | null, drawn?: Parameters<typeof OverviewBody>[0]["drawn"]) {
  const html = render(
    React.createElement(OverviewBody, { view, openInConsole: () => undefined, drawn }),
  );
  const ids = [...html.matchAll(/data-overview-widget="(\w+)"/g)].map(([, id]) => id);
  return { html, text: visibleText(html), ids };
}

test("default: the five widgets", () => {
  const { html, text, ids } = draw("get_overview");
  assert.deepEqual(ids, ["metrics", "topology", "health", "attention", "alerts"]);
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
  assert.match(draw("get_overview · no data").text, /No data yet/);
  const { text } = draw("get_overview · failed reads");
  assert.match(text, /These numbers did not load/);
  assert.match(text, /The map did not load/);
  assert.match(text, /Retries after errors/);
});

test("a host that passed the text only has no view", () => {
  assert.equal(viewOf("get_overview · text only"), null);
  assert.match(drawView(null).text, /cannot be drawn here.*The agent has the numbers/);
  assert.equal(readOverviewView({ view: { kind: "trace" } }), null);
});

test("one widget: only it is drawn, with its title, as the page draws it", () => {
  const page = draw("get_overview").html;
  for (const id of OVERVIEW_WIDGETS) {
    const { html, text, ids } = draw(`get_overview · ${id}`);
    assert.deepEqual(ids, [id]);
    assert.match(text, /· Support agent · Last 7 days/);
    const body = html.slice(html.indexOf("</h2>") + 5, html.lastIndexOf("</section>"));
    assert.ok(body.length > 100 && withoutIds(page).includes(withoutIds(body)), id);
  }
});

test("one widget: nothing to show, a failed read and no data each have their own state", () => {
  assert.match(
    draw("get_overview · attention, nothing").text,
    /Nothing needs you right now.*Open Agent health/,
  );
  assert.match(draw("get_overview · alerts").text, /Too many errors\s*12%\s*above 5% · 12m ago/);
  assert.match(draw("get_overview · alerts, none").text, /No alert fires now.*Open Alerts/);
  const failed = draw("get_overview · topology, failed read");
  assert.match(failed.text, /The map did not load.*Try again/);
  assert.deepEqual(failed.ids, ["topology"]);
  assert.match(draw("get_overview · metrics, no data").text, /No data yet/);
});

test("a widget this view does not know says so", () => {
  const { text } = draw("get_overview · health", (view) => ({ ...view, widget: "spend" }));
  assert.match(text, /This widget cannot be drawn here/);
});

test("a fifth widget is drawn alone without a change of the view", () => {
  const read = viewOf("get_overview · health");
  assert.ok(read);
  const { text, ids } = drawView({ ...read, widget: "alerts" }, () => ({
    alerts: "2 alerts are on",
  }));
  assert.deepEqual(ids, ["alerts"]);
  assert.match(text, /2 alerts are on/);
});

test("a change of the layout draws the Overview that it made", () => {
  const { ids } = draw("change_overview_layout");
  assert.deepEqual(ids, draw("get_overview · removed widget").ids);
  assert.ok(view.bindings.some(({ tool }) => tool === "change_overview_layout"));
});

function drawHistory(name: string) {
  const view = readHistoryView(arrived(name));
  assert.ok(view, name);
  const html = render(React.createElement(HistoryBody, { view, openInConsole: () => undefined }));
  return { html, text: visibleText(html) };
}

test("the history: what, who, where and when, newest first, and nothing to press in it", () => {
  const { html, text } = drawHistory("list_overview_changes");
  assert.match(text, /History of your layout.*Support agent/);
  assert.match(
    text,
    /Took back: Removed Metrics ?You on the web, ?just now ?Current layout.*Removed Metrics ?You through claude-code, ?4m ago.*You through an MCP client, ?2h ago ?Made by a newer version.*Resized Agents and MCP servers ?You on the web, ?33h ago/,
  );
  assert.equal((html.match(/<button/g) ?? []).length, 1, "Open in Ratel only");
  assert.match(drawHistory("list_overview_changes · none").text, /No changes yet/);
});

test("an undo and a restore draw the Overview that they made", () => {
  assert.deepEqual(draw("undo_overview_change").ids, draw("get_overview").ids);
  assert.deepEqual(draw("restore_overview_layout").ids, draw("change_overview_layout").ids);
  assert.equal(readHistoryView(arrived("get_overview")), null);
  assert.equal(viewOf("list_overview_changes"), null);
  for (const tool of ["list_overview_changes", "undo_overview_change", "restore_overview_layout"])
    assert.ok(
      view.bindings.some((binding) => binding.tool === tool),
      tool,
    );
});
