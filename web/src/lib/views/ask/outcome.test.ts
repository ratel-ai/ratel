import assert from "node:assert/strict";
import { test } from "node:test";
import { QUERY_VERSION } from "@/lib/contracts/query";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import type { WidgetInput } from "@/lib/views/dashboards/types";
import { askOutcome, isChoice } from "./outcome";

const widget = (
  title: string,
  text: string,
  chart: WidgetInput["chart"] = "line",
): WidgetInput => ({
  title,
  query: { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION },
  chart,
});
const A = widget("Traces per hour", "select count(*) from traces");
const B = widget("Cost", "select sum(cost_usd) from traces", "number");

test("a draft saved unchanged is kept", () => {
  assert.equal(askOutcome([A], [A]), "kept");
  assert.equal(askOutcome([A, B], [A, B]), "kept");
  assert.equal(askOutcome([A], [{ ...A, title: ` ${A.title} ` }]), "kept");
});

test("a draft saved after a change is edited", () => {
  assert.equal(askOutcome([A], [{ ...A, title: "Runs" }]), "edited");
  assert.equal(askOutcome([A], [{ ...A, chart: "bar" }]), "edited");
  assert.equal(askOutcome([A], [widget(A.title, "select count(*) from events")]), "edited");
  // A widget dropped before the dashboard is made.
  assert.equal(askOutcome([A, B], [A]), "edited");
});

test("a draft not saved is discarded", () => {
  assert.equal(askOutcome([A], null), "discarded");
  assert.equal(askOutcome([A, B], []), "discarded");
});

test("a change of the query or the chart is a choice, a title alone is not", () => {
  assert.equal(isChoice(A, { ...A, title: "Other" }), false);
  assert.equal(isChoice(A, { ...A, chart: "table" }), true);
  assert.equal(isChoice(A, widget(A.title, "select 1 from traces")), true);
  assert.equal(isChoice(A, A), false);
});
