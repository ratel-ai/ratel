import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dashboardReadOperations, dashboardWriteOperations } from "./dashboards";
import { insertTrace, type Monitoring, monitoring, NOW, OTHER, PROJECT } from "./test-support";

/**
 * A group-by of the kinds through MCP (RTL-398): query_monitoring gives each value with its traces
 * and its result, change_dashboard keeps a widget's groupBy, get_dashboard lists the values, and
 * no value of another project shows.
 */

const SINCE = new Date(NOW.getTime() - 86_400_000).toISOString();
const UNTIL = NOW.toISOString();
const MAP = {
  version: 1,
  kind: "geography",
  measures: [{ measure: "trace_count", aggregation: "count" }],
  groupBy: { property: "plan" },
};

let m: Monitoring;

before(async () => {
  m = await monitoring((deps) => [
    ...dashboardReadOperations(deps),
    ...dashboardWriteOperations(deps),
  ]);
  const plans: [string, string, string][] = [
    ["a".repeat(32), "pro", PROJECT],
    ["b".repeat(32), "pro", PROJECT],
    ["c".repeat(32), "free", PROJECT],
    ["d".repeat(32), "secret", OTHER],
  ];
  for (const [traceId, plan, projectId] of plans) {
    await insertTrace(m.client, traceId);
    await m.client.query(
      "update otel_trace_summaries set project_id = $1, properties = $2 where trace_id = $3",
      [projectId, JSON.stringify({ plan }), traceId],
    );
  }
  await m.client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'plan', 'indexed', 'user', 3),
      ('${OTHER}', 'plan', 'indexed', 'user', 1);
  `);
});
after(() => m.client.close());

interface Grouped {
  kind: "grouped";
  leftOut: number;
  groups: { value: string | null; traces: number; summary: string; result: { kind: string } }[];
}

test("query_monitoring gives each value of a group-by with its traces and its result", async () => {
  const data = await m.data<{ summary: string; result: Grouped }>("query_monitoring", {
    query: { ...MAP, groupLimit: 1 },
    since: SINCE,
    until: UNTIL,
  });
  assert.equal(data.result.kind, "grouped");
  assert.deepEqual(
    data.result.groups.map(({ value, traces, result }) => [value, traces, result.kind]),
    [["pro", 2, "geography"]],
  );
  assert.equal(data.result.leftOut, 1);
  assert.match(data.summary, /^By plan: pro \(2 traces\)/);
  assert.match(data.summary, /1 more value is not shown/);
  assert.ok(!JSON.stringify(data).includes("secret"));
});

test("change_dashboard keeps a widget's groupBy, and get_dashboard lists its values", async () => {
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "By plan",
  });
  await m.data("change_dashboard", {
    action: "add_widget",
    dashboardId,
    widget: { query: MAP, chart: "geography" },
  });
  const board = await m.data<{
    document: { widgets: { query: { groupBy?: unknown } }[] };
    widgets: { groups?: { value: string | null; traces: number }[]; leftOutValues?: number }[];
  }>("get_dashboard", { dashboardId, since: SINCE, until: UNTIL });
  assert.deepEqual(board.document.widgets[0].query.groupBy, { property: "plan" });
  assert.deepEqual(
    board.widgets[0].groups?.map(({ value, traces }) => [value, traces]),
    [
      ["pro", 2],
      ["free", 1],
    ],
  );
  assert.equal(board.widgets[0].leftOutValues, 0);
  const refused = await m.call("change_dashboard", {
    action: "add_widget",
    dashboardId,
    widget: { query: { ...MAP, groupBy: "model" }, chart: "geography" },
  });
  assert.ok(!refused.ok);
});
