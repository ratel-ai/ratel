import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  type Aggregation,
  type MeasureId,
  type MetricDimension,
  type MetricQuery,
  metricQuery,
  QUERY_VERSION,
  type SqlQuery,
} from "@/lib/contracts/query";
import { loadStoredPropertyNames } from "@/lib/ingest/properties/store";
import { nothingIsZero, type QueryScope } from "@/lib/synthesis/metrics/catalog";
import {
  type MetricResult,
  metricSeams,
  QueryError,
  runQuery,
  type SqlResult,
} from "@/lib/synthesis/metrics/query";
import {
  OTHER_PROJECT,
  PARITY_WINDOW,
  PROJECT,
  seedMetricParity,
  traceDatabase,
} from "@/lib/synthesis/metrics/trace-fixture";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { loadWidget } from "@/lib/views/dashboards/data";
import { formQuery, metricAsRql } from "@/lib/views/dashboards/metric-rql";
import { sqlAsMetric } from "@/lib/views/dashboards/sql-chart";
import { formOf } from "@/lib/views/dashboards/widget";
import "@/lib/views/scorers/metrics";

/**
 * A trace property in the metric form (RTL-396): a filter and a group-by of the form give the
 * numbers of the RQL a person writes by hand, and of the form compiler, on one fixture in Postgres
 * (PGlite). The properties are on the summaries of the parity fixture: organization (standard,
 * indexed), plan (the project's own, indexed) and tenant (detected, not indexed).
 */

const PROPERTIES: Record<string, Record<string, string>> = {
  t1: { organization: "acme", plan: "pro" },
  t2: { organization: "acme", plan: "team" },
  t3: { organization: "globex", plan: "pro" },
  t4: { organization: "globex" },
  t7: { organization: "acme", plan: "pro" },
};

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  await seedMetricParity(database);
  for (const [traceId, values] of Object.entries(PROPERTIES))
    await database.client.query(
      "update otel_trace_summaries set properties = $1::jsonb where trace_id = $2",
      [JSON.stringify(values), traceId],
    );
  await database.client.exec(`
    update otel_trace_summaries set end_user_id = 'u1', session_id = 's1' where trace_id in ('t1', 't2');
    update otel_trace_summaries set end_user_id = 'u2', session_id = 's2' where trace_id = 't3';
    insert into trace_property_keys (project_id, name, state, source) values
      ('${PROJECT}', 'organization', 'indexed', 'standard'),
      ('${PROJECT}', 'plan', 'indexed', 'user'),
      ('${PROJECT}', 'tenant', 'detected', 'user'),
      ('${PROJECT}', 'user', 'indexed', 'standard');
  `);
  await seedTasks(database.client);
  metricSeams.sql = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(database.client)),
      gate: createRqlGate(),
      observe: async () => {},
    },
    alertGate: createRqlGate(),
    properties: (projectId) => loadStoredPropertyNames(projectId, database.db),
  });
});

after(() => database.client.close());

test("the form with a property filter and group-by gives the numbers of the RQL written by hand", async () => {
  const form = formOf(
    metricQuery("trace_count", "count", {
      dimensions: [{ property: "plan" }],
      filters: { properties: { organization: ["acme"] } },
    }),
  );
  const byForm = await rows(metricAsRql(form, "table", "day"));
  const byHand = await rows(
    "select properties['plan'], count(*) from traces where properties['organization'] = 'acme' and properties['plan'] is not null group by properties['plan']",
  );
  // t1 and t7 are acme on plan pro, t2 acme on plan team.
  assert.deepEqual(byForm, { pro: 2, team: 1 });
  assert.deepEqual(byHand, byForm);

  const latency = formOf(
    metricQuery("latency", "p95", {
      dimensions: [{ property: "organization" }],
      filters: { properties: { plan: ["pro"] } },
    }),
  );
  assert.deepEqual(
    await rows(metricAsRql(latency, "table", "day")),
    await rows(
      "select properties['organization'] as org, p95(duration_ms) from traces where properties['plan'] in ('pro') and properties['organization'] is not null group by org",
    ),
  );
});

test("the form compiler and the text of the form agree for every measure, group-by, filter and page filter", async () => {
  const measures: [MeasureId, Aggregation][] = [
    ["trace_count", "count"],
    ["error_rate", "rate"],
    ["latency", "p95"],
    ["cost", "sum"],
    ["scorer_count", "count"],
    ["scorer_pass_rate", "rate"],
  ];
  const groupings: MetricDimension[][] = [
    [],
    [{ property: "organization" }],
    [{ property: "plan" }, "model"],
    ["user"],
    ["session", { property: "plan" }],
    // RTL-397: a trace of two tasks is in both groups.
    ["task"],
    ["task", "model"],
  ];
  const filters: MetricQuery["filters"][] = [
    {},
    { properties: { plan: ["pro"] } },
    { properties: { organization: ["acme", "globex"] }, and: [{ properties: { plan: ["team"] } }] },
    { environments: ["prod"], properties: { organization: ["globex"] } },
    // RTL-397: the absence of a property, users and sessions.
    { withoutProperties: ["plan"] },
    { users: ["u1"], and: [{ sessions: ["s1", "s2"] }] },
    { tasks: ["checkout"] },
  ];
  const pages: TraceFilter[] = [
    {},
    { properties: { organization: ["acme"] } },
    { sessions: ["s1", "s2"], withoutProperties: ["organization"] },
    { users: ["u1", "u2"] },
  ];
  const failures: string[] = [];
  let cells = 0;
  for (const [measure, aggregation] of measures)
    for (const dimensions of groupings)
      for (const filter of filters)
        for (const page of pages)
          for (const shape of ["day", "total"] as const) {
            const query = metricQuery(measure, aggregation, {
              dimensions,
              filters: filter,
              ...(shape === "day" ? { bucket: "day" } : {}),
            });
            const scope: QueryScope = { ...PARITY_WINDOW, filter: page };
            const chart = shape === "day" ? "line" : dimensions.length > 0 ? "table" : "number";
            const text = metricAsRql(formOf(query), chart, "day");
            const expected = formValues(await runQuery(PROJECT, query, scope, database.db), shape);
            const actual = rqlValues(
              await runQuery(PROJECT, sqlQuery(text), scope, database.db),
              aggregation,
              shape,
            );
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              failures.push(
                `${JSON.stringify({ measure, dimensions, filter, page, shape })}\nform ${JSON.stringify(expected)}\nRQL  ${JSON.stringify(actual)}\n${text}`,
              );
            cells += 1;
          }
  assert.deepEqual(failures, []);
  assert.ok(cells >= 400, `${cells} cells`);
});

test("the form's task filter and group-by give the numbers of the RQL written by hand, of the project only", async () => {
  const form = formOf(
    metricQuery("trace_count", "count", {
      dimensions: ["task"],
      filters: { properties: { organization: ["acme"] } },
    }),
  );
  const byForm = await rows(metricAsRql(form, "table", "day"));
  const byHand = await rows(
    "select each(tasks) as task, count(*) from traces where properties['organization'] = 'acme' group by task",
  );
  // t1 ran in checkout (its own turn) and refund (a step of a runtime turn), t2 in refund.
  assert.deepEqual(byForm, { checkout: 1, refund: 2 });
  assert.deepEqual(byHand, byForm);
  const filtered = formOf(metricQuery("latency", "avg", { filters: { tasks: ["checkout"] } }));
  assert.deepEqual(
    await rows(metricAsRql(filtered, "number", "day").replace("select ", "select 'x', ")),
    await rows("select 'x', avg(duration_ms) from traces where contains(tasks, 'checkout')"),
  );
  // The other project's run of t3 is no task of this project.
  const all = await rows("select each(tasks) as task, count(*) from traces group by task");
  assert.deepEqual(Object.keys(all).sort(), ["checkout", "refund"]);
  const byTask = await runQuery(
    PROJECT,
    metricQuery("trace_count", "count", { dimensions: ["task"] }),
    PARITY_WINDOW,
    database.db,
  );
  assert.deepEqual(byTask.series.map(({ groups }) => groups[0].value).sort(), [
    "checkout",
    "refund",
  ]);
});

test("a property that is not indexed is refused with its name and the fix, by the form and by RQL", async () => {
  const notIndexed = async (run: () => Promise<unknown>) => {
    const error = await run().then(
      () => assert.fail("ran"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof QueryError);
    assert.equal(error.detail?.code, "property_not_indexed");
    assert.match(error.message, /tenant/);
    assert.match(error.detail?.fix ?? "", /index it in project settings/i);
  };
  const grouped = metricQuery("trace_count", "count", { dimensions: [{ property: "tenant" }] });
  const filtered = metricQuery("trace_count", "count", {
    filters: { and: [{ properties: { tenant: ["x"] } }] },
  });
  for (const query of [grouped, filtered]) {
    await notIndexed(() => runQuery(PROJECT, query, PARITY_WINDOW, database.db));
    await notIndexed(() =>
      runQuery(
        PROJECT,
        sqlQuery(metricAsRql(formOf(query), "table", "day")),
        PARITY_WINDOW,
        database.db,
      ),
    );
  }
  // A page filter of the dashboard too.
  await notIndexed(() =>
    runQuery(
      PROJECT,
      metricQuery("trace_count", "count"),
      {
        ...PARITY_WINDOW,
        filter: { properties: { tenant: ["x"] } },
      },
      database.db,
    ),
  );
});

test("a widget on a property that is no longer indexed shows that state, not a database error", async () => {
  const widget = {
    title: "By plan",
    chart: "table" as const,
    query: formQuery(
      formOf(metricQuery("trace_count", "count", { dimensions: [{ property: "plan" }] })),
      "table",
      "day",
    ),
  };
  const before = await loadWidget(PROJECT, widget, PARITY_WINDOW, database.db as never);
  assert.equal(before?.kind, "sql");
  await database.client.query(
    "update trace_property_keys set state = 'detected' where name = 'plan'",
  );
  try {
    const after = await loadWidget(PROJECT, widget, PARITY_WINDOW, database.db as never);
    assert.deepEqual(after?.kind === "refused" && [after.code, after.property], [
      "property_not_indexed",
      "plan",
    ]);
  } finally {
    await database.client.query(
      "update trace_property_keys set state = 'indexed' where name = 'plan'",
    );
  }
});

/**
 * Tasks: t1 runs checkout (its OTLP turn) and refund (one of its events is a step of a runtime
 * turn), t2 runs refund. The other project has a run of checkout on a trace named t3: it is no run
 * of this project's t3.
 */
async function seedTasks(client: Awaited<ReturnType<typeof traceDatabase>>["client"]) {
  const turn = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
  await client.exec(`
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id) values
      ('${turn(1)}', '${PROJECT}', 's1', 'otlp:t1', 'otlp', 'otlp', 'closed', '2026-11-02T09:10:00Z', '2026-11-02T09:11:00Z', '2026-11-02T09:11:00Z', 'checkout'),
      ('${turn(2)}', '${PROJECT}', 's1', 'inferred:e1', 'inferred', 'runtime', 'closed', '2026-11-02T09:10:00Z', '2026-11-02T09:11:00Z', '2026-11-02T09:11:00Z', 'refund'),
      ('${turn(3)}', '${PROJECT}', 's1', 'otlp:t2', 'otlp', 'otlp', 'closed', '2026-11-02T09:40:00Z', '2026-11-02T09:41:00Z', '2026-11-02T09:41:00Z', 'refund'),
      ('${turn(4)}', '${OTHER_PROJECT}', 's9', 'otlp:t3', 'otlp', 'otlp', 'closed', '2026-11-02T11:00:00Z', '2026-11-02T11:01:00Z', '2026-11-02T11:01:00Z', 'secret');
    insert into trace_events (id, project_id, client_event_id, trace_id, type, schema_version, session_id, occurred_at, payload)
    values ('${turn(5)}', '${PROJECT}', 'task-e1', 't1', 'invoke_start', 1, 's1', '2026-11-02T09:10:30Z', '{}');
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at)
    values ('${turn(2)}', '${PROJECT}', 1, 'invoke', 'invoke_start', '${turn(5)}', '2026-11-02T09:10:30Z', '2026-11-02T09:10:30Z');
  `);
}

async function rows(text: string): Promise<Record<string, unknown>> {
  const result = await runQuery(PROJECT, sqlQuery(text), PARITY_WINDOW, database.db);
  return Object.fromEntries(result.rows.map((row) => [String(row[0]), round(row[1])]));
}

function formValues(result: MetricResult, shape: "day" | "total"): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const { groups, total, values: series } of result.series)
    values[groups.map(({ value }) => value).join(" | ")] =
      shape === "total" ? round(total) : series.map(round);
  return sorted(values);
}

function rqlValues(
  result: SqlResult,
  aggregation: Aggregation,
  shape: "day" | "total",
): Record<string, unknown> {
  if (shape === "day") {
    const drawn = sqlAsMetric(result, {
      window: PARITY_WINDOW,
      bucket: "day",
      nothing: nothingIsZero(aggregation) ? 0 : null,
    });
    assert.ok(drawn, "drawn as a chart");
    return sorted(
      Object.fromEntries(
        drawn.series.map(({ groups, values }) => [
          groups.map(({ value }) => value).join(" | "),
          values.map(round),
        ]),
      ),
    );
  }
  return sorted(
    Object.fromEntries(
      result.rows.map((row) => [row.slice(0, -1).map(String).join(" | "), round(row.at(-1))]),
    ),
  );
}

function sqlQuery(text: string): SqlQuery {
  return { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION };
}

function sorted(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function round(value: unknown): number | null {
  return typeof value === "number" ? Math.round(value * 1e9) / 1e9 : null;
}
