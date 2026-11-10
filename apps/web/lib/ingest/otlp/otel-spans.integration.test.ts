import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { findTracesWithModelCalls, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import { toOtelSpanRows } from "@/lib/ingest/otlp/span-rows";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type Db = NonNullable<Parameters<typeof insertOtelSpans>[2]>;
type LoggedQuery = { query: string; params: unknown[] };

async function setup(queryLog?: LoggedQuery[]): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  const db = queryLog
    ? drizzle(client, {
        schema,
        logger: {
          logQuery(query, params) {
            queryLog.push({ query, params });
          },
        },
      })
    : drizzle(client, { schema });
  return { client, db: db as unknown as Db };
}

function span(overrides: Partial<NewOtelSpan> = {}): NewOtelSpan {
  return {
    id: "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa",
    projectId: PROJECT_ID,
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    parentSpanId: null,
    name: "agent.run",
    kind: 1,
    spanClass: "other",
    startedAt: new Date("2026-07-29T12:00:00.000Z"),
    endedAt: new Date("2026-07-29T12:00:01.000Z"),
    durationMs: 1_000,
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
  };
}

test("otel ingest tables use fixed-threshold planner maintenance", async () => {
  const { client } = await setup();

  const result = await client.query<{
    relname: string;
    reloptions: string[];
  }>(`
    select relname, reloptions
      from pg_class
     where relname in ('otel_logs', 'otel_spans', 'otel_trace_summaries')
     order by relname
  `);

  assert.deepEqual(result.rows, [
    {
      relname: "otel_logs",
      reloptions: [
        "autovacuum_analyze_scale_factor=0.0",
        "autovacuum_analyze_threshold=1000",
        "autovacuum_vacuum_scale_factor=0.05",
      ],
    },
    {
      relname: "otel_spans",
      reloptions: [
        "autovacuum_analyze_scale_factor=0.0",
        "autovacuum_analyze_threshold=1000",
        "autovacuum_vacuum_scale_factor=0.05",
      ],
    },
    {
      relname: "otel_trace_summaries",
      reloptions: [
        "autovacuum_analyze_scale_factor=0.0",
        "autovacuum_analyze_threshold=1000",
        "autovacuum_vacuum_scale_factor=0.05",
      ],
    },
  ]);
});

test("mapped decoded spans persist promoted GenAI and experiment columns", async () => {
  const { client, db } = await setup();
  const decoded: DecodedSpan = {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    parentSpanId: null,
    name: "chat gpt-5.5",
    kind: 3,
    startUnixMs: Date.parse("2026-07-29T12:00:00.000Z"),
    endUnixMs: Date.parse("2026-07-29T12:00:01.000Z"),
    statusCode: 1,
    scopeName: "fixture",
    resourceAttributes: { "service.name": "fixture-agent" },
    events: [],
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.response.model": "gpt-5.5",
      "gen_ai.usage.input_tokens": 1_000,
      "gen_ai.usage.output_tokens": 200,
      "gen_ai.usage.cache_read.input_tokens": 400,
      "ratel.experiment.id": "search-ranking-v2",
      "ratel.experiment.arm": "candidate",
      "ratel.experiment.role": "shadow",
      "ratel.experiment.iteration": 4,
    },
  };

  assert.deepEqual(await insertOtelSpans(PROJECT_ID, toOtelSpanRows(PROJECT_ID, [decoded]), db), {
    accepted: 1,
  });

  const result = await client.query<{
    project_id: string;
    span_class: string;
    operation_name: string;
    provider_name: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cost_usd: string;
    experiment_name: string;
    experiment_arm: string;
    experiment_role: string;
    experiment_attrs: Record<string, unknown>;
  }>(`
    select project_id, span_class, operation_name, provider_name, model,
           input_tokens, output_tokens, cached_tokens, cost_usd::text,
           experiment_name, experiment_arm, experiment_role, experiment_attrs
      from otel_spans
  `);

  assert.deepEqual(result.rows, [
    {
      project_id: PROJECT_ID,
      span_class: "llm_call",
      operation_name: "chat",
      provider_name: "openai",
      model: "gpt-5.5",
      input_tokens: 1_000,
      output_tokens: 200,
      cached_tokens: 400,
      cost_usd: "0.004000",
      experiment_name: "search-ranking-v2",
      experiment_arm: "candidate",
      experiment_role: "shadow",
      experiment_attrs: {
        "ratel.experiment.id": "search-ranking-v2",
        "ratel.experiment.arm": "candidate",
        "ratel.experiment.role": "shadow",
        "ratel.experiment.iteration": 4,
      },
    },
  ]);
});

test("replaying a span batch is idempotent", async () => {
  const { db } = await setup();
  const rows = [
    span(),
    span({
      id: "bbbbbbbb-bbbb-8bbb-8bbb-bbbbbbbbbbbb",
      spanId: "fedcba9876543210",
      parentSpanId: "0123456789abcdef",
      name: "tool.call",
      spanClass: "tool",
    }),
  ];

  assert.deepEqual(await insertOtelSpans(PROJECT_ID, rows, db), {
    accepted: 2,
  });
  assert.deepEqual(await insertOtelSpans(PROJECT_ID, rows, db), {
    accepted: 0,
  });
});

test("a 1001-span export is split into statements of at most 500 rows", async () => {
  const queryLog: LoggedQuery[] = [];
  const { db } = await setup(queryLog);
  const rows = Array.from({ length: 1_001 }, (_, i) =>
    span({
      id: `00000000-0000-8000-8000-${i.toString(16).padStart(12, "0")}`,
      spanId: i.toString(16).padStart(16, "0"),
    }),
  );

  assert.deepEqual(await insertOtelSpans(PROJECT_ID, rows, db), {
    accepted: 1_001,
  });

  const inserts = queryLog.filter(({ query }) => query.startsWith('insert into "otel_spans"'));
  assert.deepEqual(
    inserts.map(({ query }) => insertedRowCount(query)),
    [500, 500, 1],
  );
});

test("a failed later chunk rolls back earlier span inserts", async () => {
  const { client, db } = await setup();
  const rows = Array.from({ length: 501 }, (_, i) =>
    span({
      id:
        i === 500 ? "invalid-uuid" : `00000000-0000-8000-8000-${i.toString(16).padStart(12, "0")}`,
      spanId: i.toString(16).padStart(16, "0"),
    }),
  );

  await assert.rejects(insertOtelSpans(PROJECT_ID, rows, db));

  const result = await client.query<{ count: number }>(
    "select count(*)::int as count from otel_spans",
  );
  assert.equal(result.rows[0]?.count, 0);
});

function insertedRowCount(query: string): number {
  const valuesStart = query.indexOf(" values ");
  const conflictStart = query.indexOf(" on conflict", valuesStart);
  assert.notEqual(valuesStart, -1, "insert has a values clause");
  assert.notEqual(conflictStart, -1, "insert has an on conflict clause");
  const values = query.slice(valuesStart + " values ".length, conflictStart);
  return (values.match(/\), \(/g)?.length ?? 0) + 1;
}

test("findTracesWithModelCalls returns only traces with a stored non-agent, non-embeddings llm_call", async () => {
  const { db } = await setup();
  const chatTrace = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
  const agentOnlyTrace = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
  const toolTrace = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
  const embeddingsTrace = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({ traceId: chatTrace, spanClass: "llm_call", operationName: "chat" }),
      span({
        id: "bbbbbbbb-bbbb-8bbb-8bbb-bbbbbbbbbbbb",
        traceId: agentOnlyTrace,
        spanClass: "llm_call",
        operationName: "invoke_agent",
      }),
      span({ id: "cccccccc-cccc-8ccc-8ccc-cccccccccccc", traceId: toolTrace, spanClass: "tool" }),
      span({
        id: "dddddddd-dddd-8ddd-8ddd-dddddddddddd",
        traceId: embeddingsTrace,
        spanClass: "llm_call",
        operationName: "embeddings",
      }),
    ],
    db,
  );

  const readDb = db as unknown as NonNullable<Parameters<typeof findTracesWithModelCalls>[2]>;
  const found = await findTracesWithModelCalls(
    PROJECT_ID,
    [chatTrace, agentOnlyTrace, toolTrace, embeddingsTrace, "ffffffffffffffffffffffffffffffff"],
    readDb,
  );
  assert.deepEqual([...found], [chatTrace]);
  assert.deepEqual(
    [
      ...(await findTracesWithModelCalls(
        "33333333-3333-4333-8333-333333333333",
        [chatTrace],
        readDb,
      )),
    ],
    [],
  );
});
