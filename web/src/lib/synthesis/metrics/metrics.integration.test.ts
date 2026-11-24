import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { eventMetrics, events } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { resolveRange } from "@/lib/synthesis/dashboard";
import {
  METRIC_GROUP_LIMIT,
  METRICS,
  type MetricRequest,
  MetricRequestError,
} from "@/lib/synthesis/metrics/catalog";
import { type MetricsDb, queryMetric } from "@/lib/synthesis/metrics/query";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";

/**
 * Seeded, 2026-11-02 to 2026-11-04 (4 days in the window, the last two empty or sparse):
 * t1 11-02 09:10 100 ms ok     30 tok $0.1 gpt-4o       tools a    support/prod    agent planner
 * t2 11-02 10:20 300 ms failed 70 tok $0.3 gpt-4o+haiku tools a,b  support/staging agent planner
 * t3 11-03 09:00 500 ms ok    100 tok $0.6 haiku        no tool    billing/prod    agent helper
 * t4 11-03 09:30 tool error, root ok 900 ms 0 tok $0, no property at all
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const WINDOW = resolveRange({ range: "custom", from: "2026-11-02", to: "2026-11-05" });
const DAYS = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].map(
  (day) => `${day}T00:00:00.000Z`,
);

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: MetricsDb;

before(async () => {
  client = await createMigratedPGlite();
  const orm = drizzle(client, { schema });
  db = orm as unknown as MetricsDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
  await orm.insert(otelTraceSummaries).values([
    trace("t1", "2026-11-02T09:10:00Z", {
      durationMs: 100,
      inputTokens: 20,
      outputTokens: 10,
      costUsd: "0.1",
      models: ["gpt-4o"],
      tools: ["a"],
      serviceName: "support",
      environment: "prod",
      agents: ["planner"],
    }),
    trace("t2", "2026-11-02T10:20:00Z", {
      durationMs: 300,
      hasError: true,
      rootError: true,
      inputTokens: 50,
      outputTokens: 20,
      costUsd: "0.3",
      models: ["gpt-4o", "haiku"],
      tools: ["a", "b"],
      serviceName: "support",
      environment: "staging",
      agents: ["planner"],
    }),
    trace("t3", "2026-11-03T09:00:00Z", {
      durationMs: 500,
      inputTokens: 60,
      outputTokens: 40,
      costUsd: "0.6",
      models: ["haiku"],
      serviceName: "billing",
      environment: "prod",
      agents: ["helper"],
    }),
    trace("t4", "2026-11-03T09:30:00Z", { durationMs: 900, hasError: true, rootError: false }),
    // Outside the window, and another project's.
    trace("t5", "2026-11-06T00:00:00Z", { durationMs: 9_000 }),
    { ...trace("t6", "2026-11-02T09:00:00Z", { durationMs: 9_000 }), projectId: OTHER },
  ]);
  for (const [index, at] of ["2026-11-02T01:00:00Z", "2026-11-02T23:00:00Z"].entries()) {
    const [event] = await orm
      .insert(events)
      .values({ projectId: PROJECT, occurredAt: new Date(at), dedupeHash: `e${index}` })
      .returning({ id: events.id });
    await orm.insert(eventMetrics).values({
      eventId: event.id,
      projectId: PROJECT,
      eventTime: new Date(at),
      tokensByCategory: { skills: 1, tools: 2, history: 3, memory: 4, user_input: 10 },
      splits: { history_cached: 0, history_uncached: 3, tools_used: 1, tools_unused: 1 },
      costUsd: index === 0 ? "0.5" : null,
      categorizerVersion: 1,
    });
  }
});

after(() => client.close());

test("each metric returns its series by day, with the window's total", async () => {
  const cases: [string, string, (number | null)[], number | null][] = [
    ["trace_count", "count", [2, 2, 0, 0], 4],
    // The run's own outcome, as on the Traces KPI band: t4's tool error is not a failed trace.
    ["error_rate", "rate", [0.5, 0, null, null], 0.25],
    ["latency", "p50", [200, 700, null, null], 400],
    ["latency", "p95", [290, 880, null, null], 840],
    ["tokens", "sum", [100, 100, 0, 0], 200],
    ["tokens", "avg", [50, 50, null, null], 50],
    ["cost", "sum", [0.4, 0.6, 0, 0], 1],
    ["cost", "avg", [0.2, 0.3, null, null], 0.25],
    ["context_tokens", "sum", [40, 0, 0, 0], 40],
    ["context_cost", "sum", [0.5, 0, 0, 0], 0.5],
  ];
  for (const [metric, aggregation, values, total] of cases) {
    const result = await run({ metric, aggregation });
    assert.equal(result.bucket, "day", metric);
    assert.deepEqual(result.buckets, DAYS);
    assert.equal(result.series.length, 1);
    assert.equal(result.series[0].group, null);
    assertClose(result.series[0].values, values, `${metric} ${aggregation}`);
    assertClose([result.series[0].total], [total], `${metric} ${aggregation} total`);
  }
  // Every aggregation of the catalog is covered above.
  assert.equal(
    cases.length,
    METRICS.reduce((sum, metric) => sum + metric.aggregations.length, 0),
  );
});

test("empty data: zero for an amount, null for a rate, an average and a percentile", async () => {
  const window = resolveRange({ range: "custom", from: "2025-01-01", to: "2025-01-05" });
  for (const metric of METRICS) {
    for (const aggregation of metric.aggregations) {
      const empty = aggregation === "count" || aggregation === "sum" ? 0 : null;
      const { series } = await run({ metric: metric.id, aggregation, window });
      assert.deepEqual(series, [
        { group: null, total: empty, samples: 0, values: Array(5).fill(empty) },
      ]);
      for (const groupBy of metric.groupBys) {
        const grouped = await run({ metric: metric.id, aggregation, groupBy, window });
        assert.deepEqual(grouped.series, []);
      }
    }
  }
});

test("a filter narrows every trace metric", async () => {
  const filter = { services: ["support"] };
  const total = async (metric: string, aggregation: string) =>
    (await run({ metric, aggregation, filter })).series[0].total;
  assert.equal(await total("trace_count", "count"), 2);
  assert.equal(await total("error_rate", "rate"), 0.5);
  assert.equal(await total("latency", "p50"), 200);
  assert.equal(await total("latency", "p95"), 290);
  assert.equal(await total("tokens", "sum"), 100);
  assertClose([await total("cost", "sum")], [0.4], "cost");
});

test("group by each property: a trace counts once in each of its groups", async () => {
  const groups = async (groupBy: string, metric = "trace_count", aggregation = "count") =>
    (await run({ metric, aggregation, groupBy })).series.map((s) => [s.group, s.total]);
  assert.deepEqual(await groups("model"), [
    ["gpt-4o", 2],
    ["haiku", 2],
  ]);
  assert.deepEqual(await groups("tool"), [
    ["a", 2],
    ["b", 1],
  ]);
  assert.deepEqual(await groups("service"), [
    ["support", 2],
    ["billing", 1],
  ]);
  assert.deepEqual(await groups("environment"), [
    ["prod", 2],
    ["staging", 1],
  ]);
  assert.deepEqual(await groups("agent"), [
    ["planner", 2],
    ["helper", 1],
  ]);
  assert.deepEqual(await groups("service", "latency", "p95"), [
    ["billing", 500],
    ["support", 290],
  ]);
  assert.deepEqual(await groups("service", "error_rate", "rate"), [
    ["support", 0.5],
    ["billing", 0],
  ]);
  const [gpt] = (await run({ metric: "tokens", aggregation: "sum", groupBy: "model" })).series;
  assert.deepEqual(gpt, { group: "haiku", total: 170, samples: 2, values: [70, 100, 0, 0] });
});

test("a filter on the grouped property keeps only the groups it names", async () => {
  const { series } = await run({
    metric: "trace_count",
    aggregation: "count",
    groupBy: "model",
    filter: { models: ["gpt-4o"] },
  });
  assert.deepEqual(
    series.map((s) => s.group),
    ["gpt-4o"],
  );
});

test("a short window is read by the hour, in UTC", async () => {
  const window = resolveRange({ range: "custom", from: "2026-11-02", to: "2026-11-02" });
  const { bucket, buckets, series } = await run({
    metric: "trace_count",
    aggregation: "count",
    window,
  });
  assert.equal(bucket, "hour");
  assert.equal(buckets.length, 24);
  assert.equal(series[0].values[buckets.indexOf("2026-11-02T09:00:00.000Z")], 1);
  assert.equal(series[0].values[buckets.indexOf("2026-11-02T10:00:00.000Z")], 1);
  assert.equal(series[0].total, 2);
  // event_metrics is a by-day metric even there.
  const context = await run({ metric: "context_tokens", aggregation: "sum", window });
  assert.deepEqual(context.series[0].values, [40]);
});

test("buckets stay in UTC under another database time zone", async () => {
  await client.exec("set time zone 'America/Los_Angeles'");
  try {
    const { series } = await run({ metric: "trace_count", aggregation: "count" });
    assert.deepEqual(series[0].values, [2, 2, 0, 0]);
  } finally {
    await client.exec("set time zone 'UTC'");
  }
});

test("a grouped result keeps the top 10 groups", async () => {
  const orm = drizzle(client, { schema });
  await orm.insert(otelTraceSummaries).values(
    Array.from({ length: 12 }, (_, index) => ({
      ...trace(`g${index}`, "2026-11-02T09:00:00Z", {
        inputTokens: index + 1,
        serviceName: `svc-${index}`,
      }),
      projectId: OTHER,
    })),
  );
  const { series } = await queryMetric(
    OTHER,
    { metric: "tokens", aggregation: "sum", groupBy: "service", window: WINDOW },
    db,
  );
  assert.equal(series.length, METRIC_GROUP_LIMIT);
  assert.equal(series[0].group, "svc-11");
  assert.equal(series[9].group, "svc-2");
});

test("a request the entry does not allow is refused", async () => {
  const base = { metric: "latency", aggregation: "p95" };
  const refused: Partial<MetricRequest>[] = [
    { metric: "nope" },
    { metric: "toString" },
    { aggregation: "sum" },
    { aggregation: "p95); drop table projects" },
    { groupBy: "customer" },
    { metric: "context_tokens", aggregation: "sum", groupBy: "model" },
    { metric: "context_tokens", aggregation: "sum", filter: { models: ["gpt-4o"] } },
    { metric: "context_tokens", aggregation: "sum", bucket: "hour" },
    { window: { since: WINDOW.until, until: WINDOW.since } },
    { window: { since: new Date("2020-01-01"), until: new Date("2026-01-01") } },
    { window: { since: new Date("nope"), until: new Date("2026-01-01") } },
  ];
  for (const request of refused) {
    await assert.rejects(run({ ...base, ...request }), MetricRequestError, JSON.stringify(request));
  }
});

function run(request: Omit<MetricRequest, "window"> & Partial<Pick<MetricRequest, "window">>) {
  return queryMetric(PROJECT, { window: WINDOW, ...request }, db);
}

function trace(
  traceId: string,
  startedAt: string,
  values: Partial<typeof otelTraceSummaries.$inferInsert>,
): typeof otelTraceSummaries.$inferInsert {
  return {
    projectId: PROJECT,
    traceId,
    startedAt: new Date(startedAt),
    durationMs: 0,
    hasError: false,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: "0",
    spansMaxReceivedAt: new Date(startedAt),
    ...values,
  };
}

function assertClose(actual: (number | null)[], expected: (number | null)[], message: string) {
  assert.equal(actual.length, expected.length, message);
  for (const [index, value] of actual.entries()) {
    const want = expected[index];
    if (value === null || want === null) assert.equal(value, want, message);
    else assert.ok(Math.abs(value - want) < 1e-6, `${message}: ${value} is not ${want}`);
  }
}
