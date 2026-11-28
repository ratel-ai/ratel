import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { metricQuery } from "@/lib/contracts/query";
import { tableSummary } from "@/lib/mcp/operations/monitoring/results";
import type { getDb } from "@/lib/platform/db/client";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { metricSeams, type SqlResult } from "@/lib/synthesis/metrics/query";
import { ORG, PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { compileRql, RQL_LIMITS } from "@/lib/synthesis/rql/compile";
import type { RqlExecutor } from "@/lib/synthesis/rql/ports/executor";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import { evaluateAlerts } from "@/lib/views/alerts/evaluate";
import { METRIC_TO_SQL_WARNING } from "@/lib/views/alerts/format";
import { measureSqlValue } from "@/lib/views/alerts/sql-value";
import * as alerts from "@/lib/views/alerts/store";
import { loadWidget, loadWidgets } from "@/lib/views/dashboards/data";
import { metricAsRql, sqlRangeProblem } from "@/lib/views/dashboards/edit-as-sql";
import { sqlAsMetric, sqlResultNotes } from "@/lib/views/dashboards/sql-chart";
import { sqlWidgetQuery } from "@/lib/views/dashboards/widget";

/**
 * The major findings of the review of RQL in Explore, dashboards and alerts: each as the case that
 * showed it. Every query runs on PGlite through the RQL path; a held executor stands for a slow one.
 */

const OTHER = "33333333-3333-4333-8333-333333333333";
const DAY_MS = 86_400_000;
const NOW = new Date("2026-11-24T12:00:00Z");
const SCOPE: QueryScope = { since: new Date(NOW.getTime() - DAY_MS), until: NOW };
type Db = ReturnType<typeof getDb>;

let database: Awaited<ReturnType<typeof traceDatabase>>;
let real: RqlExecutor;

before(async () => {
  database = await traceDatabase();
  await database.client.exec(
    `insert into projects (id, organization_id, name, slug) values ('${OTHER}', '${ORG}', 'Other', 'other')`,
  );
  const traces = [];
  // One trace an hour for 60 days, with a wide attribute.
  for (let hour = 0; hour < 60 * 24; hour++)
    traces.push({
      id: `t${hour}`,
      startedAt: new Date(NOW.getTime() - (hour + 1) * 3_600_000).toISOString(),
      root: { durationMs: 100, serviceName: "api", attributes: { big: "x".repeat(3000) } },
    });
  await database.seed(traces);
  real = createPgRqlExecutor(pglitePoolOf(database.client));
  useExecutor(real);
});
after(() => database.client.close());

function useExecutor(executor: RqlExecutor, gate = createRqlGate()) {
  metricSeams.sql = sqlQueryRunner({ run: { executor, gate, observe: async () => {} } });
}

/** An executor that answers once `release` is called: the reads it holds wait for it. */
function held() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor: RqlExecutor = {
    execute: async (run) => {
      await gate;
      return real.execute(run);
    },
  };
  return { executor, release };
}

const sqlWidget = (text: string) => ({
  title: "",
  chart: "sql" as const,
  query: sqlWidgetQuery(text),
});
const db = () => database.db as never;

test("major 1: project B's rule evaluates in the same tick while project A has 20 slow rules", async () => {
  const slow: RqlExecutor = {
    execute: async (run) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return real.execute(run);
    },
  };
  useExecutor(slow);
  try {
    const store = database.db as unknown as Db;
    const base = {
      operator: "above" as const,
      threshold: 1,
      windowMinutes: 5 as const,
      destinationIds: [],
    };
    for (let i = 0; i < 20; i++)
      await alerts.createAlertRule(
        PROJECT,
        { ...base, name: `slow ${i}`, query: sqlWidgetQuery("select count(*) from traces") },
        "u",
        store,
      );
    const victim = await alerts.createAlertRule(
      OTHER,
      { ...base, name: "victim", query: metricQuery("trace_count", "count") },
      "u",
      store,
    );
    assert.ok(victim);
    const tick = new Date(NOW.getTime() + 60_000);
    await database.client.query("update alert_rules set last_evaluated_at = $1", [NOW]);
    // B's rule is the last due: before the fix it waited behind every rule of A.
    await database.client.query("update alert_rules set last_evaluated_at = $1 where id = $2", [
      new Date(NOW.getTime() + 1),
      victim,
    ]);
    await evaluateAlerts(
      { now: () => tick, flagOn: async () => true, timeBudgetMs: 400, projectBudgetMs: 200 },
      store,
    );
    const [row] = (
      await database.client.query<{ last_evaluated_at: Date }>(
        "select last_evaluated_at from alert_rules where id = $1",
        [victim],
      )
    ).rows;
    assert.equal(new Date(row.last_evaluated_at).getTime(), tick.getTime());
    await database.client.exec("delete from alert_rules");
  } finally {
    useExecutor(real);
  }
});

test("major 2: two readers load a dashboard of 6 sql widgets with no refused widget, and an alert reads meanwhile", async () => {
  const { executor, release } = held();
  useExecutor(executor);
  try {
    const widgets = Array.from({ length: 6 }, () => sqlWidget("select count(*) from traces"));
    const load = () =>
      loadWidgets(PROJECT, widgets, SCOPE, { customMonitoring: true }, (project, widget, scope) =>
        loadWidget(project, widget, scope, db()),
      );
    const first = load();
    const second = load();
    const alert = measureSqlValue(PROJECT, sqlWidgetQuery("select count(*) from traces"), SCOPE, {
      reserved: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const results = [...(await first), ...(await second)];
    assert.deepEqual(
      results.map((result) => result?.kind),
      Array.from({ length: 12 }, () => "sql"),
    );
    assert.deepEqual(await alert, { value: 24 });
  } finally {
    useExecutor(real);
  }
});

test("major 3: Edit as SQL is refused over 30 days, with the reason", () => {
  const range = (preset: string, from: string, to: string) => ({ preset, from, to });
  assert.equal(sqlRangeProblem(range("30d", "2026-10-26", "2026-11-24")), null);
  for (const long of [
    range("3m", "2026-08-26", "2026-11-24"),
    range("12m", "2025-11-25", "2026-11-24"),
    range("custom", "2026-10-01", "2026-11-24"),
  ]) {
    const reason = sqlRangeProblem(long);
    assert.ok(reason, long.preset);
    assert.match(reason, new RegExp(`at most ${RQL_LIMITS.maxWindowDays} days`));
  }
});

test("major 3: a stored sql widget on a 3 month range shows the rows of the last 30 days, with a note", async () => {
  const scope = { since: new Date(NOW.getTime() - 90 * DAY_MS), until: NOW };
  const result = await loadWidget(PROJECT, sqlWidget("select count(*) from traces"), scope, db());
  assert.equal(result?.kind, "sql");
  const sql = result as SqlResult;
  assert.equal(sql.clampedToDays, RQL_LIMITS.maxWindowDays);
  assert.deepEqual(sql.rows, [[RQL_LIMITS.maxWindowDays * 24]]);
  assert.match(sqlResultNotes(sql).join(" "), /last 30 days/);
});

test("major 4: a truncated result drawn as a chart still says it is truncated", () => {
  const result: SqlResult = {
    kind: "sql",
    columns: [
      { name: "bucket", type: "timestamp" },
      { name: "value", type: "integer" },
    ],
    rows: [["2026-11-02T09:00:00.000Z", 1]],
    truncated: true,
  };
  assert.ok(sqlAsMetric(result), "drawn as a chart");
  assert.match(sqlResultNotes(result).join(" "), /Truncated/);
  assert.deepEqual(sqlResultNotes({ ...result, truncated: false }), []);
});

test("major 4: Edit as SQL keeps the newest buckets when the rows pass the cap", () => {
  const rql = metricAsRql(
    {
      title: "",
      chart: "line",
      query: metricQuery("trace_count", "count", { dimensions: ["service"], bucket: "hour" }),
    },
    "hour",
  );
  assert.ok(rql.ok);
  assert.match(rql.text, /order by bucket desc/);
});

test("major 5: the Metric to SQL switch names both differences", () => {
  assert.match(METRIC_TO_SQL_WARNING, /late/);
  assert.match(METRIC_TO_SQL_WARNING, /no value/);
  assert.match(METRIC_TO_SQL_WARNING, /0/);
});

test("major 6: a dashboard of wide sql widgets stays under the result cap of each widget", async () => {
  const wide = sqlWidget(
    `select ${Array.from({ length: 10 }, () => "attributes").join(", ")} from events limit 1000`,
  );
  const results = await loadWidgets(
    PROJECT,
    Array.from({ length: 6 }, () => wide),
    { since: new Date(NOW.getTime() - 30 * DAY_MS), until: NOW },
    { customMonitoring: true },
    (project, widget, scope) => loadWidget(project, widget, scope, db()),
  );
  for (const result of results) {
    assert.equal(result?.kind, "sql");
    const sql = result as SqlResult;
    assert.ok(Buffer.byteLength(JSON.stringify(sql.rows)) <= RQL_LIMITS.maxResultBytes);
    assert.equal(sql.truncated, true);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(results)) <= 6 * (RQL_LIMITS.maxResultBytes + 10_000));
});

test("minor: Edit as SQL prints a filter number RQL can read", () => {
  for (const value of [1e-7, 1e21, 0.1 + 0.2]) {
    const rql = metricAsRql(
      {
        title: "",
        chart: "number",
        query: metricQuery("trace_count", "count", { filters: { minCostUsd: value } }),
      },
      "hour",
    );
    assert.ok(rql.ok);
    assert.ok(compileRql(rql.text, { now: NOW }).ok, rql.text);
  }
});

test("minor: a context metric gives its own reason, not the rate's", () => {
  const rql = metricAsRql(
    { title: "", chart: "number", query: metricQuery("context_tokens", "avg") },
    "hour",
  );
  assert.ok(!rql.ok);
  assert.doesNotMatch(rql.reason, /rate/);
});

test("minor: an output name over maxAliasChars is refused", () => {
  const name = (n: number) => `"${"n".repeat(n)}"`;
  assert.ok(
    compileRql(`select count(*) as ${name(RQL_LIMITS.maxAliasChars)} from traces`, { now: NOW }).ok,
  );
  const long = compileRql(`select count(*) as ${name(500)} from traces`, { now: NOW });
  assert.ok(!long.ok);
  assert.match(long.error.message, new RegExp(`at most ${RQL_LIMITS.maxAliasChars}`));
});

test("an alert preview reads on the interactive path: a full alert gate never refuses it", async () => {
  const alertGate = createRqlGate(1);
  const held = alertGate.enter(PROJECT);
  assert.ok(held, "the evaluator holds the one alert place of the project");
  metricSeams.sql = sqlQueryRunner({
    run: { executor: real, gate: createRqlGate(), observe: async () => {} },
    alertGate,
  });
  try {
    const preview = await measureSqlValue(
      PROJECT,
      sqlWidgetQuery("select count(*) from traces"),
      SCOPE,
    );
    assert.deepEqual(preview, { value: 24 });
  } finally {
    held();
    useExecutor(real);
  }
});

test("MCP says the notes of an sql result as the console does", () => {
  const result: SqlResult = {
    kind: "sql",
    columns: [{ name: "traces", type: "integer" }],
    rows: [[1]],
    truncated: true,
    clampedToDays: 30,
  };
  const summary = tableSummary(result);
  for (const note of sqlResultNotes(result))
    assert.ok(summary.includes(note), `${summary}\n${note}`);
});
