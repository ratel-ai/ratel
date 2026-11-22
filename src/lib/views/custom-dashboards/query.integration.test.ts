import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { runWidgetQuery, type WidgetResult } from "./query";

/** RC-887: `runWidgetQuery` over `otel_trace_summaries`. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const NOW = new Date("2026-11-18T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Db = ReturnType<typeof getDb>;

interface Summary {
  project?: string;
  trace: string;
  ago: number;
  duration: number;
  error?: boolean;
  input?: number;
  output?: number;
  cost?: number;
  models?: string[];
  tools?: string[];
  service?: string | null;
  environment?: string | null;
  dims?: Record<string, string>;
}

/**
 * Six traces in the project, one outside the 7-day window and one in another project:
 * t1..t6 durations 100..600, t2 and t5 failed.
 */
const SUMMARIES: Summary[] = [
  {
    trace: "t1",
    ago: 1 * HOUR,
    duration: 100,
    input: 10,
    output: 1,
    cost: 0.1,
    models: ["gpt"],
    tools: ["search"],
    service: "api",
    environment: "prod",
    dims: { client: "acme", session: "s1", end_user: "u1" },
  },
  {
    trace: "t2",
    ago: 2 * HOUR,
    duration: 200,
    error: true,
    input: 20,
    output: 2,
    cost: 0.2,
    models: ["gpt", "claude"],
    tools: ["search", "fetch"],
    service: "api",
    environment: "prod",
    dims: { client: "acme", session: "s1", end_user: "u1" },
  },
  {
    trace: "t3",
    ago: 1 * DAY + HOUR,
    duration: 300,
    input: 30,
    output: 3,
    cost: 0.3,
    models: ["claude"],
    tools: [],
    service: "worker",
    environment: "prod",
    dims: { client: "globex", session: "s2", end_user: "u2" },
  },
  {
    trace: "t4",
    ago: 1 * DAY + 2 * HOUR,
    duration: 400,
    input: 40,
    output: 4,
    cost: 0.4,
    models: ["claude"],
    tools: ["fetch"],
    service: "worker",
    environment: "staging",
    dims: { client: "initech", session: "s3", end_user: "u2" },
  },
  {
    trace: "t5",
    ago: 2 * DAY + HOUR,
    duration: 500,
    error: true,
    input: 50,
    output: 5,
    cost: 0.5,
    models: ["mistral"],
    tools: ["search"],
    service: null,
    environment: null,
    dims: { session: "s4" },
  },
  {
    trace: "t6",
    ago: 2 * DAY + 2 * HOUR,
    duration: 600,
    input: 60,
    output: 6,
    cost: 0.6,
    models: ["gpt"],
    tools: ["search"],
    service: "api",
    environment: "prod",
    dims: { client: "acme", session: "s5", end_user: "u3" },
  },
  {
    trace: "old",
    ago: 10 * DAY,
    duration: 9000,
    input: 900,
    output: 90,
    cost: 9,
    models: ["gpt"],
    tools: ["search"],
    service: "api",
    environment: "prod",
    dims: { client: "acme" },
  },
  {
    project: OTHER_PROJECT,
    trace: "x1",
    ago: HOUR,
    duration: 9000,
    input: 900,
    output: 90,
    cost: 9,
    models: ["gpt"],
    tools: ["search"],
    service: "api",
    environment: "prod",
    dims: { client: "acme" },
  },
];

async function setup(
  pivots: Array<{ key: string; presetId: string | null }>,
): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
  `);
  for (const [position, pivot] of pivots.entries()) {
    await client.query(
      `insert into project_pivots (project_id, key, label, preset_id, position) values ($1, $2, $2, $3, $4)`,
      [PROJECT, pivot.key, pivot.presetId, position],
    );
  }
  for (const row of SUMMARIES) {
    const at = new Date(NOW.getTime() - row.ago).toISOString();
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, models, tools, service_name, environment, dims, spans_max_received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $3)`,
      [
        row.project ?? PROJECT,
        row.trace,
        at,
        row.duration,
        row.error ?? false,
        row.input ?? 0,
        row.output ?? 0,
        row.cost ?? 0,
        row.models ?? [],
        row.tools ?? [],
        row.service ?? null,
        row.environment ?? null,
        JSON.stringify(row.dims ?? {}),
      ],
    );
  }
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

const ALL_PIVOTS = [
  { key: "client", presetId: "client" },
  { key: "session", presetId: "session" },
  { key: "end_user", presetId: "end_user" },
];

function total(metric: string, filter: Record<string, unknown> = {}) {
  return { metric, groupBy: null, chart: "kpi", rangeDays: 7, filter };
}

function grouped(metric: string, groupBy: string, topN?: number) {
  return { metric, groupBy, chart: "table", rangeDays: 7, filter: {}, ...(topN ? { topN } : {}) };
}

function values(result: WidgetResult): Array<[string | null, number | null, number]> {
  assert.equal(result.kind, "groups");
  if (result.kind !== "groups") return [];
  return result.groups.map((group) => [group.key, group.value, group.runs]);
}

test("each metric gives its value over the project's window", async () => {
  const { db } = await setup(ALL_PIVOTS);
  const run = (spec: unknown) => runWidgetQuery(PROJECT, spec, { db, now: NOW });
  assert.deepEqual(await run(total("runs")), { kind: "total", value: 6, runs: 6 });
  assert.deepEqual(await run(total("error_rate")), { kind: "total", value: 2 / 6, runs: 6 });
  assert.deepEqual(await run(total("p50")), { kind: "total", value: 350, runs: 6 });
  assert.deepEqual(await run(total("p95")), { kind: "total", value: 575, runs: 6 });
  assert.deepEqual(await run(total("tokens")), { kind: "total", value: 231, runs: 6 });
  const cost = await run(total("cost"));
  assert.equal(cost.kind, "total");
  assert.ok(cost.kind === "total" && Math.abs((cost.value ?? 0) - 2.1) < 1e-9);
  assert.deepEqual(await run(total("sessions")), { kind: "total", value: 5, runs: 6 });
  assert.deepEqual(await run(total("distinct_users")), { kind: "total", value: 3, runs: 6 });
});

test("a 30-day range reaches the older trace; another project's rows never count", async () => {
  const { db } = await setup(ALL_PIVOTS);
  assert.deepEqual(
    await runWidgetQuery(PROJECT, { ...total("runs"), rangeDays: 30 }, { db, now: NOW }),
    { kind: "total", value: 7, runs: 7 },
  );
});

test("each group-by groups the window's traces", async () => {
  const { db } = await setup(ALL_PIVOTS);
  const run = (spec: unknown) => runWidgetQuery(PROJECT, spec, { db, now: NOW });
  assert.deepEqual(values(await run({ ...grouped("runs", "day"), chart: "line" })), [
    ["2026-11-16", 2, 2],
    ["2026-11-17", 2, 2],
    ["2026-11-18", 2, 2],
  ]);
  assert.deepEqual(values(await run(grouped("runs", "model"))), [
    ["claude", 3, 3],
    ["gpt", 3, 3],
    ["mistral", 1, 1],
  ]);
  assert.deepEqual(values(await run(grouped("tokens", "tool"))), [
    ["search", 22 + 11 + 55 + 66, 4],
    ["fetch", 22 + 44, 2],
  ]);
  assert.deepEqual(values(await run(grouped("error_rate", "service"))), [
    ["api", 1 / 3, 3],
    ["worker", 0, 2],
    [null, 1, 1],
  ]);
  assert.deepEqual(values(await run(grouped("runs", "environment"))), [
    ["prod", 4, 4],
    [null, 1, 1],
    ["staging", 1, 1],
  ]);
  assert.deepEqual(values(await run(grouped("distinct_users", "pivot:client"))), [
    ["acme", 2, 3],
    [null, 0, 1],
    ["globex", 1, 1],
    ["initech", 1, 1],
  ]);
});

test("the TraceFilter narrows the traces", async () => {
  const { db } = await setup(ALL_PIVOTS);
  const run = (filter: Record<string, unknown>) =>
    runWidgetQuery(PROJECT, total("runs", filter), { db, now: NOW });
  assert.deepEqual(await run({ models: ["claude"] }), { kind: "total", value: 3, runs: 3 });
  assert.deepEqual(await run({ tools: ["fetch"], status: "failed" }), {
    kind: "total",
    value: 1,
    runs: 1,
  });
  assert.deepEqual(await run({ services: ["worker"], environments: ["staging"] }), {
    kind: "total",
    value: 1,
    runs: 1,
  });
  assert.deepEqual(await run({ minCostUsd: 0.45 }), { kind: "total", value: 2, runs: 2 });
  assert.deepEqual(await run({ minTokens: 40 }), { kind: "total", value: 3, runs: 3 });
});

test("a group-by keeps the top N and merges the rest into Other", async () => {
  const { db } = await setup(ALL_PIVOTS);
  const result = await runWidgetQuery(PROJECT, grouped("runs", "pivot:client", 1), {
    db,
    now: NOW,
  });
  assert.deepEqual(result, {
    kind: "groups",
    groupBy: "pivot:client",
    groups: [{ key: "acme", value: 3, runs: 3 }],
    other: { value: 3, runs: 3 },
  });
  const p95 = await runWidgetQuery(PROJECT, grouped("p95", "model", 2), { db, now: NOW });
  assert.equal(p95.kind, "groups");
  assert.deepEqual(
    p95.kind === "groups" ? p95.other : null,
    { value: 500, runs: 1 },
    "Other re-aggregates its rows",
  );
  const uncut = await runWidgetQuery(PROJECT, grouped("runs", "service"), { db, now: NOW });
  assert.equal(uncut.kind === "groups" ? uncut.other : undefined, null);
});

test("a day grouping is a time series: every day of the range, in day order, no Other, even with a top N", async () => {
  const { db } = await setup(ALL_PIVOTS);
  const result = await runWidgetQuery(
    PROJECT,
    { ...grouped("runs", "day", 1), rangeDays: 30 },
    { db, now: NOW },
  );
  assert.deepEqual(result, {
    kind: "groups",
    groupBy: "day",
    groups: [
      { key: "2026-11-08", value: 1, runs: 1 },
      { key: "2026-11-16", value: 2, runs: 2 },
      { key: "2026-11-17", value: 2, runs: 2 },
      { key: "2026-11-18", value: 2, runs: 2 },
    ],
    other: null,
  });
});

test("session and user metrics without their pivot, and a removed group-by pivot, read pivot missing", async () => {
  const { db } = await setup([{ key: "client", presetId: "client" }]);
  const run = (spec: unknown) => runWidgetQuery(PROJECT, spec, { db, now: NOW });
  assert.deepEqual(await run(total("sessions")), { kind: "pivot_missing", pivot: "session" });
  assert.deepEqual(await run(total("distinct_users")), {
    kind: "pivot_missing",
    pivot: "end_user",
  });
  assert.deepEqual(await run(grouped("runs", "pivot:tenant")), {
    kind: "pivot_missing",
    pivot: "tenant",
  });
});

test("a spec outside the whitelist is refused before any query", async () => {
  const db = {
    execute: () => assert.fail("no query for an invalid spec"),
    select: () => assert.fail("no pivot read for an invalid spec"),
  } as unknown as Db;
  assert.deepEqual(await runWidgetQuery(PROJECT, { ...total("runs"), metric: "revenue" }, { db }), {
    kind: "invalid",
    error: "unknown_metric",
  });
  assert.deepEqual(await runWidgetQuery(PROJECT, { ...total("runs"), rangeDays: 90 }, { db }), {
    kind: "invalid",
    error: "range_over_retention",
  });
});

test("a 30-day day grouping keeps all 31 dates the window touches, today included", async () => {
  const { client, db } = await setup(ALL_PIVOTS);
  await client.query(`delete from otel_trace_summaries`);
  // NOW is midday: the window starts at midday 30 days ago, so it touches 31 UTC dates.
  for (let day = 0; day <= 30; day += 1) {
    // One minute inside each end: the window is [now - 30 days, now).
    const at = new Date(
      NOW.getTime() - day * 24 * 60 * 60 * 1000 + (day === 30 ? 60_000 : day === 0 ? -60_000 : 0),
    ).toISOString();
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, models, tools, service_name, environment, dims, spans_max_received_at)
       values ($1, $2, $3, 1, false, 0, 0, 0, '{}', '{}', null, null, '{}'::jsonb, $3)`,
      [PROJECT, `t-day-${day}`, at],
    );
  }
  const result = await runWidgetQuery(
    PROJECT,
    { ...grouped("runs", "day"), rangeDays: 30 },
    { db, now: NOW },
  );
  assert.equal(result.kind, "groups");
  const keys = result.kind === "groups" ? result.groups.map((group) => group.key) : [];
  assert.equal(keys.length, 31);
  assert.equal(keys[0], "2026-10-19");
  assert.equal(keys.at(-1), "2026-11-18", "the newest day is never cut");
});
