import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getTraceAggregates, type TraceQueriesDb } from "./queries";
import { listRunAsks, listRunTools } from "./run-details";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

type TestDb = TraceQueriesDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("run details list each run's tools in first-call order and its captured ask", async () => {
  const { client, db } = await setup();
  const t0 = Date.parse("2026-10-09T12:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      span(1, { traceId: traceId(1), name: "invoke_agent support-agent", at: t0 }),
      span(2, {
        traceId: traceId(1),
        parentSpanId: spanId(1),
        spanClass: "llm_call",
        name: "chat",
        at: t0 + 1,
        attributes: {
          "gen_ai.input.messages": JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "an older question" }] },
            { role: "user", parts: [{ type: "text", content: "Where is order 1234?" }] },
          ]),
        },
      }),
      span(3, {
        traceId: traceId(1),
        parentSpanId: spanId(1),
        spanClass: "tool",
        name: "execute_tool search_docs",
        at: t0 + 5,
        attributes: { "gen_ai.tool.name": "search_docs" },
      }),
      span(4, {
        traceId: traceId(1),
        parentSpanId: spanId(1),
        spanClass: "tool",
        name: "execute_tool lookup_order",
        at: t0 + 3,
        attributes: { "gen_ai.tool.name": "lookup_order" },
      }),
      span(5, {
        traceId: traceId(1),
        parentSpanId: spanId(1),
        spanClass: "tool",
        name: "execute_tool lookup_order",
        at: t0 + 7,
        attributes: { "gen_ai.tool.name": "lookup_order" },
      }),
      // Content capture off, tools named by span only.
      span(6, { traceId: traceId(2), name: "agent.run", at: t0 }),
      span(7, {
        traceId: traceId(2),
        parentSpanId: spanId(6),
        spanClass: "llm_call",
        name: "chat",
        at: t0 + 1,
      }),
      span(8, {
        traceId: traceId(2),
        parentSpanId: spanId(6),
        spanClass: "tool",
        name: "tool.ripgrep",
        at: t0 + 2,
      }),
    ],
    db,
  );
  // Another project's span on the same trace id must not leak in.
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [span(9, { traceId: traceId(1), spanClass: "tool", name: "execute_tool secret_tool", at: t0 })],
    db,
  );

  const ids = [traceId(1), traceId(2), traceId(3)];
  const [tools, asks] = await Promise.all([
    listRunTools(PROJECT_ID, ids, db),
    listRunAsks(PROJECT_ID, ids, db),
  ]);
  assert.deepEqual(tools.get(traceId(1)), ["lookup_order", "search_docs"]);
  assert.deepEqual(asks.get(traceId(1)), { prompt: "Where is order 1234?", hasRoot: true });
  assert.deepEqual(tools.get(traceId(2)), ["ripgrep"]);
  assert.deepEqual(asks.get(traceId(2)), { prompt: null, hasRoot: true });
  assert.deepEqual(tools.get(traceId(3)), [], "an unknown id still answers");
  assert.deepEqual(asks.get(traceId(3)), { prompt: null, hasRoot: false });
  assert.equal((await listRunTools(PROJECT_ID, [], db)).size, 0);
  assert.equal((await listRunAsks(PROJECT_ID, [], db)).size, 0);
  await client.close();
});

test("the root's prompt is the fallback when the first model call has none", async () => {
  const { client, db } = await setup();
  const t0 = Date.parse("2026-10-09T12:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      span(1, {
        traceId: traceId(1),
        name: "ai.generateText",
        at: t0,
        attributes: { "ai.prompt": JSON.stringify({ prompt: "Summarize the ticket" }) },
      }),
      span(2, {
        traceId: traceId(1),
        parentSpanId: spanId(1),
        spanClass: "llm_call",
        name: "chat",
        at: t0 + 1,
      }),
    ],
    db,
  );
  const asks = await listRunAsks(PROJECT_ID, [traceId(1)], db);
  assert.equal(asks.get(traceId(1))?.prompt, "Summarize the ticket");
  await client.close();
});

test("a long run's ask is its first model call's, however many calls follow and in whatever order they were stored", async () => {
  const { client, db } = await setup();
  const t0 = Date.parse("2026-10-09T12:00:00.000Z");
  const messages = (content: string) => ({
    "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content }] }]),
  });
  await insertOtelSpans(
    PROJECT_ID,
    [
      span(1, {
        traceId: traceId(1),
        name: "agent.run",
        at: t0,
        attributes: { "ai.prompt": JSON.stringify({ prompt: "the root's own prompt" }) },
      }),
      // Inserted out of order: the first call is picked by start time, not by row.
      ...Array.from({ length: 300 }, (_, index) =>
        span(100 + index, {
          traceId: traceId(1),
          parentSpanId: spanId(1),
          spanClass: "llm_call",
          name: "chat",
          at: t0 + 10 + (300 - index),
          attributes: messages(index === 299 ? "the first question" : `follow-up ${index}`),
        }),
      ),
    ],
    db,
  );
  const asks = await listRunAsks(PROJECT_ID, [traceId(1)], db);
  assert.deepEqual(asks.get(traceId(1)), { prompt: "the first question", hasRoot: true });
  await client.close();
});

test("a run whose top-level span has not arrived reports it, and its tools still read", async () => {
  const { client, db } = await setup();
  const t0 = Date.parse("2026-10-09T12:00:00.000Z");
  await insertOtelSpans(
    PROJECT_ID,
    [
      // Still running: the children arrived, the top-level span has not.
      span(1, {
        traceId: traceId(1),
        parentSpanId: spanId(99),
        spanClass: "llm_call",
        name: "chat",
        at: t0,
      }),
      span(2, {
        traceId: traceId(1),
        parentSpanId: spanId(99),
        spanClass: "tool",
        name: "execute_tool search_docs",
        at: t0 + 1,
      }),
      // Not named the OpenTelemetry way: the tool comes from its attribute.
      span(3, {
        traceId: traceId(1),
        parentSpanId: spanId(99),
        spanClass: "tool",
        name: "ai.toolCall",
        at: t0 + 2,
        attributes: { "gen_ai.tool.name": "refund" },
      }),
    ],
    db,
  );
  const [tools, asks] = await Promise.all([
    listRunTools(PROJECT_ID, [traceId(1)], db),
    listRunAsks(PROJECT_ID, [traceId(1)], db),
  ]);
  assert.deepEqual(tools.get(traceId(1)), ["search_docs", "refund"]);
  assert.deepEqual(asks.get(traceId(1)), { prompt: null, hasRoot: false });
  await client.close();
});

test("trace aggregates can count volume per UTC hour, and stay daily by default", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span(1, { traceId: traceId(1), at: Date.parse("2026-10-09T11:05:00.000Z") }),
      span(2, { traceId: traceId(2), at: Date.parse("2026-10-09T11:55:00.000Z"), statusCode: 2 }),
      span(3, { traceId: traceId(3), at: Date.parse("2026-10-09T12:10:00.000Z") }),
      span(4, { traceId: traceId(4), at: Date.parse("2026-10-10T00:30:00.000Z") }),
    ],
    db,
  );
  const window = {
    since: new Date("2026-10-09T00:00:00.000Z"),
    until: new Date("2026-10-11T00:00:00.000Z"),
  };
  const hourly = await getTraceAggregates(PROJECT_ID, { ...window, volumeBucket: "hour" }, db);
  assert.deepEqual(hourly.volume, [
    { day: "2026-10-09", hour: 11, count: 2, errorCount: 1 },
    { day: "2026-10-09", hour: 12, count: 1, errorCount: 0 },
    { day: "2026-10-10", hour: 0, count: 1, errorCount: 0 },
  ]);
  assert.equal(hourly.count, 4);
  const daily = await getTraceAggregates(PROJECT_ID, window, db);
  assert.deepEqual(daily.volume, [
    { day: "2026-10-09", count: 3, errorCount: 1 },
    { day: "2026-10-10", count: 1, errorCount: 0 },
  ]);
  await client.close();
});

async function setup(): Promise<{
  client: Awaited<ReturnType<typeof createMigratedPGlite>>;
  db: TestDb;
}> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as TestDb };
}

function span(index: number, overrides: Partial<NewOtelSpan> & { at: number }): NewOtelSpan {
  const { at, ...rest } = overrides;
  const startedAt = new Date(at);
  return {
    id: uuid(index),
    projectId: PROJECT_ID,
    traceId: traceId(index),
    spanId: spanId(index),
    parentSpanId: null,
    name: "agent.run",
    kind: 1,
    spanClass: "other",
    startedAt,
    endedAt: new Date(at + 100),
    durationMs: 100,
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
    ...rest,
  };
}

function uuid(value: number): string {
  return `00000000-0000-8000-8000-${value.toString(16).padStart(12, "0")}`;
}

function spanId(value: number): string {
  return value.toString(16).padStart(16, "0");
}

function traceId(value: number): string {
  return `a${value.toString(16).padStart(31, "0")}`;
}
