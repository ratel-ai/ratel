import assert from "node:assert/strict";
import { test } from "node:test";
import { metricQuery } from "@/lib/contracts/query";
import {
  collapseStep,
  expandedOf,
  expandsCard,
  hasUnsavedChanges,
  NEW_WIDGET_ID,
  withExpanded,
} from "@/lib/views/dashboards/expanded";
import { formOf, formWidget } from "@/lib/views/dashboards/widget";

test("the address holds the expanded widget, and keeps the range and the filter", () => {
  const page = "?range=7d&environments=prod";
  const open = withExpanded(page, "w1");
  assert.equal(open, "?range=7d&environments=prod&widget=w1");
  assert.equal(expandedOf(open), "w1");
  assert.equal(withExpanded(open, null), page);
  assert.equal(expandedOf(page), null);
  assert.equal(expandedOf(withExpanded("", NEW_WIDGET_ID)), NEW_WIDGET_ID);
  assert.equal(withExpanded("?widget=w1", null), "");
  assert.equal(expandedOf("?widget=%20"), null);
});

test("an edit is unsaved until it matches the widget it started from, whatever the key order", () => {
  const start = formWidget(formOf(metricQuery("trace_count", "count")), "line");
  assert.equal(hasUnsavedChanges(start, { ...start }), false);
  assert.equal(
    hasUnsavedChanges(start, { chart: start.chart, query: start.query, title: "" }),
    false,
  );
  assert.equal(hasUnsavedChanges(start, { ...start, title: "Runs" }), true);
  assert.equal(hasUnsavedChanges(start, { ...start, chart: "bar" }), true);
});

test("a click on a card's body expands it; a drag or a click on a control inside it does not", () => {
  const on = (control: boolean) => ({ closest: () => (control ? {} : null) });
  const at = { x: 10, y: 10 };
  assert.equal(expandsCard(at, { x: 12, y: 13 }, on(false)), true);
  assert.equal(expandsCard(at, { x: 40, y: 10 }, on(false)), false, "a drag");
  assert.equal(expandsCard(at, at, on(true)), false, "a link, a menu or a button");
});

test("Close goes Back only to the grid this page expanded from; after a change of range it stays here", () => {
  const opened = "/d/1?range=7d&widget=w1";
  assert.equal(collapseStep(opened, opened), "back");
  // The range or a filter changed while it was open: Back would show the old range.
  assert.equal(collapseStep("/d/1?range=30d&widget=w1", opened), "replace");
  // Opened from a link or a reload: there is no entry of this page to go back to.
  assert.equal(collapseStep(opened, null), "replace");
});
