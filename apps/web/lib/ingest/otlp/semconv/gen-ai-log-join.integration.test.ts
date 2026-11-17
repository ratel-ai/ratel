import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import { handleLogsRequest } from "@/lib/ingest/otlp/logs-route-handler";
import {
  insertEventsWithMetrics,
  insertOtelLogs,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import {
  createGenAiLogStore,
  type GenAiLogStore,
} from "@/lib/ingest/otlp/semconv/gen-ai-log-store";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { ApiKey } from "@/lib/platform/projects/schema";

/**
 * Content sent as `gen_ai` log records
 * joins its model call whichever of the two exports is stored first.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";
const INPUT =
  '[{"role":"user","parts":[{"type":"text","content":"What is the weather in Rome?"}]}]';
const OUTPUT =
  '[{"role":"assistant","parts":[{"type":"text","content":"Sunny, 24 C."}],"finish_reason":"stop"}]';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const DETAILS = [
  {
    timeUnixNano: "1750000001000000000",
    eventName: "gen_ai.client.inference.operation.details",
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.input.messages", value: { stringValue: INPUT } },
      { key: "gen_ai.output.messages", value: { stringValue: OUTPUT } },
      {
        key: "gen_ai.system_instructions",
        value: { stringValue: '[{"type":"text","content":"Be brief."}]' },
      },
    ],
  },
];

const PER_MESSAGE = [
  {
    timeUnixNano: "1750000000100000000",
    eventName: "gen_ai.user.message",
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    body: {
      kvlistValue: {
        values: [{ key: "content", value: { stringValue: "What is the weather in Rome?" } }],
      },
    },
  },
  {
    timeUnixNano: "1750000000900000000",
    eventName: "gen_ai.choice",
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    body: {
      kvlistValue: {
        values: [
          { key: "finish_reason", value: { stringValue: "stop" } },
          {
            key: "message",
            value: {
              kvlistValue: {
                values: [
                  { key: "role", value: { stringValue: "assistant" } },
                  { key: "content", value: { stringValue: "Sunny, 24 C." } },
                ],
              },
            },
          },
        ],
      },
    },
  },
];

for (const [label, records] of [
  ["details record", DETAILS],
  ["per-message records", PER_MESSAGE],
] as const) {
  test(`${label}: logs first and spans first give the same events row`, async () => {
    const logsFirst = await setup();
    assert.equal((await sendLogs(logsFirst.db, records)).status, 202);
    await persistSpan(logsFirst.db);
    const fromLogsFirst = await storedCall(logsFirst.client);

    const spansFirst = await setup();
    await persistSpan(spansFirst.db);
    const withoutContent = await storedCall(spansFirst.client);
    assert.equal((await sendLogs(spansFirst.db, records)).status, 202);
    const fromSpansFirst = await storedCall(spansFirst.client);

    assert.notDeepEqual(withoutContent, fromSpansFirst, "the logs restate the stored call");
    assert.deepEqual(fromSpansFirst, fromLogsFirst);
    const messages = (
      fromLogsFirst.event.payload as { messages: Array<{ role: string; content: unknown }> }
    ).messages;
    assert.deepEqual(
      messages.map((message) => [message.role, message.content]),
      [
        ["user", [{ type: "text", text: "What is the weather in Rome?" }]],
        ["assistant", [{ type: "text", text: "Sunny, 24 C." }]],
      ],
    );
    await logsFirst.client.close();
    await spansFirst.client.close();
  });
}

test("spans first: a retried log export restates the same row once", async () => {
  const { client, db } = await setup();
  await persistSpan(db);
  await sendLogs(db, DETAILS);
  const first = await storedCall(client);
  await sendLogs(db, DETAILS);

  assert.deepEqual(await storedCall(client), first);
  const counts = await client.query<{ events: number; metrics: number }>(
    "select (select count(*)::int from events) as events, (select count(*)::int from event_metrics) as metrics",
  );
  assert.deepEqual(counts.rows, [{ events: 1, metrics: 1 }]);
  await client.close();
});

test("logs with no stored call yet restate nothing and insert no events row", async () => {
  const { client, db } = await setup();
  assert.equal((await sendLogs(db, DETAILS)).status, 202);

  const counts = await client.query<{ events: number; logs: number }>(
    "select (select count(*)::int from events) as events, (select count(*)::int from otel_logs) as logs",
  );
  assert.deepEqual(counts.rows, [{ events: 0, logs: 1 }]);
  await client.close();
});

test("a span batch and a log export that arrive together join", async () => {
  const expected = await setup();
  await sendLogs(expected.db, DETAILS);
  await persistSpan(expected.db);

  const { client, db } = await setup();
  const store = createGenAiLogStore(() => db as never);
  let raced = false;
  await persistSpan(db, {
    genAiLogs: {
      ...store,
      // The span batch reads no logs; the log export lands before the span is stored.
      findLogs: async (projectId, keys) => {
        const found = await store.findLogs(projectId, keys);
        if (!raced) {
          raced = true;
          assert.equal((await sendLogs(db, DETAILS)).status, 202);
        }
        return found;
      },
    },
  });

  assert.deepEqual(await storedCall(client), await storedCall(expected.client));
  await expected.client.close();
  await client.close();
});

test("spans first: a log record does not overwrite content the span carried", async () => {
  const { client, db } = await setup();
  await persistSpan(db, {
    attributes: { "gen_ai.input.messages": INPUT, "gen_ai.output.messages": OUTPUT },
  });
  const fromSpan = await storedCall(client);
  assert.equal((await sendLogs(db, [PER_MESSAGE[1]])).status, 202);

  assert.deepEqual(await storedCall(client), fromSpan);
  await client.close();
});

test("two log exports for one call: the older restate does not win", async () => {
  const expected = await setup();
  await persistSpan(expected.db);
  await sendLogs(expected.db, PER_MESSAGE);

  const { client, db } = await setup();
  await persistSpan(db);
  const store = createGenAiLogStore(() => db as never);
  // The first export reads only its own record, then the second export
  // lands and restates before the first one writes.
  await sendLogs(db, [PER_MESSAGE[0]], {
    ...store,
    restateCalls: async (projectId, rows) => {
      assert.equal((await sendLogs(db, [PER_MESSAGE[1]])).status, 202);
      return store.restateCalls(projectId, rows);
    },
  });

  assert.deepEqual(await storedCall(client), await storedCall(expected.client));
  await expected.client.close();
  await client.close();
});

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) };
}

/** A gzipped OTLP/JSON log export, as the OpenTelemetry Collector sends it. */
async function sendLogs(
  db: Db,
  logRecords: readonly unknown[],
  store: GenAiLogStore = createGenAiLogStore(() => db as never),
): Promise<Response> {
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "weather-agent" } }],
        },
        scopeLogs: [{ scope: { name: "opentelemetry.instrumentation.openai" }, logRecords }],
      },
    ],
  });
  return handleLogsRequest(
    new Request("http://localhost/v1/logs", {
      method: "POST",
      headers: {
        Authorization: "Bearer rtl_test",
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: gzipSync(body),
    }),
    {
      isDbConfigured: () => true,
      hashApiKey: (key) => key,
      findActiveApiKeyByHash: async () => ({ id: "key-1", projectId: PROJECT_ID }) as ApiKey,
      touchApiKey: async () => {},
      insertOtelLogs: (projectId, rows) => insertOtelLogs(projectId, rows, db as never),
      logError: (message, error) => {
        throw error instanceof Error ? error : new Error(message);
      },
      logWarn: () => {},
      genAiLogJoin: { store },
    },
  );
}

async function persistSpan(
  db: Db,
  {
    attributes = {},
    genAiLogs = createGenAiLogStore(() => db as never),
  }: { attributes?: DecodedSpan["attributes"]; genAiLogs?: GenAiLogStore } = {},
): Promise<void> {
  const span: DecodedSpan = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    parentSpanId: null,
    name: "chat gpt-4o",
    kind: 3,
    startUnixMs: 1_750_000_000_000,
    endUnixMs: 1_750_000_001_250,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.response.model": "gpt-4o-2024-08-06",
      "gen_ai.response.id": "chatcmpl-1",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 8,
      "gen_ai.response.finish_reasons": ["stop"],
      ...attributes,
    },
    events: [],
    statusCode: 1,
    resourceAttributes: { "service.name": "weather-agent" },
    scopeName: "opentelemetry.instrumentation.openai",
  };
  const result = await persistDecodedSpans(
    [span],
    { projectId: PROJECT_ID, organization: null, endpoint: "/v1/traces" },
    {
      insertEventsWithMetrics: (projectId, rows) =>
        insertEventsWithMetrics(projectId, rows, db as never),
      insertTraceEvents: async () => ({ accepted: 0 }),
      insertOtelSpans: (projectId, rows) => insertOtelSpans(projectId, rows, db as never),
      genAiLogs,
      logError: (message, error) => {
        throw error instanceof Error ? error : new Error(message);
      },
      captureFailure: (error) => {
        throw error;
      },
    },
  );
  assert.equal(result.ok, true);
}

/** The stored call, less its generated ids and receipt time. */
async function storedCall(client: PGlite) {
  const event = await client.query<Record<string, unknown>>(`
    select occurred_at, provider, model, stream, finish_reason, latency_ms, input_tokens, output_tokens,
           cached_tokens, reasoning_tokens, cost_usd, payload, dedupe_hash, categorizer_version, trace_id, span_id
      from events`);
  const metric = await client.query<Record<string, unknown>>(`
    select event_time, tokens_by_category, splits, tools_by_name, tools_total_count, tools_used_count,
           input_tokens, output_tokens, cost_usd, latency_ms, categorizer_version
      from event_metrics`);
  assert.equal(event.rows.length, 1);
  assert.equal(metric.rows.length, 1);
  return { event: event.rows[0], metric: metric.rows[0] };
}
