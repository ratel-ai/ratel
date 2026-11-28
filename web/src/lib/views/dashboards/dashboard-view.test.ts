// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ComponentProps, createElement } from "react";
import { DashboardView } from "@/components/console/dashboards/DashboardView";
import { GRID_COLUMNS } from "@/lib/console/grid/layout";
import { metricQuery } from "@/lib/contracts/query";
import type { DashboardWidget } from "@/lib/views/dashboards/types";
import { formOf, formWidget } from "@/lib/views/dashboards/widget";
import { PROJECT_ID, render } from "@/lib/views/tasks/test-support";

/** A dashboard on the shared card grid, in view mode and in edit mode. */

const WIDGETS: DashboardWidget[] = [
  {
    id: "cost",
    ...formWidget(formOf(metricQuery("cost", "sum")), "number"),
    title: "Cost",
    layout: { x: 0, y: 0, w: 4, h: 3 },
  },
  {
    id: "speed",
    ...formWidget(formOf(metricQuery("latency", "p95")), "line"),
    title: "Speed",
    layout: { x: 4, y: 0, w: 8, h: 6 },
  },
  {
    id: "old",
    title: "Old",
    layout: { x: 0, y: 3, w: 4, h: 3 },
    problem: "The widget settings are invalid.",
    stored: {},
  },
];

test("the stored places are drawn in both modes, in the one card frame", () => {
  const view = html();
  const edit = html({ startEditing: true });
  for (const text of [view, edit]) {
    assert.deepEqual(placesIn(text), {
      cost: "1 / span 4; 1 / span 3",
      speed: "5 / span 8; 1 / span 6",
      old: "1 / span 4; 4 / span 3",
    });
    assert.deepEqual(
      [...text.matchAll(/data-card="(\w+)"/g)].map(([, id]) => id),
      ["cost", "speed", "old"],
    );
    assert.match(text, /This widget is broken/);
  }
});

test("quiet by default: the handles, the menus and Remove come with edit mode", () => {
  const controls = /data-grid-handle|data-grid-surface|id="card-\w+-toolbar"|aria-label="Arrange /;
  assert.doesNotMatch(html(), controls);
  assert.doesNotMatch(html(), /data-edit-bar|id="dashboard-add-widget"/);
  const edit = html({ startEditing: true });
  assert.match(edit, /data-edit-bar/);
  assert.match(edit, /id="dashboard-add-widget"/);
  for (const title of ["Cost", "Speed", "Old"])
    for (const control of [
      `role="toolbar" aria-label="${title}"`,
      `aria-label="Arrange ${title}"`,
      `aria-label="Remove ${title}"`,
    ])
      assert.ok(edit.includes(control), control);
  assert.equal((edit.match(/data-grid-body="" inert=""/g) ?? []).length, 3);
});

test("the widget in the address opens in place of the grid, with its properties, and the page keeps its filter bar", () => {
  const open = html({}, "?range=7d&widget=speed");
  assert.doesNotMatch(open, /data-grid-card=/, "no grid");
  assert.match(open, /id="expanded-widget-title"[^>]*>Speed</);
  assert.match(open, /aria-label="Properties"/);
  assert.match(open, />Save</);
  assert.match(open, /aria-label="Close widget"/);
  assert.doesNotMatch(open, /role="dialog"/, "no modal dialog");
  // A new widget opens in a dialog, not in place; a broken or unknown one leaves the grid.
  for (const id of ["new", "old", "gone"])
    assert.match(html({}, `?widget=${id}`), /data-grid-card=/);
});

test("+ Widget shows outside edit mode for a person who may edit, and never in a support session", () => {
  const button =
    /<button[^>]*data-add-widget=""[^>]*aria-label="Add widget"[^>]*>.*?Widget<\/button>/;
  assert.match(html(), button);
  assert.doesNotMatch(html({ readOnly: true }), /aria-label="Add widget"/);
  assert.doesNotMatch(html({ readOnly: true, startEditing: true }), /id="dashboard-add-widget"/);
  // The empty dashboard offers a widget to an editor only.
  assert.match(html({ widgets: [] }), />Add widget</);
  assert.doesNotMatch(html({ widgets: [], readOnly: true }), /Add widget/);
});

test("a support session sees the properties of an open widget and cannot save them", () => {
  const open = html({ readOnly: true }, "?widget=speed");
  assert.match(open, /<fieldset aria-label="Properties" disabled=""/);
  assert.match(open, /Read only in a support session/);
  assert.doesNotMatch(open, />Save</);
});

function html(props: Partial<ComponentProps<typeof DashboardView>> = {}, search = ""): string {
  const at = "2026-11-24T12:00:00.000Z";
  return render(
    createElement(DashboardView, {
      projectId: PROJECT_ID,
      dashboard: { id: "d1", name: "Board", defaults: { filters: {}, range: null } },
      filters: {},
      problem: null,
      widgets: WIDGETS.map((widget) => ({ widget, result: null })),
      facets: { model: [], tool: [], service: [], environment: [] },
      timeWindow: { preset: "7d", from: at, to: at, today: "2026-11-24" },
      alerts: false,
      draft: null,
      ...props,
    }),
    { pathname: `/project/${PROJECT_ID}/dashboards/d1`, search },
  );
}

function placesIn(text: string): Record<string, string> {
  const cell =
    /data-grid-card="(\w+)" style="--cell-column:(\d+ \/ span \d+);--cell-row:(\d+ \/ span \d+)/g;
  return Object.fromEntries(
    [...text.matchAll(cell)].map(([, id, column, row]) => {
      const [start, span] = column.split(" / span ").map(Number);
      assert.ok(start - 1 + span <= GRID_COLUMNS);
      return [id, `${column}; ${row}`];
    }),
  );
}

test("a dashboard built from words names each widget the ask left out, in a note to dismiss", () => {
  const leftOut = [{ title: "Slowest tools", reason: "There is no table spans. Use events." }];
  const page = html({ leftOut });
  assert.match(page, /aria-label="Widgets left out"/);
  assert.match(page, /1 drafted widget was left out/);
  assert.match(page, /Slowest tools/);
  assert.match(page, /There is no table spans\. Use events\./);
  assert.match(page, /aria-label="Dismiss"/);
  assert.doesNotMatch(html(), /Widgets left out/);
});
