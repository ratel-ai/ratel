import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getTraceSpans, listOperations, listSpans, type TraceQueriesDb } from "./queries";

/**
 * AOBS-7: Spans group and filter by chat, task and repo, so cost is available
 * for each. The chat is on every span; the task and the repo are on the run's
 * root and reach every span of the run. A step's wait for a person stays out
 * of the latency numbers when asked.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);
const TRACE_C = "c".repeat(32);

test("groups cost by repo and by task, read from each run's root", async () => {
  const { client, db } = await seeded();
  const groups = async (groupBy: "repo" | "task") =>
    (await listOperations(PROJECT_ID, { groupBy, sort: "key", direction: "asc" }, db)).map(
      ({ key, count, costUsd, totalTokens }) => ({ key, count, costUsd, totalTokens }),
    );
  assert.deepEqual(await groups("repo"), [
    { key: "demo/api", count: 2, costUsd: 0.5, totalTokens: 5_000 },
    { key: "demo/app", count: 3, costUsd: 0.3, totalTokens: 3_000 },
  ]);
  assert.deepEqual(await groups("task"), [
    { key: "DEMO-12", count: 3, costUsd: 0.3, totalTokens: 3_000 },
  ]);
  await client.close();
});

test("groups cost by chat, from the conversation id of each span", async () => {
  const { client, db } = await seeded();
  const rows = await listOperations(
    PROJECT_ID,
    { groupBy: "chat", sort: "key", direction: "asc" },
    db,
  );
  assert.deepEqual(
    rows.map(({ key, count, costUsd }) => ({ key, count, costUsd })),
    [
      { key: "chat-1", count: 5, costUsd: 0.8 },
      { key: "chat-2", count: 2, costUsd: 0.07 },
    ],
  );
  await client.close();
});

test("the span list filters by repo, task and chat, exactly", async () => {
  const { client, db } = await seeded();
  const ids = async (options: Parameters<typeof listSpans>[1]) =>
    (await listSpans(PROJECT_ID, { ...options, sort: "started", direction: "asc" }, db)).items
      .map((item) => item.spanId)
      .sort();
  assert.deepEqual(await ids({ repo: "demo/api" }), [spanId(4), spanId(5)]);
  assert.deepEqual(await ids({ task: "DEMO-12" }), [spanId(1), spanId(2), spanId(3)]);
  assert.deepEqual(await ids({ chat: "chat-2" }), [spanId(6), spanId(7)]);
  assert.deepEqual(await ids({ repo: "demo" }), []);
  await client.close();
});

test("a wait for a person stays out of the latency of a group", async () => {
  const { client, db } = await seeded();
  const rows = await listOperations(PROJECT_ID, { groupBy: "tool" }, db);
  // AskUserQuestion ran 30.1 s, 30 s of it waiting for a person.
  assert.equal(rows.find((row) => row.key === "AskUserQuestion")?.p50DurationMs, 100);
  assert.equal(rows.find((row) => row.key === "Glob")?.p50DurationMs, 200);
  await client.close();
});

test("a stored span reads back with its events and links", async () => {
  const { client, db } = await seeded();
  const spans = await getTraceSpans(PROJECT_ID, TRACE_A, db);
  const root = spans.find((row) => row.spanId === spanId(1));
  assert.deepEqual(root?.events, [
    {
      name: "ratel.compaction",
      timeUnixMs: 1_794_909_600_050,
      attributes: { "ratel.compaction.trigger": "auto" },
    },
  ]);
  assert.deepEqual(root?.links, [{ traceId: TRACE_B, spanId: spanId(4), attributes: {} }]);
  assert.equal(spans.find((row) => row.spanId === spanId(2))?.events, null);
  await client.close();
});

test("a rewrite without events keeps the stored events and links", async () => {
  const { client, db } = await seeded();
  const [stored] = (await getTraceSpans(PROJECT_ID, TRACE_A, db)).filter(
    (row) => row.spanId === spanId(1),
  );
  await insertOtelSpans(
    PROJECT_ID,
    [{ ...stored!, name: "renamed", events: null, links: null }],
    db,
    { onConflict: "update" },
  );
  const [after] = (await getTraceSpans(PROJECT_ID, TRACE_A, db)).filter(
    (row) => row.spanId === spanId(1),
  );
  assert.equal(after?.name, "renamed");
  assert.deepEqual(after?.events, stored?.events);
  assert.deepEqual(after?.links, stored?.links);
  await client.close();
});

type TestDb = TraceQueriesDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

async function seeded(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  const chat = (
    id: number,
    traceId: string,
    parent: number,
    conversation: string,
    costUsd: string,
    tokens: number,
  ) =>
    span({
      id: uuid(id),
      spanId: spanId(id),
      traceId,
      parentSpanId: spanId(parent),
      spanClass: "llm_call",
      inputTokens: tokens,
      outputTokens: 0,
      costUsd,
      attributes: { "gen_ai.operation.name": "chat", "gen_ai.conversation.id": conversation },
    });
  await insertOtelSpans(
    PROJECT_ID,
    [
      // Run A: chat-1, repo demo/app, task DEMO-12.
      span({
        id: uuid(1),
        spanId: spanId(1),
        traceId: TRACE_A,
        attributes: {
          "gen_ai.conversation.id": "chat-1",
          "ratel.run.repo": "demo/app",
          "ratel.run.task": "DEMO-12",
          "ratel.run.cost_usd": 99,
        },
        events: [
          {
            name: "ratel.compaction",
            timeUnixMs: 1_794_909_600_050,
            attributes: { "ratel.compaction.trigger": "auto" },
          },
        ],
        links: [{ traceId: TRACE_B, spanId: spanId(4), attributes: {} }],
      }),
      chat(2, TRACE_A, 1, "chat-1", "0.1", 1_000),
      chat(3, TRACE_A, 1, "chat-1", "0.2", 2_000),
      // Run B: chat-1 again, another repo, no task.
      span({
        id: uuid(4),
        spanId: spanId(4),
        traceId: TRACE_B,
        attributes: { "gen_ai.conversation.id": "chat-1", "ratel.run.repo": "demo/api" },
      }),
      chat(5, TRACE_B, 4, "chat-1", "0.5", 5_000),
      // A malformed wait reads as no wait, and never breaks the query.
      span({
        id: uuid(8),
        spanId: spanId(8),
        traceId: TRACE_C,
        parentSpanId: spanId(6),
        spanClass: "tool",
        durationMs: 200,
        attributes: { "gen_ai.tool.name": "Glob", "ratel.wait.human_ms": "1x5" },
      }),
      // Run C: chat-2, no run context. One step waited 30 s for a person.
      span({
        id: uuid(6),
        spanId: spanId(6),
        traceId: TRACE_C,
        costUsd: "0.07",
        attributes: { "gen_ai.conversation.id": "chat-2" },
      }),
      span({
        id: uuid(7),
        spanId: spanId(7),
        traceId: TRACE_C,
        parentSpanId: spanId(6),
        spanClass: "tool",
        durationMs: 30_100,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "AskUserQuestion",
          "gen_ai.conversation.id": "chat-2",
          "ratel.wait.human_ms": 30_000,
          "ratel.wait.outcome": "answered",
        },
      }),
    ],
    db,
  );
  return { client, db };
}

function span(overrides: Partial<NewOtelSpan> = {}): NewOtelSpan {
  const startedAt = overrides.startedAt ?? new Date("2026-11-17T10:00:00.000Z");
  return {
    id: uuid(1),
    projectId: PROJECT_ID,
    traceId: TRACE_A,
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

function uuid(value: number): string {
  return `00000000-0000-8000-8000-${value.toString(16).padStart(12, "0")}`;
}

function spanId(value: number): string {
  return value.toString(16).padStart(16, "0");
}
