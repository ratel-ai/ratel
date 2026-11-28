import assert from "node:assert/strict";
import { test } from "node:test";
import { QUERY_VERSION } from "@/lib/contracts/query";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { importDashboard } from "@/lib/views/dashboards/document";
import type { WidgetInput } from "@/lib/views/dashboards/types";
import { draftedDashboard } from "./build";

const widget = (title: string, text: string, chart: WidgetInput["chart"]): WidgetInput => ({
  title,
  query: { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION },
  chart,
});

test("the kept widgets make a document that import takes, each at the first free place", () => {
  const document = draftedDashboard(" Agent health ", [
    widget(
      "Traces per hour",
      "select time_bucket('1 hour', started_at) as hour, count(*) as n from traces group by hour",
      "line",
    ),
    widget("Error rate", "select rate(has_error) as error_rate from traces", "number"),
    widget(
      "Cost by model",
      "select model, sum(cost_usd) as cost from events group by model",
      "bar",
    ),
  ]);
  assert.equal(document.name, "Agent health");
  assert.deepEqual(
    document.widgets.map(({ layout }) => layout),
    [
      { x: 0, y: 0, w: 6, h: 6 },
      { x: 6, y: 0, w: 6, h: 6 },
      { x: 0, y: 6, w: 6, h: 6 },
    ],
  );
  const read = importDashboard(document, { scorers: [] });
  assert.ok(read.ok, read.ok ? "" : read.error);
  if (!read.ok) return;
  assert.deepEqual(
    read.dashboard.widgets.map(({ title, chart, query }) => [title, chart, query.kind]),
    [
      ["Traces per hour", "line", "sql"],
      ["Error rate", "number", "sql"],
      ["Cost by model", "bar", "sql"],
    ],
  );
});
