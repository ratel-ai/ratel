import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { resolveRange } from "@/lib/synthesis/dashboard";
import { type MetricRequest, MetricRequestError } from "@/lib/synthesis/metrics/catalog";
import { type MetricsDb, queryMetric } from "@/lib/synthesis/metrics/query";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";
import { traceScorers, traceScores } from "./schema";
import { checkDraft, judgeDraft } from "./test-support";
import "./metrics";

/**
 * Seeded, 2026-11-02 to 2026-11-05 in the window:
 *                       t1 11-02    t2 11-02       t3 11-03   t4 11-03 (its summary is gone)
 * Fast (check)          pass        fail           pass       pass
 * Polite (boolean)      fail        fail           -          -
 * Depth (1 to 5)        2           4              5          -
 * t1 gpt-4o support/prod, t2 gpt-4o+haiku support/staging, t3 haiku billing/prod
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const FAST = "aaaaaaaa-0000-4000-8000-000000000001";
const POLITE = "bbbbbbbb-0000-4000-8000-000000000002";
const DEPTH = "cccccccc-0000-4000-8000-000000000003";
const FOREIGN = "dddddddd-0000-4000-8000-000000000004";
const WINDOW = resolveRange({ range: "custom", from: "2026-11-02", to: "2026-11-05" });
const STARTS: Record<string, string> = {
  t1: "2026-11-02T09:00:00Z",
  t2: "2026-11-02T10:00:00Z",
  t3: "2026-11-03T09:00:00Z",
  t4: "2026-11-03T10:00:00Z",
  t5: "2026-11-06T10:00:00Z",
};

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let orm: ReturnType<typeof drizzle<typeof schema>>;

before(async () => {
  client = await createMigratedPGlite();
  orm = drizzle(client, { schema });
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
  const by = { createdBy: "u", updatedBy: "u" };
  await orm.insert(traceScorers).values([
    { ...checkDraft({ name: "Fast" }), ...by, id: FAST, projectId: PROJECT },
    { ...judgeDraft({ name: "Polite" }), ...by, id: POLITE, projectId: PROJECT },
    {
      ...judgeDraft({ name: "Depth", config: { prompt: "How deep?", output: "numeric" } }),
      ...by,
      id: DEPTH,
      projectId: PROJECT,
    },
    { ...checkDraft({ name: "Theirs" }), ...by, id: FOREIGN, projectId: OTHER },
  ]);
  await orm
    .insert(otelTraceSummaries)
    .values([
      summary("t1", ["gpt-4o"], "support", "prod"),
      summary("t2", ["gpt-4o", "haiku"], "support", "staging"),
      summary("t3", ["haiku"], "billing", "prod"),
    ]);
  await orm.insert(traceScores).values([
    verdict(FAST, "t1", true),
    verdict(FAST, "t2", false),
    verdict(FAST, "t3", true),
    verdict(FAST, "t4", true),
    verdict(POLITE, "t1", false),
    verdict(POLITE, "t2", false),
    { ...verdict(DEPTH, "t1", true), value: 2, passed: null },
    { ...verdict(DEPTH, "t2", true), value: 4, passed: null },
    { ...verdict(DEPTH, "t3", true), value: 5, passed: null },
    // Outside the window, and another project's.
    verdict(FAST, "t5", false),
    { ...verdict(FOREIGN, "t1", true), projectId: OTHER },
  ]);
});

after(() => client.close());

test("pass rate, average and count by day, over every scorer they apply to", async () => {
  const rate = await run("scorer_pass_rate", "rate");
  close(rate.series[0].values, [0.25, 1, null, null]);
  close([rate.series[0].total], [0.5]);
  // Numeric results have no verdict, and verdicts have no average.
  assert.equal(rate.series[0].samples, 6);
  const average = await run("scorer_average", "avg");
  close(average.series[0].values, [3, 5, null, null]);
  close([average.series[0].total], [11 / 3]);
  const count = await run("scorer_count", "count");
  close(count.series[0].values, [6, 3, 0, 0]);
  assert.equal(count.series[0].total, 9);
});

test("a scorer filter keeps that scorer's results only", async () => {
  const rate = await run("scorer_pass_rate", "rate", { scorerId: FAST });
  close(rate.series[0].values, [0.5, 1, null, null]);
  assert.equal(rate.series[0].total, 0.75);
  assert.equal((await run("scorer_count", "count", { scorerId: DEPTH })).series[0].total, 3);
  const foreign = await run("scorer_count", "count", { scorerId: FOREIGN });
  assert.equal(foreign.series[0].total, 0);
});

test("grouped by scorer, a series is keyed by the scorer and named after it", async () => {
  const { series } = await run("scorer_pass_rate", "rate", { groupBy: "scorer" });
  assert.deepEqual(
    series.map(({ group, label, total }) => [group, label, total]),
    [
      [FAST, "Fast", 0.75],
      [POLITE, "Polite", 0],
    ],
  );
  close(series[0].values, [0.5, 1, null, null]);
  close(series[1].values, [0, null, null, null]);
});

test("two scorers of one name stay two series, told apart", async () => {
  await orm.execute(`update trace_scorers set name = 'Fast' where id = '${POLITE}'`);
  try {
    const { series } = await run("scorer_pass_rate", "rate", { groupBy: "scorer" });
    assert.deepEqual(
      series.map(({ label }) => label),
      ["Fast (aaaaaaaa)", "Fast (bbbbbbbb)"],
    );
  } finally {
    await orm.execute(`update trace_scorers set name = 'Polite' where id = '${POLITE}'`);
  }
});

test("grouped by a trace property, with a scorer filter", async () => {
  const groups = async (groupBy: string) =>
    (await run("scorer_pass_rate", "rate", { groupBy, scorerId: FAST })).series.map((s) => [
      s.group,
      s.total,
      s.samples,
    ]);
  assert.deepEqual(await groups("model"), [
    ["gpt-4o", 0.5, 2],
    ["haiku", 0.5, 2],
  ]);
  assert.deepEqual(await groups("service"), [
    ["billing", 1, 1],
    ["support", 0.5, 2],
  ]);
  assert.deepEqual(await groups("environment"), [
    ["prod", 1, 2],
    ["staging", 0, 1],
  ]);
  const { series } = await run("scorer_average", "avg", { groupBy: "model" });
  assert.deepEqual(
    series.map((s) => [s.group, s.values]),
    [
      ["haiku", [4, 5, null, null]],
      ["gpt-4o", [3, null, null, null]],
    ],
  );
});

test("a trace filter narrows the results", async () => {
  const { series } = await run("scorer_count", "count", { filter: { services: ["support"] } });
  assert.equal(series[0].total, 6);
});

test("a request the entries do not allow is refused", async () => {
  const refused: [string, string, Partial<MetricRequest>][] = [
    ["scorer_pass_rate", "avg", {}],
    ["scorer_average", "avg", { groupBy: "tool" }],
    ["scorer_count", "count", { scorerId: "nope" }],
    ["trace_count", "count", { scorerId: FAST }],
    ["trace_count", "count", { groupBy: "scorer" }],
  ];
  for (const [metric, aggregation, rest] of refused)
    await assert.rejects(run(metric, aggregation, rest), MetricRequestError, metric);
});

function run(metric: string, aggregation: string, rest: Partial<MetricRequest> = {}) {
  return queryMetric(
    PROJECT,
    { metric, aggregation, window: WINDOW, ...rest },
    orm as unknown as MetricsDb,
  );
}

function summary(
  traceId: string,
  models: string[],
  serviceName: string,
  environment: string,
): typeof otelTraceSummaries.$inferInsert {
  return {
    projectId: PROJECT,
    traceId,
    startedAt: new Date(STARTS[traceId]),
    durationMs: 0,
    hasError: false,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: "0",
    spansMaxReceivedAt: new Date(STARTS[traceId]),
    models,
    serviceName,
    environment,
  };
}

function verdict(scorerId: string, traceId: string, passed: boolean) {
  return {
    scorerId,
    traceId,
    projectId: PROJECT,
    value: passed ? 1 : 0,
    passed,
    traceStartedAt: new Date(STARTS[traceId]),
  };
}

function close(actual: (number | null)[], expected: (number | null)[]) {
  assert.equal(actual.length, expected.length);
  for (const [index, value] of actual.entries()) {
    const want = expected[index];
    if (value === null || want === null) assert.equal(value, want);
    else assert.ok(Math.abs(value - want) < 1e-6, `${value} is not ${want}`);
  }
}
