// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ComponentProps, createElement } from "react";
import { DashboardView } from "@/components/console/dashboards/DashboardView";
import { GRID_COLUMNS } from "@/lib/console/grid/layout";
import { metricQuery } from "@/lib/contracts/query";
import type { DashboardWidget } from "@/lib/views/dashboards/types";
import { PROJECT_ID, render } from "@/lib/views/tasks/test-support";

/** A dashboard on the shared card grid, in view mode and in edit mode. */

const WIDGETS: DashboardWidget[] = [
  {
    id: "cost",
    title: "Cost",
    query: metricQuery("cost", "sum"),
    chart: "number",
    layout: { x: 0, y: 0, w: 4, h: 3 },
  },
  {
    id: "speed",
    title: "Speed",
    query: metricQuery("latency", "p95"),
    chart: "line",
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
  assert.doesNotMatch(html(), /data-edit-bar|>Add widget</);
  const edit = html({ startEditing: true });
  assert.match(edit, /data-edit-bar/);
  assert.match(edit, />Add widget</);
  for (const title of ["Cost", "Speed", "Old"])
    for (const control of [
      `role="toolbar" aria-label="${title}"`,
      `aria-label="Arrange ${title}"`,
      `aria-label="Remove ${title}"`,
    ])
      assert.ok(edit.includes(control), control);
  assert.equal((edit.match(/data-grid-body="" inert=""/g) ?? []).length, 3);
});

function html(props: Partial<ComponentProps<typeof DashboardView>> = {}): string {
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
      scorers: [],
      alerts: false,
      draft: null,
      ...props,
    }),
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
