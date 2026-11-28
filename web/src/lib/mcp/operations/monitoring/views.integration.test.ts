import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { McpAppBinding } from "@/lib/mcp/apps/types";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import { asToolResult } from "@/lib/mcp/server";
import { createScorer, insertTraceScores } from "@/lib/views/scorers/store";
import { checkDraft } from "@/lib/views/scorers/test-support";
import { alertReadOperations, alertWriteOperations } from "./alerts";
import { dashboardReadOperations, dashboardWriteOperations, EXAMPLES } from "./dashboards";
import { locationReadOperations } from "./locations";
import { scorerReadOperations } from "./scorers";
import { insertTrace, KEY_AUTH, type Monitoring, monitoring, NOW, PROJECT } from "./test-support";

/** The tools bound to a view: what a host without views reads, and what a view gets. */

let m: Monitoring;
let ids: { scorerId: string; alertId: string; dashboardId: string };
const operations = (deps: Monitoring["deps"]) => [
  ...scorerReadOperations(deps),
  ...alertReadOperations(deps),
  ...alertWriteOperations(deps),
  ...locationReadOperations(deps),
  ...dashboardReadOperations(deps),
  ...dashboardWriteOperations(deps),
];

before(async () => {
  m = await monitoring(operations);
  await insertTrace(m.client, "a", 100, true);
  await insertTrace(m.client, "b", 300);
  const scorerId = await createScorer(PROJECT, checkDraft(), "u", m.db);
  await insertTraceScores(
    [
      {
        traceId: "a",
        passed: true,
        value: 1,
        confidence: null,
        scorerId,
        projectId: PROJECT,
        traceStartedAt: new Date(NOW.getTime() - 3_600_000),
      },
    ],
    m.db,
  );
  const alert = {
    name: "Errors",
    query: {
      version: 1,
      kind: "metric",
      measures: [{ measure: "error_rate", aggregation: "rate" }],
    },
    operator: "above",
    threshold: 0.05,
    windowMinutes: 15,
  };
  const { alertId } = await m.data<{ alertId: string }>("change_alert", {
    action: "create",
    alert,
  });
  const { dashboardId } = await m.data<{ dashboardId: string }>("import_dashboard", {
    document: {
      type: "ratel.dashboard",
      version: 1,
      name: "Board",
      widgets: [
        { chart: "line", query: EXAMPLES.metric, layout: { x: 0, y: 0, w: 6, h: 6 } },
        {
          chart: "number",
          query: {
            version: 1,
            kind: "metric",
            measures: [{ measure: "trace_count", aggregation: "count" }],
          },
          layout: { x: 6, y: 0, w: 6, h: 6 },
        },
      ],
    },
  });
  await m.data("change_alert_destination", {
    action: "add_webhook",
    name: "Ops",
    webhookUrl: "https://hooks.slack.com/services/T000/B000/part",
  });
  ids = { scorerId, alertId, dashboardId };
});
after(() => m.client.close());

const READS = (): readonly [string, object, RegExp][] => [
  ["list_scorers", {}, /^1 scorer: Fast enough \(check, on\): 100% passed, 1 result in 7 days\.$/],
  ["get_scorer", { scorerId: ids.scorerId }, /^Fast enough \(check, on\): 100% passed/],
  ["list_alerts", {}, /^1 alert: Errors \(No data\): Error rate is above 5% over 15 minutes\.$/],
  ["get_alert", { alertId: ids.alertId }, /^Errors \(No data\): .* No state change yet\.$/],
  ["list_dashboards", {}, /^1 dashboard: Board \(2 widgets\)\.$/],
  [
    "get_dashboard",
    { dashboardId: ids.dashboardId, since: "2026-11-24T00:00:00Z", until: "2026-11-25T00:00:00Z" },
    /^Board: 2 widgets\.\nError rate by model: .*\nTraces: 2\.$/,
  ],
  ["list_alert_destinations", {}, /^1 destination: Ops \(Webhook\)\. Slack is not connected\.$/],
  ["list_slack_channels", {}, /^Slack is not connected\.$/],
  ["get_location_attributes", {}, /^address: client\.address; country: geo\.country\.iso_code; /],
  ["query_monitoring", { query: EXAMPLES.funnel }, /^Called a tool 0 > No error 0$/],
];

test("a host without views reads a summary first in the text of each bound tool", async () => {
  for (const [id, params, says] of READS()) {
    const result = await m.call(id, params);
    const { content } = asToolResult(result, !result.ok);
    const { data } = JSON.parse(content[0].text) as { data: Record<string, string> };
    assert.match(data.summary, says, id);
    assert.ok(Object.keys(data).indexOf("summary") <= 1, `${id}: the summary leads`);
  }
});

test("the view's model is read only for a view, and never reaches the text", async () => {
  const registry = buildRegistry(operations(m.deps));
  for (const [id, params] of READS()) {
    const plain = await m.call(id, params);
    const shown = await dispatchOperation(id, params, { registry, auth: KEY_AUTH, forView: true });
    assert.ok(plain.ok && shown.ok);
    assert.equal(plain.view, undefined, id);
    const bound = id === "get_dashboard" || id === "query_monitoring";
    assert.equal(
      (shown.view as { kind?: string } | undefined)?.kind,
      bound ? "dashboard" : undefined,
    );
    assert.equal(
      asToolResult(shown).content[0].text.replace(/T\d\d:\d\d:[\d.]+Z/g, ""),
      asToolResult(plain).content[0].text.replace(/T\d\d:\d\d:[\d.]+Z/g, ""),
      id,
    );
  }
  const shown = await dispatchOperation(
    "get_dashboard",
    { dashboardId: ids.dashboardId },
    { registry, auth: KEY_AUTH, forView: true },
  );
  assert.ok(shown.ok);
  const { widgets, range, projectId } = shown.view as {
    widgets: { widget: object; result: { kind: string } }[];
    range: object;
    projectId: string;
  };
  assert.equal(projectId, PROJECT);
  assert.ok("preset" in range);
  assert.deepEqual(
    widgets.map(({ widget, result }) => [Object.keys(widget).sort(), result.kind]),
    [
      [["chart", "query", "title"], "sql"],
      [["chart", "query", "title"], "sql"],
    ],
  );
});

test("the bound tools pass the catalog check", async () => {
  const { loadMcpAppCatalog } = await import("@/lib/mcp/apps/load");
  const catalog = loadMcpAppCatalog();
  const viewOf = (tool: string): string | undefined => catalog.boundTool(tool)?.view;
  assert.deepEqual(
    READS().map(([id]) => [id, viewOf(id)]),
    [
      ["list_scorers", "list"],
      ["get_scorer", "detail"],
      ["list_alerts", "list"],
      ["get_alert", "detail"],
      ["list_dashboards", "list"],
      ["get_dashboard", "dashboard"],
      ["list_alert_destinations", "list"],
      ["list_slack_channels", "list"],
      ["get_location_attributes", "list"],
      ["query_monitoring", "dashboard"],
    ],
  );
  const bindings = catalog.views.flatMap((view): readonly McpAppBinding[] => view.bindings);
  assert.equal(new Set(bindings.map(({ tool }) => tool)).size, bindings.length);
});
