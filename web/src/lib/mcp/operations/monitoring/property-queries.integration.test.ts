import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { alertReadOperations, alertWriteOperations } from "./alerts";
import { dashboardReadOperations, dashboardWriteOperations } from "./dashboards";
import { rqlOperations } from "./rql";
import {
  insertTrace,
  type Monitoring,
  monitoring,
  NOW,
  OTHER,
  PROJECT,
  personAuth,
} from "./test-support";

/**
 * Trace properties through MCP (RTL-396): describe_rql_schema lists the caller's project's ones,
 * run_rql and query_monitoring read an indexed one and refuse one that is not indexed with its
 * name and the fix, and change_dashboard and change_alert keep a property filter and group-by.
 */

const SINCE = new Date(NOW.getTime() - 86_400_000).toISOString();
const UNTIL = NOW.toISOString();

let m: Monitoring;

before(async () => {
  m = await monitoring((deps) => [
    ...rqlOperations(deps),
    ...dashboardReadOperations(deps),
    ...dashboardWriteOperations(deps),
    ...alertReadOperations(deps),
    ...alertWriteOperations(deps),
  ]);
  const plans: [string, Record<string, string>][] = [
    ["a".repeat(32), { organization: "acme", plan: "pro" }],
    ["b".repeat(32), { organization: "acme", plan: "team" }],
    ["c".repeat(32), { organization: "globex", plan: "pro" }],
  ];
  for (const [traceId, values] of plans) {
    await insertTrace(m.client, traceId, 100);
    await m.client.query("update otel_trace_summaries set properties = $1 where trace_id = $2", [
      JSON.stringify(values),
      traceId,
    ]);
  }
  await m.client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'organization', 'indexed', 'standard', 30),
      ('${PROJECT}', 'plan', 'indexed', 'user', 20),
      ('${PROJECT}', 'tenant', 'detected', 'user', 10),
      ('${PROJECT}', 'user', 'indexed', 'standard', 5),
      ('${OTHER}', 'secret_plan', 'indexed', 'user', 99);
  `);
});
after(() => m.client.close());

test("describe_rql_schema lists the indexed properties and apart the detected ones, of the caller's project only", async () => {
  const data = await m.data<{ properties: { indexed: string[]; detected: string[] } }>(
    "describe_rql_schema",
  );
  assert.deepEqual(data.properties.indexed, ["organization", "plan"]);
  assert.deepEqual(data.properties.detected, ["tenant"]);
  assert.ok(!JSON.stringify(data).includes("secret_plan"));
});

test("run_rql reads an indexed property, and refuses one that is not indexed with its name and the fix", async () => {
  const table = await m.data<{ rows: unknown[][] }>("run_rql", {
    text: "select properties['plan'] as plan, count(*) as traces from traces where properties['organization'] = 'acme' group by plan order by plan",
    since: SINCE,
    until: UNTIL,
  });
  assert.deepEqual(table.rows, [
    ["pro", 1],
    ["team", 1],
  ]);
  for (const name of ["tenant", "secret_plan"]) {
    const refused = await m.call("run_rql", {
      text: `select count(*) from traces where properties['${name}'] = 'x'`,
    });
    assert.ok(!refused.ok);
    assert.equal(refused.reason, "property_not_indexed");
    assert.match(refused.message, new RegExp(name));
    assert.match(refused.fix ?? "", /index it in project settings/i);
  }
  const column = await m.call("run_rql", { text: "select properties['user'] from traces" });
  assert.ok(!column.ok);
  assert.equal(column.reason, "property_is_column");
  assert.match(column.fix ?? "", /user_id/);
});

test("run_rql and query_monitoring read the properties of the caller's project only: another project's values never show", async () => {
  // Project B has a trace with values of a name A indexes and of a name only B indexes.
  await m.client.query(
    `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
       input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at, properties)
     values ($1, $2, $3, 100, false, 1, 1, 0, $3, $3, $4::jsonb)`,
    [
      OTHER,
      "d".repeat(32),
      new Date(NOW.getTime() - 3_600_000),
      JSON.stringify({ plan: "enterprise", organization: "initech", secret_plan: "leak" }),
    ],
  );
  try {
    const mine = await m.data<{ rows: unknown[][] }>("run_rql", {
      text: "select properties['plan'] as plan, properties['organization'] as organization, count(*) as traces from traces group by plan, organization order by plan, organization",
      since: SINCE,
      until: UNTIL,
    });
    assert.deepEqual(mine.rows, [
      ["pro", "acme", 1],
      ["pro", "globex", 1],
      ["team", "acme", 1],
    ]);
    // B's own name is not A's: refused, never read.
    const theirs = await m.call("run_rql", {
      text: "select properties['secret_plan'] as v, count(*) from traces group by v",
    });
    assert.equal(!theirs.ok && theirs.reason, "property_not_indexed");
    // B reads its own value, and none of A's.
    const other = await m.call(
      "run_rql",
      {
        projectId: OTHER,
        text: "select properties['secret_plan'] as v, count(*) as traces from traces group by v",
        since: SINCE,
        until: UNTIL,
      },
      personAuth(),
    );
    assert.ok(other.ok);
    assert.deepEqual((other.data as { rows: unknown[][] }).rows, [["leak", 1]]);
    // The metric form's query: a filter and a group-by of A's names keep none of B's traces.
    const metric = await m.data<{ result: { series: { groups: string[]; total: number }[] } }>(
      "query_monitoring",
      {
        query: {
          version: 1,
          kind: "metric",
          measures: [{ measure: "trace_count", aggregation: "count" }],
          dimensions: [{ property: "organization" }],
          filters: { properties: { plan: ["pro", "enterprise"] } },
        },
        chart: "table",
        since: SINCE,
        until: UNTIL,
      },
    );
    assert.deepEqual(metric.result.series.map(({ groups, total }) => [groups[0], total]).sort(), [
      ["acme", 1],
      ["globex", 1],
    ]);
  } finally {
    await m.client.query("delete from otel_trace_summaries where project_id = $1", [OTHER]);
  }
});

test("query_monitoring groups and filters a metric by a property, and gives its RQL", async () => {
  const query = {
    version: 1,
    kind: "metric",
    measures: [{ measure: "trace_count", aggregation: "count" }],
    dimensions: [{ property: "organization" }],
    filters: { properties: { plan: ["pro"] } },
  };
  const result = await m.data<{
    result: { series: { groups: string[]; total: number }[] };
  }>("query_monitoring", { query, chart: "table", since: SINCE, until: UNTIL });
  assert.deepEqual(result.result.series.map(({ groups, total }) => [groups[0], total]).sort(), [
    ["acme", 1],
    ["globex", 1],
  ]);
  const asSql = await m.data<{ text: string }>("query_monitoring", {
    query,
    chart: "table",
    as: "sql",
    since: SINCE,
    until: UNTIL,
  });
  assert.match(asSql.text, /properties\['organization'\] as organization/);
  assert.match(asSql.text, /properties\['plan'\] in \('pro'\)/);

  const refused = await m.call("query_monitoring", {
    query: { ...query, dimensions: [{ property: "tenant" }] },
    chart: "table",
  });
  assert.ok(!refused.ok);
  assert.equal(refused.reason, "property_not_indexed");
  assert.match(refused.message, /tenant/);
});

test("change_dashboard keeps a widget grouped and filtered by a property; change_alert a filtered rule", async () => {
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "By organization",
  });
  const added = await m.data<{ widgets: { id: string }[] }>("change_dashboard", {
    action: "add_widget",
    dashboardId,
    widget: {
      query: {
        version: 1,
        kind: "metric",
        measures: [{ measure: "latency", aggregation: "p95" }],
        dimensions: [{ property: "plan" }],
        filters: { properties: { organization: ["acme"] } },
      },
      chart: "bar",
    },
  });
  assert.equal(added.widgets.length, 1);
  const board = await m.data<{
    document: { widgets: { query: { text: string; form: object } }[] };
  }>("get_dashboard", { dashboardId });
  const [widget] = board.document.widgets;
  assert.match(widget.query.text, /properties\['plan'\]/);
  assert.deepEqual((widget.query.form as { dimensions: unknown }).dimensions, [
    { property: "plan" },
  ]);

  const alert = await m.data<{ alert: { query: { text: string } } }>("change_alert", {
    action: "create",
    alert: {
      name: "Acme errors",
      query: {
        version: 1,
        kind: "metric",
        measures: [{ measure: "error_rate", aggregation: "rate" }],
        filters: { properties: { organization: ["acme"] } },
      },
      operator: "above",
      threshold: 0.1,
      windowMinutes: 15,
    },
  });
  assert.match(alert.alert.query.text, /properties\['organization'\] in \('acme'\)/);

  const grouped = await m.call("change_dashboard", {
    action: "add_widget",
    dashboardId,
    widget: {
      query: {
        version: 1,
        kind: "metric",
        measures: [{ measure: "context_tokens", aggregation: "sum" }],
        dimensions: [{ property: "plan" }],
      },
      chart: "bar",
    },
  });
  assert.ok(!grouped.ok);
  assert.match(grouped.message, /cannot be grouped by the property "plan"/);
});

test("query_monitoring and change_dashboard take a metric's task group-by, of the project only (RTL-397)", async () => {
  await m.client.exec(`
    insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id) values
      ('${PROJECT}', 's', 'otlp:${"a".repeat(32)}', 'otlp', 'otlp', 'closed', now(), now(), now(), 'checkout'),
      ('${PROJECT}', 's', 'otlp:${"b".repeat(32)}', 'otlp', 'otlp', 'closed', now(), now(), now(), 'refund'),
      ('${OTHER}', 's', 'otlp:${"c".repeat(32)}', 'otlp', 'otlp', 'closed', now(), now(), now(), 'secret');
  `);
  const query = {
    version: 1,
    kind: "metric",
    measures: [{ measure: "trace_count", aggregation: "count" }],
    dimensions: ["task"],
  };
  const grouped = await m.data<{ result: { series: { groups: string[]; total: number }[] } }>(
    "query_monitoring",
    { query, chart: "table", since: SINCE, until: UNTIL },
  );
  assert.deepEqual(grouped.result.series.map(({ groups, total }) => [groups[0], total]).sort(), [
    ["checkout", 1],
    ["refund", 1],
  ]);
  const asSql = await m.data<{ text: string }>("query_monitoring", {
    query,
    chart: "table",
    as: "sql",
  });
  assert.match(asSql.text, /each\(tasks\) as task/);
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "By task",
  });
  await m.data("change_dashboard", {
    action: "add_widget",
    dashboardId,
    widget: { query, chart: "bar" },
  });
  const board = await m.data<{ document: { widgets: { query: { text: string } }[] } }>(
    "get_dashboard",
    { dashboardId },
  );
  assert.match(board.document.widgets[0].query.text, /each\(tasks\) as task/);
});
