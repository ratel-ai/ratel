import assert from "node:assert/strict";
import { test } from "node:test";
import { overlaps } from "@/lib/console/grid/layout";
import { compileRql } from "@/lib/synthesis/rql/compile";
import { gridPositionSchema } from "@/lib/views/dashboards/layout";
import { sqlChartOfText } from "@/lib/views/dashboards/legacy-chart";
import { isFormText } from "@/lib/views/dashboards/metric-rql";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { chartChoices } from "@/lib/views/dashboards/sql-chart";
import {
  DASHBOARD_TEMPLATES,
  DEFAULT_TEMPLATE_IDS,
  templateDashboard,
} from "@/lib/views/dashboards/templates";
import type { DashboardTemplate, TemplateWidget } from "@/lib/views/dashboards/templates/types";
import { chartProblem, isMetricChart } from "@/lib/views/dashboards/widget";

const PROPERTY = "customer";
const NOW = new Date("2026-11-28T12:00:00Z");
const NUMERIC = ["number", "integer"];

function widgetsOf(template: DashboardTemplate): readonly TemplateWidget[] {
  return template.property ? template.widgets(PROPERTY) : template.widgets;
}

/** Why a widget of a template is wrong, or null: the editor's parser, RQL and the chart rule. */
function widgetProblem(widget: TemplateWidget, property = PROPERTY): string | null {
  const { size: _, ...input } = widget;
  const parsed = parseWidget(input, { sqlChart: sqlChartOfText });
  if (!parsed.ok) return `the editor refuses it: ${parsed.error}`;
  const problem = chartProblem(input);
  if (problem) return problem;
  if (input.query.kind !== "sql" || !isMetricChart(input.chart)) return null;
  const compiled = compileRql(input.query.text, {
    now: NOW,
    console: true,
    properties: { indexed: [property] },
  });
  if (!compiled.ok) return `RQL refuses it: ${compiled.error.message} ${compiled.error.fix}`;
  if (input.query.form) {
    // A form widget opens with its dropdowns: its text is still the text of its selection.
    return isFormText(input.query, input.chart) ? null : "its text is not its form's";
  }
  const why = chartChoices({ columns: compiled.columns })[input.chart];
  if (why) return `a ${input.chart} cannot draw it: ${why}`;
  const numbers = compiled.columns.filter(({ type }) => NUMERIC.includes(type)).length;
  if ((input.chart === "line" || input.chart === "bar") && numbers !== 1)
    return `a ${input.chart} has one measure: the rows have ${numbers} number columns`;
  return null;
}

test("the gallery has the ten templates, each with a stable id, a name and one line", () => {
  assert.deepEqual(
    DASHBOARD_TEMPLATES.map(({ name }) => name),
    [
      "Tools",
      "Cost",
      "Reliability",
      "Traces overview",
      "Users and sessions",
      "Quality",
      "Models compared",
      "Agents",
      "Context use",
      "By customer",
    ],
  );
  const ids = DASHBOARD_TEMPLATES.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const template of DASHBOARD_TEMPLATES) {
    assert.match(template.id, /^[a-z-]+$/);
    assert.ok(template.description.length > 0 && !template.description.includes("\n"));
    assert.ok(template.prompt.length > 0);
    assert.ok(template.needs.length > 0, `${template.name} says what data it needs`);
  }
  assert.deepEqual(DEFAULT_TEMPLATE_IDS, ["tools", "cost", "reliability"]);
});

test("every widget of every template compiles for a project and fits its chart", () => {
  const failures: string[] = [];
  for (const template of DASHBOARD_TEMPLATES) {
    const widgets = widgetsOf(template);
    // Traces overview keeps the four widgets of the former starter.
    const fewest = template.id === "traces-overview" ? 4 : 5;
    if (widgets.length < fewest || widgets.length > 8)
      failures.push(`${template.name}: ${widgets.length} widgets, not ${fewest} to 8`);
    for (const [index, widget] of widgets.entries()) {
      const problem = widgetProblem(widget);
      const name = widget.title || `widget ${index + 1}`;
      if (problem) failures.push(`${template.name} › ${name}: ${problem}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("a template's dashboard places each widget on the grid with no overlap", () => {
  for (const template of DASHBOARD_TEMPLATES) {
    const made = templateDashboard(template.id, { property: PROPERTY, indexed: [PROPERTY] });
    assert.ok(made.ok, template.name);
    for (const [index, widget] of made.widgets.entries()) {
      assert.ok(gridPositionSchema.safeParse(widget.layout).success, `${template.name} ${index}`);
      for (const other of made.widgets.slice(index + 1))
        assert.ok(!overlaps(widget.layout, other.layout), `${template.name}: two widgets overlap`);
    }
    assert.equal(new Set(made.widgets.map(({ id }) => id)).size, made.widgets.length);
  }
});

test("By customer groups by the property it is given, and refuses one that is not indexed", () => {
  const made = templateDashboard("by-customer", { property: "plan", indexed: ["plan", "team"] });
  assert.ok(made.ok);
  assert.equal(made.name, "By customer: plan");
  assert.ok(made.widgets.every(({ title }) => title.endsWith("by plan")));

  const missing = templateDashboard("by-customer", { property: "region", indexed: ["plan"] });
  assert.deepEqual(missing.ok, false);
  assert.match(!missing.ok ? missing.error : "", /The property region is not indexed/);
  assert.match(!missing.ok ? missing.error : "", /Index it in project settings/);

  const none = templateDashboard("by-customer", { indexed: ["plan"] });
  assert.match(!none.ok ? none.error : "", /needs an indexed trace property/);
});

test("an unknown template is refused by its id", () => {
  const made = templateDashboard("nope", { indexed: [] });
  assert.deepEqual(made, { ok: false, error: 'There is no dashboard template "nope".' });
});
