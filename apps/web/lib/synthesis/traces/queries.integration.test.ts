import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { toOtelLogRows } from "@/lib/ingest/otlp/log-rows";
import { insertOtelLogs, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelLog, NewOtelSpan } from "@/lib/ingest/otlp/schema";
import type { DecodedLogRecord } from "@/lib/ingest/otlp/types";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";
import {
  EMPTY_TRACE_KPIS,
  getSpanAggregates,
  getTraceAggregates,
  getTraceDailyAggregates,
  getTraceDailyAggregatesFromSummaries,
  getTraceFacets,
  getTraceKpis,
  getTraceKpisFromSummaries,
  getTraceSpans,
  getTraceSpansWithTruncation,
  getTracesIngestDiagnostics,
  listOperations,
  listSpans,
  listTraceLifecycleEvents,
  listTraces,
  pruneExpiredOtelLogs,
  pruneExpiredOtelSpans,
  pruneExpiredTraceSummaries,
  type TraceMaintenanceDb,
  type TraceQueriesDb,
} from "./queries";
import { refreshTraceSummaries } from "./summary-refresh";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const TRACE_ID = "0123456789abcdef0123456789abcdef";

type TestDb = TraceMaintenanceDb &
  TraceQueriesDb &
  NonNullable<Parameters<typeof insertOtelSpans>[2]> &
  NonNullable<Parameters<typeof insertOtelLogs>[2]> &
  NonNullable<Parameters<typeof refreshTraceSummaries>[1]>;

test("getTraceSpans returns only the requested project's trace in stable span order", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(2),
        spanId: spanId(2),
        parentSpanId: spanId(1),
        name: "later-child",
        startedAt: new Date("2026-07-30T10:00:00.200Z"),
      }),
      span({
        id: uuid(1),
        spanId: spanId(1),
        name: "root",
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      span({
        id: uuid(3),
        spanId: spanId(3),
        parentSpanId: spanId(1),
        name: "tied-child",
        startedAt: new Date("2026-07-30T10:00:00.200Z"),
      }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span({
        id: uuid(4),
        projectId: OTHER_PROJECT_ID,
        spanId: spanId(4),
        name: "other-project",
      }),
    ],
    db,
  );

  const spans = await getTraceSpans(PROJECT_ID, TRACE_ID, db);

  assert.deepEqual(
    spans.map(({ projectId, spanId, name }) => ({ projectId, spanId, name })),
    [
      { projectId: PROJECT_ID, spanId: spanId(1), name: "root" },
      { projectId: PROJECT_ID, spanId: spanId(2), name: "later-child" },
      { projectId: PROJECT_ID, spanId: spanId(3), name: "tied-child" },
    ],
  );
  await client.close();
});

test("trace span loading caps an oversized trace and reports truncation", async () => {
  const { client, db } = await setup();
  const rows = Array.from({ length: 5_001 }, (_, index) =>
    span({
      id: uuid(index + 1),
      spanId: spanId(index + 1),
      startedAt: new Date(Date.parse("2026-07-30T10:00:00.000Z") + index),
    }),
  );
  await insertOtelSpans(PROJECT_ID, rows, db);

  const { spans, truncated } = await getTraceSpansWithTruncation(PROJECT_ID, TRACE_ID, db);

  assert.equal(spans.length, 5_000);
  assert.equal(spans.at(-1)?.spanId, spanId(5_000));
  assert.equal(truncated, true);
  await client.close();
});

test("listSpans filters child-span dimensions and paginates tied starts without overlap", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(10),
        traceId: traceId(10),
        spanId: spanId(10),
        name: "agent.run",
      }),
      span({
        id: uuid(11),
        traceId: traceId(10),
        spanId: spanId(11),
        parentSpanId: spanId(10),
        name: "execute_tool",
        kind: 3,
        spanClass: "tool",
        model: "gpt-5.5",
        experimentName: "ranking-v2",
        experimentArm: "candidate",
        statusCode: 2,
        inputTokens: 9,
        outputTokens: 1,
        costUsd: "0.010000",
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "search_docs",
          "deployment.environment.name": "production",
        },
      }),
      span({
        id: uuid(12),
        traceId: traceId(12),
        spanId: spanId(12),
        parentSpanId: spanId(10),
        name: "execute_tool",
        spanClass: "tool",
        model: "gpt-4.1",
        attributes: { "gen_ai.tool.name": "other_tool" },
      }),
    ],
    db,
  );

  const filtered = await listSpans(
    PROJECT_ID,
    {
      scope: "all",
      name: "execute_tool",
      model: "gpt-5.5",
      tool: "search_docs",
      experiment: "ranking-v2",
      errorOnly: true,
      services: ["fixture-agent"],
      names: ["execute_tool"],
      statuses: [2],
      kinds: [3],
      environments: ["production"],
      models: ["gpt-5.5"],
      experiments: ["ranking-v2"],
      arms: ["candidate"],
      minDurationMs: 50,
      maxDurationMs: 150,
      minTokens: 10,
      maxTokens: 10,
      minCostUsd: 0.01,
      maxCostUsd: 0.01,
      limit: 1,
    },
    db,
  );
  const first = await listSpans(PROJECT_ID, { limit: 2 }, db);
  const second = await listSpans(
    PROJECT_ID,
    { cursor: first.nextCursor ?? undefined, limit: 2 },
    db,
  );
  const roots = await listSpans(PROJECT_ID, { scope: "root" }, db);
  const grouped = await listOperations(
    PROJECT_ID,
    { services: ["fixture-agent"], environments: ["production"] },
    db,
  );

  assert.deepEqual(
    filtered.items.map(({ name, kind, toolName }) => ({ name, kind, toolName })),
    [{ name: "execute_tool", kind: 3, toolName: "search_docs" }],
  );
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(first.items.length + second.items.length, 3);
  assert.equal(new Set([...first.items, ...second.items].map(({ id }) => id)).size, 3);
  assert.deepEqual(
    roots.items.map(({ name }) => name),
    ["agent.run"],
  );
  assert.deepEqual(
    grouped.map(({ key, count }) => ({ key, count })),
    [{ key: "execute_tool", count: 1 }],
  );
  await client.close();
});

test("telemetry text filters match workspace values by substring", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(20),
        traceId: traceId(20),
        spanId: spanId(20),
        name: "chat claude-haiku-4-5",
        model: "claude-haiku-4-5",
      }),
      span({
        id: uuid(21),
        traceId: traceId(21),
        spanId: spanId(21),
        name: "chat claude-opus-4-1",
        model: "claude-opus-4-1",
      }),
      span({
        id: uuid(22),
        traceId: traceId(22),
        spanId: spanId(22),
        name: "chat gpt-5",
        model: "gpt-5",
      }),
    ],
    db,
  );

  const [spans, traces] = await Promise.all([
    listSpans(PROJECT_ID, { model: "CLAUDE" }, db),
    listTraces(PROJECT_ID, { model: "claude" }, db),
  ]);

  assert.deepEqual(spans.items.map(({ model }) => model).sort(), [
    "claude-haiku-4-5",
    "claude-opus-4-1",
  ]);
  assert.deepEqual(traces.items.map(({ rootName }) => rootName).sort(), [
    "chat claude-haiku-4-5",
    "chat claude-opus-4-1",
  ]);
  await client.close();
});

test("listSpans sorts and paginates by started, duration, tokens, and cost", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(14),
        traceId: traceId(14),
        spanId: spanId(14),
        name: "middle",
        startedAt: new Date("2026-07-30T10:00:02.000Z"),
        durationMs: 20,
        inputTokens: 20,
        outputTokens: 0,
        costUsd: "0.020000",
      }),
      span({
        id: uuid(15),
        traceId: traceId(15),
        spanId: spanId(15),
        name: "largest",
        startedAt: new Date("2026-07-30T10:00:03.000Z"),
        durationMs: 30,
        inputTokens: 30,
        outputTokens: 0,
        costUsd: "0.030000",
      }),
      span({
        id: uuid(13),
        traceId: traceId(13),
        spanId: spanId(13),
        name: "smallest",
        startedAt: new Date("2026-07-30T10:00:01.000Z"),
        durationMs: 10,
        inputTokens: 10,
        outputTokens: 0,
        costUsd: "0.010000",
      }),
    ],
    db,
  );

  const started = await listSpans(PROJECT_ID, { sort: "started", direction: "asc" }, db);
  const durationFirst = await listSpans(
    PROJECT_ID,
    { sort: "duration", direction: "asc", limit: 2 },
    db,
  );
  const durationSecond = await listSpans(
    PROJECT_ID,
    {
      sort: "duration",
      direction: "asc",
      limit: 2,
      cursor: durationFirst.nextCursor ?? undefined,
    },
    db,
  );
  const tokens = await listSpans(PROJECT_ID, { sort: "tokens", direction: "desc" }, db);
  const cost = await listSpans(PROJECT_ID, { sort: "cost", direction: "asc" }, db);

  assert.deepEqual(
    started.items.map(({ name }) => name),
    ["smallest", "middle", "largest"],
  );
  assert.deepEqual(
    [...durationFirst.items, ...durationSecond.items].map(({ name }) => name),
    ["smallest", "middle", "largest"],
  );
  assert.deepEqual(durationFirst.nextCursor?.sortValue, 20);
  assert.deepEqual(
    tokens.items.map(({ name }) => name),
    ["largest", "middle", "smallest"],
  );
  assert.deepEqual(
    cost.items.map(({ name }) => name),
    ["smallest", "middle", "largest"],
  );
  await client.close();
});

test("getTraceFacets composes span filters and keeps alternate values selectable", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(20),
        traceId: traceId(20),
        spanId: spanId(20),
        name: "chat",
        kind: 3,
        statusCode: 1,
        serviceName: "api",
        model: "gpt-5.5",
        inputTokens: 8,
        outputTokens: 2,
        costUsd: "0.100000",
        experimentName: "ranking-v2",
        experimentArm: "control",
        attributes: {
          "deployment.environment.name": "production",
          "gen_ai.tool.name": "search_docs",
        },
      }),
      span({
        id: uuid(21),
        traceId: traceId(21),
        spanId: spanId(21),
        name: "execute_tool",
        kind: 2,
        statusCode: 2,
        serviceName: "api",
        inputTokens: 18,
        outputTokens: 2,
        costUsd: "0.300000",
        experimentName: "ranking-v2",
        experimentArm: "candidate",
        attributes: { "deployment.environment.name": "production" },
      }),
      span({
        id: uuid(22),
        traceId: traceId(22),
        spanId: spanId(22),
        name: "chat",
        kind: 3,
        statusCode: 1,
        serviceName: "worker",
        model: "gpt-5.5",
        inputTokens: 38,
        outputTokens: 2,
        costUsd: "0.500000",
        experimentName: "ranking-v3",
        experimentArm: "control",
        attributes: { "deployment.environment.name": "staging" },
      }),
    ],
    db,
  );

  const facets = await getTraceFacets(
    PROJECT_ID,
    {
      services: ["api"],
      names: ["chat"],
      minTokens: 10,
      maxCostUsd: 0.5,
    },
    db,
  );

  assert.deepEqual(facets.service, [
    { value: "api", count: 1 },
    { value: "worker", count: 1 },
  ]);
  assert.deepEqual(facets.name, [
    { value: "chat", count: 1 },
    { value: "execute_tool", count: 1 },
  ]);
  assert.deepEqual(facets.status, [{ value: "1", count: 1 }]);
  assert.deepEqual(facets.kind, [{ value: "3", count: 1 }]);
  assert.deepEqual(facets.environment, [{ value: "production", count: 1 }]);
  assert.deepEqual(facets.model, [{ value: "gpt-5.5", count: 1 }]);
  assert.deepEqual(facets.tool, [{ value: "search_docs", count: 1 }]);
  assert.deepEqual(facets.experiment, [{ value: "ranking-v2", count: 1 }]);
  assert.deepEqual(facets.arm, [{ value: "control", count: 1 }]);
  await client.close();
});

test("getTraceFacets preserves facet counts across active-filter combinations", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(200),
        traceId: traceId(200),
        spanId: spanId(200),
        name: "chat",
        kind: 3,
        statusCode: 1,
        serviceName: "api",
        model: "gpt-5.5",
        experimentName: "ranking-v2",
        experimentArm: "control",
        attributes: {
          "deployment.environment.name": "production",
          "gen_ai.tool.name": "search_docs",
        },
      }),
      span({
        id: uuid(201),
        traceId: traceId(201),
        spanId: spanId(201),
        name: "execute_tool",
        kind: 2,
        statusCode: 2,
        serviceName: "api",
        model: "claude-sonnet-4",
        experimentName: "ranking-v2",
        experimentArm: "candidate",
        attributes: {
          "deployment.environment.name": "production",
          "gen_ai.tool.name": "lookup_user",
        },
      }),
      span({
        id: uuid(202),
        traceId: traceId(202),
        spanId: spanId(202),
        name: "chat",
        kind: 3,
        statusCode: 1,
        serviceName: "worker",
        model: "gpt-5.5",
        experimentName: "ranking-v3",
        experimentArm: "control",
        attributes: {
          "deployment.environment.name": "staging",
          "gen_ai.tool.name": "search_docs",
        },
      }),
      span({
        id: uuid(203),
        traceId: traceId(203),
        spanId: spanId(203),
        name: "ingest",
        kind: 1,
        statusCode: 2,
        serviceName: "worker",
        attributes: { "deployment.environment": "production" },
      }),
    ],
    db,
  );

  const cases = [
    {
      options: {},
      expected: {
        service: [
          { value: "api", count: 2 },
          { value: "worker", count: 2 },
        ],
        name: [
          { value: "chat", count: 2 },
          { value: "execute_tool", count: 1 },
          { value: "ingest", count: 1 },
        ],
        status: [
          { value: "1", count: 2 },
          { value: "2", count: 2 },
        ],
        kind: [
          { value: "3", count: 2 },
          { value: "1", count: 1 },
          { value: "2", count: 1 },
        ],
        environment: [
          { value: "production", count: 3 },
          { value: "staging", count: 1 },
        ],
        model: [
          { value: "gpt-5.5", count: 2 },
          { value: "claude-sonnet-4", count: 1 },
        ],
        tool: [
          { value: "search_docs", count: 2 },
          { value: "lookup_user", count: 1 },
        ],
        experiment: [
          { value: "ranking-v2", count: 2 },
          { value: "ranking-v3", count: 1 },
        ],
        arm: [
          { value: "control", count: 2 },
          { value: "candidate", count: 1 },
        ],
      },
    },
    {
      options: { services: ["api"] },
      expected: {
        service: [
          { value: "api", count: 2 },
          { value: "worker", count: 2 },
        ],
        name: [
          { value: "chat", count: 1 },
          { value: "execute_tool", count: 1 },
        ],
        status: [
          { value: "1", count: 1 },
          { value: "2", count: 1 },
        ],
        kind: [
          { value: "2", count: 1 },
          { value: "3", count: 1 },
        ],
        environment: [{ value: "production", count: 2 }],
        model: [
          { value: "claude-sonnet-4", count: 1 },
          { value: "gpt-5.5", count: 1 },
        ],
        tool: [
          { value: "lookup_user", count: 1 },
          { value: "search_docs", count: 1 },
        ],
        experiment: [{ value: "ranking-v2", count: 2 }],
        arm: [
          { value: "candidate", count: 1 },
          { value: "control", count: 1 },
        ],
      },
    },
    {
      options: { services: ["api"], models: ["gpt-5.5"] },
      expected: {
        service: [
          { value: "api", count: 1 },
          { value: "worker", count: 1 },
        ],
        name: [{ value: "chat", count: 1 }],
        status: [{ value: "1", count: 1 }],
        kind: [{ value: "3", count: 1 }],
        environment: [{ value: "production", count: 1 }],
        model: [
          { value: "claude-sonnet-4", count: 1 },
          { value: "gpt-5.5", count: 1 },
        ],
        tool: [{ value: "search_docs", count: 1 }],
        experiment: [{ value: "ranking-v2", count: 1 }],
        arm: [{ value: "control", count: 1 }],
      },
    },
    {
      options: { services: ["api"], tool: "search" },
      expected: {
        service: [
          { value: "api", count: 1 },
          { value: "worker", count: 1 },
        ],
        name: [{ value: "chat", count: 1 }],
        status: [{ value: "1", count: 1 }],
        kind: [{ value: "3", count: 1 }],
        environment: [{ value: "production", count: 1 }],
        model: [{ value: "gpt-5.5", count: 1 }],
        tool: [
          { value: "lookup_user", count: 1 },
          { value: "search_docs", count: 1 },
        ],
        experiment: [{ value: "ranking-v2", count: 1 }],
        arm: [{ value: "control", count: 1 }],
      },
    },
  ];

  for (const { options, expected } of cases) {
    assert.deepEqual(await getTraceFacets(PROJECT_ID, options, db), expected);
  }
  await client.close();
});

test("getTraceFacets shares scans across dimensions with the same filters", async () => {
  const { client, db } = await setup();
  // Count executed SQL statements (each `countFacetValues` is a single nested
  // query), not query-builder calls — the row-bound rewrite nests subqueries so
  // one scan now spans several `.select()` calls but still one round-trip.
  let queryCount = 0;
  const runQuery = client.query.bind(client);
  client.query = ((...args: Parameters<PGlite["query"]>) => {
    queryCount += 1;
    return runQuery(...args);
  }) as PGlite["query"];

  await getTraceFacets(PROJECT_ID, {}, db);
  const noSelections = queryCount;

  queryCount = 0;
  await getTraceFacets(PROJECT_ID, { services: ["api"], models: ["gpt-5.5"] }, db);

  assert.deepEqual(
    { noSelections, twoSelections: queryCount },
    { noSelections: 1, twoSelections: 3 },
  );
  await client.close();
});

test("getTraceFacets limits each grouped dimension to its top 50 values", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    Array.from({ length: 52 }, (_, index) =>
      span({
        id: uuid(300 + index),
        traceId: traceId(300 + index),
        spanId: spanId(300 + index),
        name: `name-${index.toString().padStart(2, "0")}`,
        serviceName: `service-${Math.min(index, 50).toString().padStart(2, "0")}`,
      }),
    ),
    db,
  );

  const facets = await getTraceFacets(PROJECT_ID, {}, db);

  assert.deepEqual(
    {
      services: facets.service.map(({ value, count }) => ({ value, count })),
      names: facets.name.map(({ value }) => value),
    },
    {
      services: [
        { value: "service-50", count: 2 },
        ...Array.from({ length: 49 }, (_, index) => ({
          value: `service-${index.toString().padStart(2, "0")}`,
          count: 1,
        })),
      ],
      names: Array.from({ length: 50 }, (_, index) => `name-${index.toString().padStart(2, "0")}`),
    },
  );
  await client.close();
});

test("getTraceFacets bounds each facet's row set inside SQL, not just in JS", async () => {
  const queries: string[] = [];
  const client = {
    async query(query: string) {
      queries.push(query);
      return { rows: [] };
    },
  } as unknown as PGlite;
  const db = drizzle({ client, schema }) as unknown as TraceQueriesDb;

  await getTraceFacets(PROJECT_ID, {}, db);

  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /row_number\(\) over \(partition by/i);
  assert.match(queries[0]!, /"facet_rank" <= \$\d+/i);
});

test("getTraceFacets drops a unicode-whitespace-only value without spending a top-50 slot", async () => {
  const { client, db } = await setup();
  // A value that JS `.trim()` treats as blank but POSIX `[[:space:]]` would not.
  const NBSP_ONLY = "\u00a0\u00a0";
  await insertOtelSpans(
    PROJECT_ID,
    [
      // 50 real, distinct service names, one span each.
      ...Array.from({ length: 50 }, (_, index) =>
        span({
          id: uuid(400 + index),
          traceId: traceId(400 + index),
          spanId: spanId(400 + index),
          name: "shared",
          serviceName: `svc-${index.toString().padStart(2, "0")}`,
        }),
      ),
      // A blank (NBSP-only) service name with a far higher count — it would rank
      // first and steal a top-50 slot if SQL treated it as non-blank, leaving
      // only 49 real values after the JS backstop drops it.
      ...Array.from({ length: 100 }, (_, index) =>
        span({
          id: uuid(600 + index),
          traceId: traceId(600 + index),
          spanId: spanId(600 + index),
          name: "shared",
          serviceName: NBSP_ONLY,
        }),
      ),
    ],
    db,
  );

  const facets = await getTraceFacets(PROJECT_ID, {}, db);

  assert.equal(facets.service.length, 50);
  assert.ok(facets.service.every(({ value }) => value.trim() !== ""));
  assert.deepEqual(
    facets.service.map(({ value }) => value).sort(),
    Array.from({ length: 50 }, (_, index) => `svc-${index.toString().padStart(2, "0")}`),
  );
  await client.close();
});

test("getSpanAggregates calculates filtered percentiles and stacked UTC volume", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(30),
        traceId: traceId(30),
        spanId: spanId(30),
        name: "chat",
        serviceName: "api",
        durationMs: 10,
        inputTokens: 8,
        outputTokens: 2,
        costUsd: "0.100000",
        startedAt: new Date("2026-07-29T10:00:00.000Z"),
      }),
      span({
        id: uuid(31),
        traceId: traceId(31),
        spanId: spanId(31),
        name: "execute_tool",
        serviceName: "api",
        statusCode: 2,
        durationMs: 20,
        inputTokens: 18,
        outputTokens: 2,
        costUsd: "0.200000",
        startedAt: new Date("2026-07-29T11:00:00.000Z"),
      }),
      span({
        id: uuid(32),
        traceId: traceId(32),
        spanId: spanId(32),
        name: "chat",
        serviceName: "api",
        statusCode: 2,
        durationMs: 30,
        inputTokens: 28,
        outputTokens: 2,
        costUsd: "0.300000",
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      span({
        id: uuid(33),
        traceId: traceId(33),
        spanId: spanId(33),
        name: "chat",
        serviceName: "worker",
        durationMs: 100,
        inputTokens: 98,
        outputTokens: 2,
        costUsd: "1.000000",
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
    ],
    db,
  );

  const aggregate = await getSpanAggregates(
    PROJECT_ID,
    {
      since: new Date("2026-07-29T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
      services: ["api"],
      names: ["chat"],
    },
    db,
  );

  assert.deepEqual(aggregate, {
    count: 2,
    errorCount: 1,
    errorRate: 0.5,
    p50DurationMs: 20,
    p95DurationMs: 29,
    p99DurationMs: 29.8,
    costUsd: 0.4,
    totalTokens: 40,
    volume: [
      { day: "2026-07-29", count: 1, errorCount: 0 },
      { day: "2026-07-30", count: 1, errorCount: 1 },
    ],
  });
  await client.close();
});

test("getTraceAggregates keeps trace grain while filtering on matching child spans", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(34),
        traceId: traceId(34),
        spanId: spanId(34),
        name: "selected.run",
        durationMs: 100,
        startedAt: new Date("2026-07-29T10:00:00.000Z"),
      }),
      span({
        id: uuid(35),
        traceId: traceId(34),
        spanId: spanId(35),
        parentSpanId: spanId(34),
        name: "chat",
        serviceName: "api",
        statusCode: 2,
        inputTokens: 18,
        outputTokens: 2,
        costUsd: "0.200000",
      }),
      span({
        id: uuid(36),
        traceId: traceId(36),
        spanId: spanId(36),
        name: "excluded.run",
        durationMs: 300,
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      span({
        id: uuid(37),
        traceId: traceId(36),
        spanId: spanId(37),
        parentSpanId: spanId(36),
        name: "chat",
        serviceName: "worker",
      }),
    ],
    db,
  );

  const aggregate = await getTraceAggregates(
    PROJECT_ID,
    {
      since: new Date("2026-07-29T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
      services: ["api"],
      names: ["chat"],
    },
    db,
  );

  assert.deepEqual(aggregate, {
    count: 1,
    errorCount: 1,
    errorRate: 1,
    p50DurationMs: 100,
    p95DurationMs: 100,
    p99DurationMs: 100,
    costUsd: 0.2,
    totalTokens: 20,
    volume: [{ day: "2026-07-29", count: 1, errorCount: 1 }],
  });
  await client.close();
});

test("listOperations calculates continuous percentiles and sortable span aggregates", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      ...[10, 20, 30, 40].map((durationMs, index) =>
        span({
          id: uuid(100 + index),
          traceId: traceId(100 + index),
          spanId: spanId(100 + index),
          parentSpanId: spanId(99),
          name: "chat",
          durationMs,
          statusCode: index === 3 ? 2 : 1,
          inputTokens: index + 1,
          outputTokens: 1,
          costUsd: `0.00${index + 1}000`,
        }),
      ),
      span({
        id: uuid(110),
        traceId: traceId(110),
        spanId: spanId(110),
        name: "search",
        durationMs: 100,
      }),
    ],
    db,
  );

  const operations = await listOperations(
    PROJECT_ID,
    { groupBy: "name", sort: "p95", direction: "desc" },
    db,
  );
  const chat = operations.find(({ key }) => key === "chat");

  assert.equal(operations[0]?.key, "search");
  assert.deepEqual(
    chat && {
      count: chat.count,
      errorRate: chat.errorRate,
      p50: chat.p50DurationMs,
      p95: chat.p95DurationMs,
      cost: chat.costUsd,
      tokens: chat.totalTokens,
    },
    { count: 4, errorRate: 0.25, p50: 25, p95: 38.5, cost: 0.01, tokens: 14 },
  );
  assert.ok(Math.abs((chat?.p99DurationMs ?? 0) - 39.7) < 0.000001);
  await client.close();
});

test("listOperations switches between model and tool dimensions and omits unattributed spans", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(120),
        spanId: spanId(120),
        model: "gpt-5.5",
        attributes: { "gen_ai.tool.name": "search_docs" },
      }),
      span({
        id: uuid(121),
        spanId: spanId(121),
        model: "gpt-5.5",
        attributes: { "gen_ai.tool.name": "search_web" },
      }),
      span({ id: uuid(122), spanId: spanId(122), model: null, attributes: {} }),
    ],
    db,
  );

  const [models, tools] = await Promise.all([
    listOperations(PROJECT_ID, { groupBy: "model" }, db),
    listOperations(PROJECT_ID, { groupBy: "tool", sort: "key", direction: "asc" }, db),
  ]);

  assert.deepEqual(
    models.map(({ key, count }) => ({ key, count })),
    [{ key: "gpt-5.5", count: 2 }],
  );
  assert.deepEqual(
    tools.map(({ key }) => key),
    ["search_docs", "search_web"],
  );
  await client.close();
});

test("listOperations sorts cost numerically rather than by its text representation", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({ id: uuid(130), spanId: spanId(130), name: "cheap", costUsd: "2.000000" }),
      span({ id: uuid(131), spanId: spanId(131), name: "expensive", costUsd: "10.000000" }),
    ],
    db,
  );

  const operations = await listOperations(PROJECT_ID, { sort: "cost", direction: "desc" }, db);

  assert.deepEqual(
    operations.map(({ key }) => key),
    ["expensive", "cheap"],
  );
  await client.close();
});

test("listOperations honours the variant and top-level filters the span list applies", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(140),
        spanId: spanId(140),
        name: "agent.run",
        experimentName: "rank",
        experimentArm: "candidate",
      }),
      span({
        id: uuid(141),
        spanId: spanId(141),
        parentSpanId: spanId(140),
        name: "chat",
        experimentName: "rank",
        experimentArm: "candidate",
      }),
      span({
        id: uuid(142),
        traceId: traceId(142),
        spanId: spanId(142),
        name: "agent.run",
        experimentName: "rank",
        experimentArm: "baseline",
      }),
    ],
    db,
  );

  const [byVariant, topLevel, both] = await Promise.all([
    listOperations(PROJECT_ID, { arm: "candidate", sort: "key", direction: "asc" }, db),
    listOperations(PROJECT_ID, { scope: "root", sort: "key", direction: "asc" }, db),
    listOperations(PROJECT_ID, { arm: "candidate", scope: "root" }, db),
  ]);

  assert.deepEqual(
    byVariant.map(({ key, count }) => ({ key, count })),
    [
      { key: "agent.run", count: 1 },
      { key: "chat", count: 1 },
    ],
  );
  assert.deepEqual(
    topLevel.map(({ key, count }) => ({ key, count })),
    [{ key: "agent.run", count: 2 }],
  );
  assert.deepEqual(
    both.map(({ key, count }) => ({ key, count })),
    [{ key: "agent.run", count: 1 }],
  );
  await client.close();
});

test("listOperations returns at most 200 groups", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    Array.from({ length: 201 }, (_, index) => {
      const value = index + 3_000;
      return span({
        id: uuid(value),
        traceId: traceId(value),
        spanId: spanId(value),
        name: `operation-${String(index + 1).padStart(3, "0")}`,
      });
    }),
    db,
  );

  const operations = await listOperations(PROJECT_ID, { sort: "key", direction: "asc" }, db);

  assert.equal(operations.length, 200);
  assert.equal(operations.at(-1)?.key, "operation-200");
  await client.close();
});

test("listTraceLifecycleEvents returns ordered arm events for one project trace", async () => {
  const { client, db } = await setup();
  const otherTraceId = traceId(99);
  await insertLifecycleRecords(db, PROJECT_ID, [
    lifecycleRecord("drop", "2026-07-30T10:04:00.000Z", {
      "ratel.experiment.drop.reason": "timeout",
    }),
    lifecycleRecord("results", "2026-07-30T10:00:00.000Z"),
    lifecycleRecord("comparison", "2026-07-30T10:01:00.000Z", {
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.agreement.jaccard_at_k": 0.75,
      "ratel.experiment.agreement.k": 5,
    }),
    lifecycleRecord("skip", "2026-07-30T10:02:00.000Z"),
    lifecycleRecord("fallback", "2026-07-30T10:03:00.000Z", {
      "ratel.experiment.fallback.effective_arm": "control",
    }),
    lifecycleRecord("outcome", "2026-07-30T10:05:00.000Z", {
      "ratel.experiment.outcome.label": "accepted",
    }),
    lifecycleRecord("invocation", "2026-07-30T10:06:00.000Z"),
    lifecycleRecord("results", "2026-07-30T10:07:00.000Z", {}, otherTraceId),
  ]);
  await insertLifecycleRecords(db, OTHER_PROJECT_ID, [
    lifecycleRecord("results", "2026-07-30T09:59:00.000Z"),
  ]);

  const events = await listTraceLifecycleEvents(PROJECT_ID, TRACE_ID, db);

  assert.deepEqual(
    events.map((event) => ({
      name: event.eventName,
      occurredAt: event.occurredAt.toISOString(),
      spanId: event.spanId,
      arm: event.experimentArm,
      role: event.experimentRole,
      details: lifecycleDetails(event.experimentAttrs),
    })),
    [
      {
        name: "ratel.experiment.results",
        occurredAt: "2026-07-30T10:00:00.000Z",
        spanId: spanId(1),
        arm: "candidate",
        role: "shadow",
        details: {},
      },
      {
        name: "ratel.experiment.comparison",
        occurredAt: "2026-07-30T10:01:00.000Z",
        spanId: spanId(1),
        arm: "candidate",
        role: "shadow",
        details: {
          "ratel.experiment.agreement.top1": true,
          "ratel.experiment.agreement.jaccard_at_k": 0.75,
          "ratel.experiment.agreement.k": 5,
        },
      },
      {
        name: "ratel.experiment.skip",
        occurredAt: "2026-07-30T10:02:00.000Z",
        spanId: spanId(1),
        arm: "candidate",
        role: "shadow",
        details: {},
      },
      {
        name: "ratel.experiment.fallback",
        occurredAt: "2026-07-30T10:03:00.000Z",
        spanId: spanId(1),
        arm: "candidate",
        role: "shadow",
        details: {
          "ratel.experiment.fallback.effective_arm": "control",
        },
      },
      {
        name: "ratel.experiment.drop",
        occurredAt: "2026-07-30T10:04:00.000Z",
        spanId: spanId(1),
        arm: "candidate",
        role: "shadow",
        details: { "ratel.experiment.drop.reason": "timeout" },
      },
      {
        name: "ratel.experiment.outcome",
        occurredAt: "2026-07-30T10:05:00.000Z",
        spanId: spanId(1),
        arm: "candidate",
        role: "shadow",
        details: { "ratel.experiment.outcome.label": "accepted" },
      },
    ],
  );
  await client.close();
});

test("listTraces returns project-scoped trace summaries newest first", async () => {
  const { client, db } = await setup();
  const olderTraceId = traceId(10);
  const newerTraceId = traceId(20);
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(10),
        traceId: olderTraceId,
        spanId: spanId(10),
        name: "older.run",
        startedAt: new Date("2026-07-30T09:00:00.000Z"),
        endedAt: new Date("2026-07-30T09:00:01.000Z"),
        durationMs: 1_000,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: "0.001000",
      }),
      span({
        id: uuid(20),
        traceId: newerTraceId,
        spanId: spanId(20),
        name: "newer.run",
        serviceName: "new-service",
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
        endedAt: new Date("2026-07-30T10:00:00.500Z"),
        durationMs: 500,
        experimentName: "ranking-v2",
        experimentArm: "candidate",
      }),
      span({
        id: uuid(21),
        traceId: newerTraceId,
        spanId: spanId(21),
        parentSpanId: spanId(20),
        name: "chat",
        statusCode: 2,
        startedAt: new Date("2026-07-30T10:00:00.100Z"),
        inputTokens: 100,
        outputTokens: 20,
        costUsd: "0.005000",
      }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span({
        id: uuid(30),
        projectId: OTHER_PROJECT_ID,
        traceId: newerTraceId,
        spanId: spanId(30),
        name: "other-project",
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
    ],
    db,
  );

  const page = await listTraces(PROJECT_ID, {}, db);

  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    page.items.map((item) => ({
      traceId: item.traceId,
      rootName: item.rootName,
      serviceName: item.serviceName,
      durationMs: item.durationMs,
      spanCount: item.spanCount,
      errorCount: item.errorCount,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      costUsd: item.costUsd,
      experimentName: item.experimentName,
      experimentArm: item.experimentArm,
    })),
    [
      {
        traceId: newerTraceId,
        rootName: "newer.run",
        serviceName: "new-service",
        durationMs: 500,
        spanCount: 2,
        errorCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.005,
        experimentName: "ranking-v2",
        experimentArm: "candidate",
      },
      {
        traceId: olderTraceId,
        rootName: "older.run",
        serviceName: "fixture-agent",
        durationMs: 1_000,
        spanCount: 1,
        errorCount: 0,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
        experimentName: null,
        experimentArm: null,
      },
    ],
  );
  await client.close();
});

test("listTraces sorts and paginates by started, duration, tokens, and cost", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      ...[16, 17, 18].flatMap((value, index) => {
        const root = span({
          id: uuid(value * 2),
          traceId: traceId(value),
          spanId: spanId(value * 2),
          name: ["smallest", "middle", "largest"][index],
          startedAt: new Date(`2026-07-30T10:00:0${index + 1}.000Z`),
          durationMs: (index + 1) * 10,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        });
        return [
          root,
          span({
            id: uuid(value * 2 + 1),
            traceId: traceId(value),
            spanId: spanId(value * 2 + 1),
            parentSpanId: root.spanId,
            name: "child",
            inputTokens: (index + 1) * 10,
            outputTokens: 0,
            costUsd: `0.0${index + 1}0000`,
          }),
        ];
      }),
    ],
    db,
  );

  const started = await listTraces(PROJECT_ID, { sort: "started", direction: "asc" }, db);
  const duration = await listTraces(PROJECT_ID, { sort: "duration", direction: "asc" }, db);
  const tokenFirst = await listTraces(
    PROJECT_ID,
    { sort: "tokens", direction: "desc", limit: 2 },
    db,
  );
  const tokenSecond = await listTraces(
    PROJECT_ID,
    {
      sort: "tokens",
      direction: "desc",
      limit: 2,
      cursor: tokenFirst.nextCursor ?? undefined,
    },
    db,
  );
  const cost = await listTraces(PROJECT_ID, { sort: "cost", direction: "asc" }, db);

  assert.deepEqual(
    started.items.map(({ rootName }) => rootName),
    ["smallest", "middle", "largest"],
  );
  assert.deepEqual(
    duration.items.map(({ rootName }) => rootName),
    ["smallest", "middle", "largest"],
  );
  assert.deepEqual(
    [...tokenFirst.items, ...tokenSecond.items].map(({ rootName }) => rootName),
    ["largest", "middle", "smallest"],
  );
  assert.deepEqual(tokenFirst.nextCursor?.sortValue, 20);
  assert.deepEqual(
    cost.items.map(({ rootName }) => rootName),
    ["smallest", "middle", "largest"],
  );
  await client.close();
});

test("listTraces sorts window-straddling traces by in-window token and cost totals", async () => {
  const { client, db } = await setup();
  const window = {
    since: new Date("2026-07-30T10:00:00.000Z"),
    until: new Date("2026-07-30T11:00:00.000Z"),
  };
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(38),
        traceId: traceId(19),
        spanId: spanId(38),
        name: "window-edge",
        startedAt: new Date("2026-07-30T10:10:00.000Z"),
        inputTokens: 5,
        outputTokens: 5,
        costUsd: "0.010000",
      }),
      span({
        id: uuid(39),
        traceId: traceId(19),
        spanId: spanId(39),
        parentSpanId: spanId(38),
        name: "after-window",
        startedAt: new Date("2026-07-30T11:10:00.000Z"),
        inputTokens: 100,
        outputTokens: 100,
        costUsd: "1.000000",
      }),
      span({
        id: uuid(40),
        traceId: traceId(20),
        spanId: spanId(40),
        name: "inside-window",
        startedAt: new Date("2026-07-30T10:20:00.000Z"),
        inputTokens: 20,
        outputTokens: 0,
        costUsd: "0.020000",
      }),
    ],
    db,
  );

  const tokenFirst = await listTraces(
    PROJECT_ID,
    { ...window, sort: "tokens", direction: "desc", limit: 1 },
    db,
  );
  const tokenSecond = await listTraces(
    PROJECT_ID,
    {
      ...window,
      sort: "tokens",
      direction: "desc",
      limit: 1,
      cursor: tokenFirst.nextCursor ?? undefined,
    },
    db,
  );
  const cost = await listTraces(PROJECT_ID, { ...window, sort: "cost", direction: "desc" }, db);

  assert.deepEqual(
    [...tokenFirst.items, ...tokenSecond.items].map(({ rootName, totalTokens, costUsd }) => ({
      rootName,
      totalTokens,
      costUsd,
    })),
    [
      { rootName: "inside-window", totalTokens: 20, costUsd: 0.02 },
      { rootName: "window-edge", totalTokens: 10, costUsd: 0.01 },
    ],
  );
  assert.equal(tokenFirst.nextCursor?.sortValue, 20);
  assert.deepEqual(
    cost.items.map(({ rootName }) => rootName),
    ["inside-window", "window-edge"],
  );
  await client.close();
});

test("listTraces filters representative roots by time window and name", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(40),
        traceId: traceId(40),
        spanId: spanId(40),
        name: "agent.run",
        startedAt: new Date("2026-07-29T23:59:59.999Z"),
      }),
      span({
        id: uuid(41),
        traceId: traceId(41),
        spanId: spanId(41),
        name: "agent.run",
        startedAt: new Date("2026-07-30T00:00:00.000Z"),
      }),
      span({
        id: uuid(42),
        traceId: traceId(42),
        spanId: spanId(42),
        name: "other.run",
        startedAt: new Date("2026-07-30T12:00:00.000Z"),
      }),
      span({
        id: uuid(43),
        traceId: traceId(43),
        spanId: spanId(43),
        name: "agent.run",
        startedAt: new Date("2026-07-31T00:00:00.000Z"),
      }),
    ],
    db,
  );

  const page = await listTraces(
    PROJECT_ID,
    {
      since: new Date("2026-07-30T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
      rootName: "agent.run",
    },
    db,
  );

  assert.deepEqual(
    page.items.map(({ traceId: id }) => id),
    [traceId(41)],
  );
  await client.close();
});

test("listTraces errorOnly includes a trace when any child span errored", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(50),
        traceId: traceId(50),
        spanId: spanId(50),
        name: "healthy.run",
      }),
      span({
        id: uuid(51),
        traceId: traceId(51),
        spanId: spanId(51),
        name: "failed.run",
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
      span({
        id: uuid(52),
        traceId: traceId(51),
        spanId: spanId(52),
        parentSpanId: spanId(51),
        name: "failed.child",
        statusCode: 2,
        startedAt: new Date("2026-07-30T11:00:00.100Z"),
      }),
    ],
    db,
  );

  const page = await listTraces(PROJECT_ID, { errorOnly: true }, db);

  assert.deepEqual(
    page.items.map(({ traceId: id }) => id),
    [traceId(51)],
  );
  await client.close();
});

test("listTraces filters traces by dimensions found only on child spans", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({ id: uuid(40), traceId: traceId(40), spanId: spanId(40) }),
      span({
        id: uuid(41),
        traceId: traceId(40),
        spanId: spanId(41),
        parentSpanId: spanId(40),
        name: "execute_tool",
        kind: 3,
        statusCode: 2,
        serviceName: "api",
        model: "gpt-5.5",
        inputTokens: 9,
        outputTokens: 1,
        costUsd: "0.010000",
        experimentName: "ranking-v2",
        experimentArm: "candidate",
        attributes: {
          "gen_ai.tool.name": "search_docs",
          "deployment.environment.name": "production",
        },
      }),
      span({ id: uuid(50), traceId: traceId(50), spanId: spanId(50) }),
      span({
        id: uuid(51),
        traceId: traceId(50),
        spanId: spanId(51),
        parentSpanId: spanId(50),
        name: "execute_tool",
        model: "gpt-4.1",
        attributes: { "gen_ai.tool.name": "search_web" },
      }),
    ],
    db,
  );

  const page = await listTraces(
    PROJECT_ID,
    {
      services: ["api"],
      names: ["execute_tool"],
      statuses: [2],
      kinds: [3],
      environments: ["production"],
      models: ["gpt-5.5"],
      experiments: ["ranking-v2"],
      arms: ["candidate"],
      minTokens: 10,
      maxCostUsd: 0.01,
    },
    db,
  );

  assert.deepEqual(
    page.items.map(({ traceId }) => traceId),
    [traceId(40)],
  );
  await client.close();
});

test("listTraces ORs values within a facet and ANDs different facets", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(80),
        traceId: traceId(80),
        spanId: spanId(80),
        serviceName: "api",
        model: "gpt-5.5",
      }),
      span({
        id: uuid(81),
        traceId: traceId(81),
        spanId: spanId(81),
        serviceName: "worker",
        model: "gpt-5.5",
      }),
      span({
        id: uuid(82),
        traceId: traceId(82),
        spanId: spanId(82),
        serviceName: "queue",
        model: "gpt-5.5",
      }),
      span({
        id: uuid(83),
        traceId: traceId(83),
        spanId: spanId(83),
        serviceName: "api",
        model: "claude-sonnet-4-5",
      }),
    ],
    db,
  );

  const page = await listTraces(
    PROJECT_ID,
    {
      services: ["api", "worker"],
      models: ["gpt-5.5"],
    },
    db,
  );

  assert.deepEqual(
    page.items.map(({ traceId: id }) => id).sort(),
    [traceId(80), traceId(81)].sort(),
  );
  await client.close();
});

test("listTraces ignores membership matches outside the selected window", async () => {
  const { client, db } = await setup();
  const since = new Date("2026-07-30T00:00:00.000Z");
  const until = new Date("2026-07-31T00:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(52),
        traceId: traceId(52),
        spanId: spanId(52),
        name: "in-window.root",
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      span({
        id: uuid(53),
        traceId: traceId(52),
        spanId: spanId(53),
        parentSpanId: spanId(52),
        name: "out-of-window.match",
        serviceName: "matching-service",
        statusCode: 2,
        experimentName: "matching-experiment",
        experimentArm: "matching-arm",
        startedAt: new Date("2026-07-29T23:59:59.999Z"),
      }),
    ],
    db,
  );
  const window = { since, until };

  const [dimension, error, experiment, facet] = await Promise.all([
    listTraces(PROJECT_ID, { ...window, spanName: "out-of-window.match" }, db),
    listTraces(PROJECT_ID, { ...window, errorOnly: true }, db),
    listTraces(
      PROJECT_ID,
      {
        ...window,
        experiment: "matching-experiment",
        arm: "matching-arm",
      },
      db,
    ),
    listTraces(PROJECT_ID, { ...window, services: ["matching-service"] }, db),
  ]);

  assert.deepEqual(
    {
      dimension: dimension.items.map(({ traceId: id }) => id),
      error: error.items.map(({ traceId: id }) => id),
      experiment: experiment.items.map(({ traceId: id }) => id),
      facet: facet.items.map(({ traceId: id }) => id),
    },
    { dimension: [], error: [], experiment: [], facet: [] },
  );
  await client.close();
});

test("listTraces returns the matching experiment pair from any span in the trace", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(60),
        traceId: traceId(60),
        spanId: spanId(60),
        name: "candidate.run",
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
      span({
        id: uuid(61),
        traceId: traceId(60),
        spanId: spanId(61),
        parentSpanId: spanId(60),
        experimentName: "ranking-v2",
        experimentArm: "candidate",
      }),
      span({
        id: uuid(62),
        traceId: traceId(62),
        spanId: spanId(62),
        name: "control.run",
        experimentName: "ranking-v2",
        experimentArm: "control",
      }),
    ],
    db,
  );

  const page = await listTraces(PROJECT_ID, { experiment: "ranking-v2", arm: "candidate" }, db);

  assert.deepEqual(
    page.items.map(({ traceId: id, experimentName, experimentArm }) => ({
      id,
      experimentName,
      experimentArm,
    })),
    [
      {
        id: traceId(60),
        experimentName: "ranking-v2",
        experimentArm: "candidate",
      },
    ],
  );
  await client.close();
});

test("listTraces prefers a filtered arm pair but keeps the root pair when unfiltered", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(63),
        traceId: traceId(63),
        spanId: spanId(63),
        name: "experiment.run",
        experimentName: "ranking-v2",
        experimentArm: "control",
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
      span({
        id: uuid(64),
        traceId: traceId(63),
        spanId: spanId(64),
        parentSpanId: spanId(63),
        experimentName: "ranking-v2",
        experimentArm: "candidate",
        startedAt: new Date("2026-07-30T11:00:00.100Z"),
      }),
    ],
    db,
  );

  const filtered = await listTraces(PROJECT_ID, { experiment: "ranking-v2", arm: "candidate" }, db);
  const unfiltered = await listTraces(PROJECT_ID, {}, db);

  assert.deepEqual(
    {
      filtered: filtered.items.map(({ experimentName, experimentArm }) => ({
        experimentName,
        experimentArm,
      })),
      unfiltered: unfiltered.items.map(({ experimentName, experimentArm }) => ({
        experimentName,
        experimentArm,
      })),
    },
    {
      filtered: [{ experimentName: "ranking-v2", experimentArm: "candidate" }],
      unfiltered: [{ experimentName: "ranking-v2", experimentArm: "control" }],
    },
  );
  await client.close();
});

test("listTraces composite cursor paginates tied timestamps without overlap", async () => {
  const { client, db } = await setup();
  const tiedAt = new Date("2026-07-30T12:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(69),
        traceId: traceId(69),
        spanId: spanId(69),
        startedAt: new Date("2026-07-30T11:59:59.000Z"),
      }),
      ...[70, 71, 72].map((value) =>
        span({
          id: uuid(value),
          traceId: traceId(value),
          spanId: spanId(value),
          startedAt: tiedAt,
        }),
      ),
    ],
    db,
  );

  const first = await listTraces(PROJECT_ID, { limit: 2 }, db);
  assert.equal(first.hasMore, true);
  assert.deepEqual(
    first.items.map(({ traceId: id }) => id),
    [traceId(72), traceId(71)],
  );
  assert.deepEqual(first.nextCursor, {
    startedAt: tiedAt,
    traceId: traceId(71),
  });

  const second = await listTraces(PROJECT_ID, { limit: 2, cursor: first.nextCursor! }, db);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    second.items.map(({ traceId: id }) => id),
    [traceId(70), traceId(69)],
  );
  await client.close();
});

test("listTraces represents a malformed multi-root trace exactly once", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(80),
        traceId: traceId(80),
        spanId: spanId(80),
        name: "primary.root",
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      span({
        id: uuid(81),
        traceId: traceId(80),
        spanId: spanId(81),
        name: "later.root",
        startedAt: new Date("2026-07-30T10:01:00.000Z"),
      }),
    ],
    db,
  );

  const page = await listTraces(PROJECT_ID, {}, db);

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.rootName, "primary.root");
  assert.equal(page.items[0]?.spanCount, 2);
  await client.close();
});

test("listTraces promotes the earliest surviving span when a trace root is absent", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(83),
        traceId: traceId(82),
        spanId: spanId(83),
        parentSpanId: spanId(82),
        name: "retained.child",
        startedAt: new Date("2026-07-30T10:00:00.100Z"),
      }),
      span({
        id: uuid(82),
        traceId: traceId(82),
        spanId: spanId(82),
        parentSpanId: spanId(999),
        name: "promoted.root",
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
    ],
    db,
  );

  const page = await listTraces(PROJECT_ID, {}, db);

  assert.deepEqual(
    page.items.map(({ traceId: id, rootSpanId, rootName, spanCount }) => ({
      id,
      rootSpanId,
      rootName,
      spanCount,
    })),
    [
      {
        id: traceId(82),
        rootSpanId: spanId(82),
        rootName: "promoted.root",
        spanCount: 2,
      },
    ],
  );
  await client.close();
});

test("getTraceKpis aggregates trace-level latency, errors, tokens, and cost", async () => {
  const { client, db } = await setup();
  const since = new Date("2026-07-30T00:00:00.000Z");
  const until = new Date("2026-07-31T00:00:00.000Z");
  const durations = [100, 200, 300, 400, 500];
  const roots = durations.map((durationMs, index) => {
    const value = 90 + index;
    return span({
      id: uuid(value),
      traceId: traceId(value),
      spanId: spanId(value),
      startedAt: new Date(since.getTime() + index * 60_000),
      durationMs,
      inputTokens: (index + 1) * 10,
      outputTokens: index + 1,
      costUsd: `0.00${index + 1}000`,
      statusCode: index === 4 ? 2 : 1,
    });
  });
  await insertOtelSpans(
    PROJECT_ID,
    [
      ...roots,
      span({
        id: uuid(95),
        traceId: traceId(91),
        spanId: spanId(95),
        parentSpanId: spanId(91),
        statusCode: 2,
      }),
      span({
        id: uuid(96),
        traceId: traceId(96),
        spanId: spanId(96),
        startedAt: new Date("2026-07-29T23:59:59.999Z"),
        durationMs: 10_000,
        inputTokens: 10_000,
        statusCode: 2,
      }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span({
        id: uuid(97),
        projectId: OTHER_PROJECT_ID,
        traceId: traceId(97),
        spanId: spanId(97),
        durationMs: 20_000,
        statusCode: 2,
      }),
    ],
    db,
  );

  const kpis = await getTraceKpis(PROJECT_ID, { since, until }, db);

  assert.deepEqual(kpis, {
    traceCount: 5,
    errorTraceCount: 2,
    errorRate: 0.4,
    averageLatencyMs: 300,
    p50LatencyMs: 300,
    p95LatencyMs: 480,
    inputTokens: 150,
    outputTokens: 15,
    totalTokens: 165,
    costUsd: 0.015,
  });
  await client.close();
});

test("trace aggregates include a rootless trace using its earliest surviving span", async () => {
  const { client, db } = await setup();
  const since = new Date("2026-07-30T00:00:00.000Z");
  const until = new Date("2026-07-31T00:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(101),
        traceId: traceId(101),
        spanId: spanId(101),
        parentSpanId: spanId(999),
        name: "promoted.root",
        startedAt: new Date("2026-07-30T12:00:00.000Z"),
        durationMs: 250,
        inputTokens: 10,
        costUsd: "0.001000",
      }),
      span({
        id: uuid(102),
        traceId: traceId(101),
        spanId: spanId(102),
        parentSpanId: spanId(101),
        name: "retained.child",
        startedAt: new Date("2026-07-30T12:00:00.100Z"),
        statusCode: 2,
        outputTokens: 4,
        costUsd: "0.002000",
      }),
    ],
    db,
  );

  const kpis = await getTraceKpis(PROJECT_ID, { since, until }, db);
  const days = await getTraceDailyAggregates(PROJECT_ID, { since, until }, db);

  assert.deepEqual(
    { kpis, days },
    {
      kpis: {
        traceCount: 1,
        errorTraceCount: 1,
        errorRate: 1,
        averageLatencyMs: 250,
        p50LatencyMs: 250,
        p95LatencyMs: 250,
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        costUsd: 0.003,
      },
      days: [
        {
          day: "2026-07-30",
          traceCount: 1,
          errorTraceCount: 1,
          averageLatencyMs: 250,
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          costUsd: 0.003,
        },
      ],
    },
  );
  await client.close();
});

test("getTraceDailyAggregates groups selected traces into UTC days", async () => {
  const { client, db } = await setup();
  const since = new Date("2026-07-30T00:00:00.000Z");
  const until = new Date("2026-08-01T00:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(110),
        traceId: traceId(110),
        spanId: spanId(110),
        startedAt: new Date("2026-07-30T00:00:00.000Z"),
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 1,
        costUsd: "0.001000",
      }),
      span({
        id: uuid(111),
        traceId: traceId(111),
        spanId: spanId(111),
        startedAt: new Date("2026-07-30T23:59:59.999Z"),
        durationMs: 300,
        inputTokens: 20,
        outputTokens: 2,
        costUsd: "0.002000",
      }),
      span({
        id: uuid(112),
        traceId: traceId(111),
        spanId: spanId(112),
        parentSpanId: spanId(111),
        startedAt: new Date("2026-07-30T23:59:59.999Z"),
        statusCode: 2,
      }),
      span({
        id: uuid(113),
        traceId: traceId(113),
        spanId: spanId(113),
        startedAt: new Date("2026-07-31T12:00:00.000Z"),
        durationMs: 500,
        inputTokens: 30,
        outputTokens: 3,
        costUsd: "0.003000",
      }),
      span({
        id: uuid(114),
        traceId: traceId(114),
        spanId: spanId(114),
        startedAt: until,
        durationMs: 1_000,
      }),
    ],
    db,
  );

  const days = await getTraceDailyAggregates(PROJECT_ID, { since, until }, db);

  assert.deepEqual(days, [
    {
      day: "2026-07-30",
      traceCount: 2,
      errorTraceCount: 1,
      averageLatencyMs: 200,
      inputTokens: 30,
      outputTokens: 3,
      totalTokens: 33,
      costUsd: 0.003,
    },
    {
      day: "2026-07-31",
      traceCount: 1,
      errorTraceCount: 0,
      averageLatencyMs: 500,
      inputTokens: 30,
      outputTokens: 3,
      totalTokens: 33,
      costUsd: 0.003,
    },
  ]);
  await client.close();
});

test("trace aggregates use an in-window root when an earlier root precedes the window", async () => {
  const { client, db } = await setup();
  const since = new Date("2026-07-30T00:00:00.000Z");
  const until = new Date("2026-07-31T00:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(150),
        traceId: traceId(150),
        spanId: spanId(150),
        name: "pre-window.root",
        startedAt: new Date("2026-07-29T23:00:00.000Z"),
        durationMs: 1_000,
        inputTokens: 20,
      }),
      span({
        id: uuid(151),
        traceId: traceId(150),
        spanId: spanId(151),
        name: "in-window.root",
        startedAt: new Date("2026-07-30T09:00:00.000Z"),
        durationMs: 250,
        inputTokens: 10,
      }),
    ],
    db,
  );

  const [kpis, days] = await Promise.all([
    getTraceKpis(PROJECT_ID, { since, until }, db),
    getTraceDailyAggregates(PROJECT_ID, { since, until }, db),
  ]);

  assert.deepEqual(
    {
      traceCount: kpis.traceCount,
      averageLatencyMs: kpis.averageLatencyMs,
      inputTokens: kpis.inputTokens,
      days,
    },
    {
      traceCount: 1,
      averageLatencyMs: 250,
      inputTokens: 30,
      days: [
        {
          day: "2026-07-30",
          traceCount: 1,
          errorTraceCount: 0,
          averageLatencyMs: 250,
          inputTokens: 30,
          outputTokens: 0,
          totalTokens: 30,
          costUsd: 0,
        },
      ],
    },
  );
  await client.close();
});

test("summary-backed aggregates reproduce the live rollups", async () => {
  const { client, db } = await setup();
  const since = new Date("2026-07-30T00:00:00.000Z");
  const until = new Date("2026-08-01T00:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      // Rooted, erroring trace on day one.
      span({
        id: uuid(210),
        traceId: traceId(210),
        spanId: spanId(210),
        startedAt: new Date("2026-07-30T01:00:00.000Z"),
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 1,
        costUsd: "0.001000",
      }),
      span({
        id: uuid(211),
        traceId: traceId(210),
        spanId: spanId(211),
        parentSpanId: spanId(210),
        startedAt: new Date("2026-07-30T01:00:00.050Z"),
        durationMs: 5,
        statusCode: 2,
        inputTokens: 2,
        costUsd: "0.000500",
      }),
      // Clean trace, same day.
      span({
        id: uuid(220),
        traceId: traceId(220),
        spanId: spanId(220),
        startedAt: new Date("2026-07-30T23:00:00.000Z"),
        durationMs: 300,
        inputTokens: 20,
        outputTokens: 2,
        costUsd: "0.002000",
      }),
      // Rootless trace on day two: both paths promote its earliest span.
      span({
        id: uuid(230),
        traceId: traceId(230),
        spanId: spanId(230),
        parentSpanId: spanId(999),
        startedAt: new Date("2026-07-31T05:00:00.500Z"),
        durationMs: 700,
        outputTokens: 5,
      }),
      span({
        id: uuid(231),
        traceId: traceId(230),
        spanId: spanId(231),
        parentSpanId: spanId(230),
        startedAt: new Date("2026-07-31T05:00:00.100Z"),
        durationMs: 200,
        inputTokens: 4,
        costUsd: "0.003000",
      }),
      // Before the window.
      span({
        id: uuid(240),
        traceId: traceId(240),
        spanId: spanId(240),
        startedAt: new Date("2026-07-29T12:00:00.000Z"),
        durationMs: 9_999,
        inputTokens: 9_999,
        statusCode: 2,
      }),
      // Exactly at `until`, which is exclusive.
      span({
        id: uuid(250),
        traceId: traceId(250),
        spanId: spanId(250),
        startedAt: until,
        durationMs: 8_888,
        inputTokens: 8_888,
      }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span({
        id: uuid(260),
        projectId: OTHER_PROJECT_ID,
        traceId: traceId(260),
        spanId: spanId(260),
        startedAt: new Date("2026-07-30T02:00:00.000Z"),
        durationMs: 7_777,
        inputTokens: 7_777,
        statusCode: 2,
      }),
    ],
    db,
  );
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  const [liveKpis, summaryKpis, liveDays, summaryDays] = await Promise.all([
    getTraceKpis(PROJECT_ID, { since, until }, db),
    getTraceKpisFromSummaries(PROJECT_ID, { since, until }, db),
    getTraceDailyAggregates(PROJECT_ID, { since, until }, db),
    getTraceDailyAggregatesFromSummaries(PROJECT_ID, { since, until }, db),
  ]);

  assert.deepEqual(summaryKpis, liveKpis);
  assert.deepEqual(summaryDays, liveDays);
  // Pinned separately so a shared regression can't keep the two agreeing on the
  // wrong numbers. p95 is left to the parity assertion — its interpolation is
  // the one value not worth restating in floating point here.
  assert.deepEqual(
    {
      traceCount: summaryKpis.traceCount,
      errorTraceCount: summaryKpis.errorTraceCount,
      errorRate: summaryKpis.errorRate,
      averageLatencyMs: summaryKpis.averageLatencyMs,
      p50LatencyMs: summaryKpis.p50LatencyMs,
      inputTokens: summaryKpis.inputTokens,
      outputTokens: summaryKpis.outputTokens,
      totalTokens: summaryKpis.totalTokens,
      costUsd: summaryKpis.costUsd,
    },
    {
      traceCount: 3,
      errorTraceCount: 1,
      errorRate: 1 / 3,
      averageLatencyMs: 200,
      p50LatencyMs: 200,
      inputTokens: 36,
      outputTokens: 8,
      totalTokens: 44,
      costUsd: 0.0065,
    },
  );
  assert.deepEqual(summaryDays, [
    {
      day: "2026-07-30",
      traceCount: 2,
      errorTraceCount: 1,
      averageLatencyMs: 200,
      inputTokens: 32,
      outputTokens: 3,
      totalTokens: 35,
      costUsd: 0.0035,
    },
    {
      day: "2026-07-31",
      traceCount: 1,
      errorTraceCount: 0,
      averageLatencyMs: 200,
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
      costUsd: 0.003,
    },
  ]);
  await client.close();
});

test("summary-backed KPIs report null latency for an empty window", async () => {
  const { client, db } = await setup();
  const window = {
    since: new Date("2026-01-01T00:00:00.000Z"),
    until: new Date("2026-01-02T00:00:00.000Z"),
  };
  await insertOtelSpans(
    PROJECT_ID,
    [span({ id: uuid(270), traceId: traceId(270), spanId: spanId(270) })],
    db,
  );
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  const [kpis, days] = await Promise.all([
    getTraceKpisFromSummaries(PROJECT_ID, window, db),
    getTraceDailyAggregatesFromSummaries(PROJECT_ID, window, db),
  ]);

  assert.deepEqual({ kpis, days }, { kpis: await getTraceKpis(PROJECT_ID, window, db), days: [] });
  assert.deepEqual(kpis, EMPTY_TRACE_KPIS);
  await client.close();
});

test("summary-backed aggregates drop a trace whose canonical root precedes the window", async () => {
  const { client, db } = await setup();
  const since = new Date("2026-07-30T00:00:00.000Z");
  const until = new Date("2026-07-31T00:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(280),
        traceId: traceId(280),
        spanId: spanId(280),
        name: "pre-window.root",
        startedAt: new Date("2026-07-29T23:00:00.000Z"),
        durationMs: 1_000,
        inputTokens: 20,
      }),
      span({
        id: uuid(281),
        traceId: traceId(280),
        spanId: spanId(281),
        name: "in-window.root",
        startedAt: new Date("2026-07-30T09:00:00.000Z"),
        durationMs: 250,
        inputTokens: 10,
      }),
    ],
    db,
  );
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  const [live, summary] = await Promise.all([
    getTraceKpis(PROJECT_ID, { since, until }, db),
    getTraceKpisFromSummaries(PROJECT_ID, { since, until }, db),
  ]);

  // Accepted, flag-gated divergence: the summary pins one window-independent
  // representative per trace (the whole-trace canonical root), so a trace that
  // straddles the boundary belongs to the window its canonical root falls in —
  // where the live rollup re-picks the earliest in-window root and counts it
  // here too. Immaterial in aggregate; pinned so it can never drift silently.
  assert.deepEqual({ live: live.traceCount, summary: summary.traceCount }, { live: 1, summary: 0 });
  await client.close();
});

test("getTracesIngestDiagnostics distinguishes telemetry from persisted spans", async () => {
  const { client, db } = await setup();
  const eventAt = new Date("2026-07-30T09:00:00.000Z");
  const spanAt = new Date("2026-07-30T10:00:00.000Z");
  await client.exec(`
    insert into events (id, project_id, received_at, occurred_at)
    values ('${uuid(120)}', '${PROJECT_ID}', '${eventAt.toISOString()}', '${eventAt.toISOString()}');
  `);
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(121),
        traceId: traceId(121),
        spanId: spanId(121),
        startedAt: spanAt,
      }),
    ],
    db,
  );

  assert.deepEqual(await getTracesIngestDiagnostics(PROJECT_ID, db), {
    hasEvents: true,
    hasSpans: true,
    latestEventAt: eventAt,
    latestSpanAt: spanAt,
  });
  assert.deepEqual(await getTracesIngestDiagnostics(OTHER_PROJECT_ID, db), {
    hasEvents: false,
    hasSpans: false,
    latestEventAt: null,
    latestSpanAt: null,
  });
  await client.close();
});

test("listTraces represents a window-straddling multi-root trace by its earliest in-window root", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(90),
        traceId: traceId(90),
        spanId: spanId(90),
        name: "pre-window.root",
        startedAt: new Date("2026-07-29T23:00:00.000Z"),
      }),
      span({
        id: uuid(91),
        traceId: traceId(90),
        spanId: spanId(91),
        name: "in-window.root",
        startedAt: new Date("2026-07-30T09:00:00.000Z"),
      }),
    ],
    db,
  );

  const page = await listTraces(
    PROJECT_ID,
    {
      since: new Date("2026-07-30T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
    },
    db,
  );

  assert.deepEqual(
    page.items.map(({ traceId: id, rootName, spanCount }) => ({
      id,
      rootName,
      spanCount,
    })),
    [{ id: traceId(90), rootName: "in-window.root", spanCount: 2 }],
  );
  await client.close();
});

test("listTraces represents a window-straddling rootless trace by its earliest in-window span", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(93),
        traceId: traceId(92),
        spanId: spanId(93),
        parentSpanId: spanId(999),
        name: "pre-window.orphan",
        startedAt: new Date("2026-07-29T23:00:00.000Z"),
      }),
      span({
        id: uuid(94),
        traceId: traceId(92),
        spanId: spanId(94),
        parentSpanId: spanId(93),
        name: "in-window.child",
        startedAt: new Date("2026-07-30T09:00:00.000Z"),
      }),
    ],
    db,
  );

  const page = await listTraces(
    PROJECT_ID,
    {
      since: new Date("2026-07-30T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
    },
    db,
  );

  assert.deepEqual(
    page.items.map(({ traceId: id, rootName, spanCount }) => ({
      id,
      rootName,
      spanCount,
    })),
    [{ id: traceId(92), rootName: "in-window.child", spanCount: 2 }],
  );
  await client.close();
});

test("pruneExpiredOtelSpans expires spans by server receipt time", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(200),
        traceId: traceId(200),
        spanId: spanId(200),
        startedAt: new Date("2099-01-01T00:00:00.000Z"),
      }),
      span({
        id: uuid(201),
        traceId: traceId(201),
        spanId: spanId(201),
        startedAt: new Date("2000-01-01T00:00:00.000Z"),
      }),
      span({
        id: uuid(202),
        traceId: traceId(202),
        spanId: spanId(202),
      }),
    ],
    db,
  );
  await client.exec(`
    update otel_spans
    set received_at = case id
      when '${uuid(200)}' then '2026-06-29T23:59:59.999Z'::timestamptz
      when '${uuid(201)}' then '2026-06-30T00:00:00.000Z'::timestamptz
      else '2026-07-01T00:00:00.000Z'::timestamptz
    end;
  `);

  const pruned = await pruneExpiredOtelSpans(
    {
      now: new Date("2026-07-30T00:00:00.000Z"),
      retentionDays: 30,
    },
    db,
  );
  const [expired, boundary, fresh] = await Promise.all([
    getTraceSpans(PROJECT_ID, traceId(200), db),
    getTraceSpans(PROJECT_ID, traceId(201), db),
    getTraceSpans(PROJECT_ID, traceId(202), db),
  ]);

  assert.deepEqual(
    {
      pruned,
      expired: expired.length,
      boundary: boundary.length,
      fresh: fresh.length,
    },
    { pruned: 1, expired: 0, boundary: 1, fresh: 1 },
  );
  await client.close();
});

test("pruneExpiredOtelSpans deletes at most 5000 rows per tick", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    Array.from({ length: 5_001 }, (_, index) =>
      span({
        id: uuid(1_000 + index),
        traceId: traceId(1_000 + index),
        spanId: spanId(1_000 + index),
      }),
    ),
    db,
  );
  await client.exec(`
    update otel_spans
    set received_at = '2026-01-01T00:00:00.000Z'::timestamptz;
  `);
  const options = {
    now: new Date("2026-07-30T00:00:00.000Z"),
    retentionDays: 30,
  };

  const counts = [
    await pruneExpiredOtelSpans(options, db),
    await pruneExpiredOtelSpans(options, db),
    await pruneExpiredOtelSpans(options, db),
  ];

  assert.deepEqual(counts, [5_000, 1, 0]);
  await client.close();
});

test("pruneExpiredOtelSpans falls back when retention config exceeds the date range", async () => {
  const { client, db } = await setup();
  const previousRetention = process.env.OTEL_SPAN_RETENTION_DAYS;
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(210),
        traceId: traceId(210),
        spanId: spanId(210),
      }),
    ],
    db,
  );
  await client.exec(`
    update otel_spans
    set received_at = '2026-06-29T23:59:59.999Z'::timestamptz;
  `);
  process.env.OTEL_SPAN_RETENTION_DAYS = "1e308";

  try {
    assert.equal(await pruneExpiredOtelSpans({ now: new Date("2026-07-30T00:00:00.000Z") }, db), 1);
  } finally {
    if (previousRetention === undefined) {
      delete process.env.OTEL_SPAN_RETENTION_DAYS;
    } else {
      process.env.OTEL_SPAN_RETENTION_DAYS = previousRetention;
    }
    await client.close();
  }
});

test("pruneExpiredTraceSummaries expires summaries by their spans' receipt time", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({ id: uuid(300), traceId: traceId(300), spanId: spanId(300) }),
      span({ id: uuid(301), traceId: traceId(301), spanId: spanId(301) }),
    ],
    db,
  );
  await client.exec(`
    update otel_spans
    set received_at = case id
      when '${uuid(300)}' then '2026-06-29T23:59:59.999Z'::timestamptz
      else '2026-07-01T00:00:00.000Z'::timestamptz
    end;
  `);
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  const pruned = await pruneExpiredTraceSummaries(
    { now: new Date("2026-07-30T00:00:00.000Z"), retentionDays: 30 },
    db,
  );

  assert.deepEqual(
    { pruned, remaining: await readSummaryTraceIds(db) },
    { pruned: 1, remaining: [traceId(301)] },
  );
  await client.close();
});

test("pruneExpiredTraceSummaries deletes at most 5000 rows per tick", async () => {
  const { client, db } = await setup();
  // Written directly: this bounds the delete, and materializing 5001 traces
  // through the sweep would only make the test slower.
  await client.exec(`
    insert into otel_trace_summaries (
      project_id, trace_id, started_at, duration_ms, has_error,
      input_tokens, output_tokens, cost_usd, spans_max_received_at
    )
    select
      '${PROJECT_ID}',
      lpad(series::text, 32, '0'),
      '2026-07-30T00:00:00.000Z'::timestamptz,
      1, false, 0, 0, 0,
      '2026-01-01T00:00:00.000Z'::timestamptz
    from generate_series(1, 5001) as series;
  `);
  const options = {
    now: new Date("2026-07-30T00:00:00.000Z"),
    retentionDays: 30,
  };

  const counts = [
    await pruneExpiredTraceSummaries(options, db),
    await pruneExpiredTraceSummaries(options, db),
    await pruneExpiredTraceSummaries(options, db),
  ];

  assert.deepEqual(counts, [5_000, 1, 0]);
  await client.close();
});

test("pruneExpiredOtelLogs expires logs by server receipt time", async () => {
  const { client, db } = await setup();
  await insertOtelLogs(
    PROJECT_ID,
    [
      otelLog({
        id: uuid(300),
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
      }),
      otelLog({
        id: uuid(301),
        occurredAt: new Date("2000-01-01T00:00:00.000Z"),
      }),
      otelLog({ id: uuid(302) }),
    ],
    db,
  );
  await client.exec(`
    update otel_logs
    set received_at = case id
      when '${uuid(300)}' then '2026-06-29T23:59:59.999Z'::timestamptz
      when '${uuid(301)}' then '2026-06-30T00:00:00.000Z'::timestamptz
      else '2026-07-01T00:00:00.000Z'::timestamptz
    end;
  `);

  const pruned = await pruneExpiredOtelLogs(
    {
      now: new Date("2026-07-30T00:00:00.000Z"),
      retentionDays: 30,
    },
    db,
  );
  const result = await client.query<{ id: string }>("select id from otel_logs order by id");

  assert.deepEqual(
    { pruned, remainingIds: result.rows.map(({ id }) => id) },
    { pruned: 1, remainingIds: [uuid(301), uuid(302)] },
  );
  await client.close();
});

test("pruneExpiredOtelLogs deletes at most 5000 rows per tick", async () => {
  const { client, db } = await setup();
  await insertOtelLogs(
    PROJECT_ID,
    Array.from({ length: 5_001 }, (_, index) => otelLog({ id: uuid(10_000 + index) })),
    db,
  );
  await client.exec(`
    update otel_logs
    set received_at = '2026-01-01T00:00:00.000Z'::timestamptz;
  `);
  const options = {
    now: new Date("2026-07-30T00:00:00.000Z"),
    retentionDays: 30,
  };

  const counts = [
    await pruneExpiredOtelLogs(options, db),
    await pruneExpiredOtelLogs(options, db),
    await pruneExpiredOtelLogs(options, db),
  ];

  assert.deepEqual(counts, [5_000, 1, 0]);
  await client.close();
});

test("OTEL_LOG_RETENTION_DAYS overrides span retention for logs", async () => {
  const { client, db } = await setup();
  const previousLogRetention = process.env.OTEL_LOG_RETENTION_DAYS;
  const previousSpanRetention = process.env.OTEL_SPAN_RETENTION_DAYS;
  await insertOtelLogs(PROJECT_ID, [otelLog()], db);
  await client.exec(`
    update otel_logs
    set received_at = '2026-07-28T00:00:00.000Z'::timestamptz;
  `);
  process.env.OTEL_LOG_RETENTION_DAYS = "1";
  process.env.OTEL_SPAN_RETENTION_DAYS = "30";

  try {
    assert.equal(await pruneExpiredOtelLogs({ now: new Date("2026-07-30T00:00:00.000Z") }, db), 1);
  } finally {
    restoreEnv("OTEL_LOG_RETENTION_DAYS", previousLogRetention);
    restoreEnv("OTEL_SPAN_RETENTION_DAYS", previousSpanRetention);
    await client.close();
  }
});

test("log pruning falls back to OTEL_SPAN_RETENTION_DAYS", async () => {
  const { client, db } = await setup();
  const previousLogRetention = process.env.OTEL_LOG_RETENTION_DAYS;
  const previousSpanRetention = process.env.OTEL_SPAN_RETENTION_DAYS;
  await insertOtelLogs(PROJECT_ID, [otelLog()], db);
  await client.exec(`
    update otel_logs
    set received_at = '2026-07-28T00:00:00.000Z'::timestamptz;
  `);
  process.env.OTEL_LOG_RETENTION_DAYS = "invalid";
  process.env.OTEL_SPAN_RETENTION_DAYS = "1";

  try {
    assert.equal(await pruneExpiredOtelLogs({ now: new Date("2026-07-30T00:00:00.000Z") }, db), 1);
  } finally {
    restoreEnv("OTEL_LOG_RETENTION_DAYS", previousLogRetention);
    restoreEnv("OTEL_SPAN_RETENTION_DAYS", previousSpanRetention);
    await client.close();
  }
});

test("log pruning defaults to 30 days when retention config is invalid", async () => {
  const { client, db } = await setup();
  const previousLogRetention = process.env.OTEL_LOG_RETENTION_DAYS;
  const previousSpanRetention = process.env.OTEL_SPAN_RETENTION_DAYS;
  await insertOtelLogs(PROJECT_ID, [otelLog()], db);
  await client.exec(`
    update otel_logs
    set received_at = '2026-06-29T23:59:59.999Z'::timestamptz;
  `);
  process.env.OTEL_LOG_RETENTION_DAYS = "invalid";
  process.env.OTEL_SPAN_RETENTION_DAYS = "1e308";

  try {
    assert.equal(await pruneExpiredOtelLogs({ now: new Date("2026-07-30T00:00:00.000Z") }, db), 1);
  } finally {
    restoreEnv("OTEL_LOG_RETENTION_DAYS", previousLogRetention);
    restoreEnv("OTEL_SPAN_RETENTION_DAYS", previousSpanRetention);
    await client.close();
  }
});

async function setup(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return {
    client,
    db: drizzle(client, { schema }) as unknown as TestDb,
  };
}

async function readSummaryTraceIds(db: TestDb): Promise<string[]> {
  const rows = await db
    .select({ traceId: otelTraceSummaries.traceId })
    .from(otelTraceSummaries)
    .orderBy(asc(otelTraceSummaries.traceId));
  return rows.map(({ traceId: summarized }) => summarized);
}

function span(overrides: Partial<NewOtelSpan> = {}): NewOtelSpan {
  const startedAt = overrides.startedAt ?? new Date("2026-07-30T10:00:00.000Z");
  return {
    id: uuid(1),
    projectId: PROJECT_ID,
    traceId: TRACE_ID,
    spanId: spanId(1),
    parentSpanId: null,
    name: "agent.run",
    kind: 1,
    spanClass: "other",
    endedAt: overrides.endedAt ?? new Date(startedAt.getTime() + 100),
    durationMs: overrides.durationMs ?? 100,
    statusCode: 1,
    serviceName: "fixture-agent",
    scopeName: "fixture",
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...overrides,
    startedAt,
  };
}

function otelLog(overrides: Partial<NewOtelLog> = {}): NewOtelLog {
  return {
    id: uuid(300),
    projectId: PROJECT_ID,
    occurredAt: new Date("2026-07-30T10:00:00.000Z"),
    eventName: "ratel.experiment.results",
    traceId: traceId(300),
    spanId: spanId(300),
    severityNumber: 9,
    serviceName: "fixture-agent",
    scopeName: "@ratel-ai/sdk",
    body: null,
    experimentName: "search-ranking-v2",
    experimentArm: "candidate",
    experimentRole: "shadow",
    experimentSelectionId: "selection-1",
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...overrides,
  };
}

async function insertLifecycleRecords(
  db: TestDb,
  projectId: string,
  records: DecodedLogRecord[],
): Promise<void> {
  const { rows, dropped } = toOtelLogRows(projectId, records);
  assert.equal(dropped, 0);
  assert.deepEqual(await insertOtelLogs(projectId, rows, db), {
    accepted: rows.length,
  });
}

function lifecycleRecord(
  event: "results" | "comparison" | "skip" | "fallback" | "drop" | "outcome" | "invocation",
  occurredAt: string,
  attributes: Record<string, unknown> = {},
  recordTraceId = TRACE_ID,
): DecodedLogRecord {
  const occurredAtMs = Date.parse(occurredAt);
  return {
    eventName: `ratel.experiment.${event}`,
    timeUnixNano: (BigInt(occurredAtMs) * BigInt(1_000_000)).toString(),
    timeUnixMs: occurredAtMs,
    observedTimeUnixNano: "",
    observedTimeUnixMs: 0,
    traceId: recordTraceId,
    spanId: spanId(1),
    severityNumber: 9,
    severityText: "INFO",
    body: null,
    attributes: {
      "ratel.experiment.id": "ranking",
      "ratel.experiment.selection_id": `selection-${occurredAt}`,
      "ratel.experiment.arm": "candidate",
      "ratel.experiment.role": "shadow",
      ...attributes,
    },
    resourceAttributes: { "service.name": "fixture-agent" },
    scopeName: "@ratel-ai/sdk",
  };
}

function lifecycleDetails(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) =>
        ![
          "ratel.experiment.id",
          "ratel.experiment.selection_id",
          "ratel.experiment.arm",
          "ratel.experiment.role",
        ].includes(key),
    ),
  );
}

function uuid(value: number): string {
  return `00000000-0000-8000-8000-${value.toString(16).padStart(12, "0")}`;
}

function spanId(value: number): string {
  return value.toString(16).padStart(16, "0");
}

function traceId(value: number): string {
  return value.toString(16).padStart(32, "0");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
