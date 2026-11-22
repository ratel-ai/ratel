import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { listSessionList } from "@/lib/synthesis/traces/v2/sessions-list";
import type { SessionsDb } from "./cursor";
import { getSessionsAggregate } from "./tab-aggregates";

/**
 * RC-752: the Sessions summary and the Sessions list count the same sessions.
 * An MCP server without trace context sends one trace per tool call; the
 * calls of one `mcp.session.id` form one `otlp-run:` turn (segment rule 4).
 * That turn's session is one session in both places, open or closed, and its
 * traces never count again as runs with no session.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const NOW = new Date(T0 + 3_600_000);
const WINDOW = { since: new Date(T0 - 3_600_000), until: NOW };

type TestDb = SessionsDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;
type Client = Awaited<ReturnType<typeof createMigratedPGlite>>;

test("one MCP session of 5 tool calls is 1 session in the summary and 1 row in the list", async () => {
  const { client, db } = await project();
  try {
    await mcpSession(client, db, {
      session: "mcp-s",
      run: 1,
      firstTrace: 1,
      calls: 5,
      at: 0,
      status: "closed",
    });
    const aggregate = await getSessionsAggregate(PROJECT_ID, WINDOW, db);
    const list = await listSessionList(PROJECT_ID, { filter: "all", now: NOW }, db);
    assert.equal(aggregate.count, 1, "the 5 tool traces are one session, not 5 runs and a session");
    assert.deepEqual(
      list.items.map((row) => row.id),
      ["mcp-s"],
    );
    assert.ok(
      Math.abs(aggregate.costUsd - 0.05) < 1e-9,
      `the summary cost has every call: ${aggregate.costUsd}`,
    );
    const row = list.items[0]!;
    assert.deepEqual(
      { turns: row.turns, tokens: row.tokens, cost: Math.round(row.costUsd * 1e6) / 1e6 },
      { turns: 1, tokens: 15, cost: 0.05 },
      "the row has every call's tokens and cost",
    );
  } finally {
    await client.close();
  }
});

test("an open (live) MCP session shows in the list as Active and counts in the summary", async () => {
  const { client, db } = await project();
  try {
    await mcpSession(client, db, {
      session: "mcp-old",
      run: 1,
      firstTrace: 1,
      calls: 2,
      at: 0,
      status: "closed",
    });
    await mcpSession(client, db, {
      session: "mcp-live",
      run: 2,
      firstTrace: 10,
      calls: 3,
      at: 3_590_000,
      status: "open",
    });
    const aggregate = await getSessionsAggregate(PROJECT_ID, WINDOW, db);
    const list = await listSessionList(PROJECT_ID, { filter: "all", now: NOW }, db);
    assert.deepEqual(
      list.items.map((row) => [row.id, row.status]),
      [
        ["mcp-live", "active"],
        ["mcp-old", "completed"],
      ],
    );
    assert.equal(aggregate.count, list.items.length, "the summary and the list agree");
    const paged = await listSessionList(PROJECT_ID, { filter: "all", limit: 1, now: NOW }, db);
    assert.deepEqual(
      paged.items.map((row) => row.id),
      ["mcp-live"],
    );
    const next = await listSessionList(
      PROJECT_ID,
      { filter: "all", limit: 1, cursor: paged.nextCursor, now: NOW },
      db,
    );
    assert.deepEqual(
      next.items.map((row) => row.id),
      ["mcp-old"],
      "the cursor walks from the open session to the closed one",
    );
  } finally {
    await client.close();
  }
});

test("turns with no session id are not sessions in the summary, as in the list", async () => {
  const { client, db } = await project();
  try {
    await insertOtelSpans(PROJECT_ID, [span(30, { at: 1_000 })], db);
    await client.exec(`
      insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at) values
        ('${turnId(30)}', '${PROJECT_ID}', '${traceId(30)}', 'otlp:${traceId(30)}', 'otlp', 'otlp', 'closed', '${iso(1_000)}', '${iso(1_100)}', '${iso(1_100)}');
    `);
    const aggregate = await getSessionsAggregate(PROJECT_ID, WINDOW, db);
    const list = await listSessionList(PROJECT_ID, { filter: "all", now: NOW }, db);
    assert.deepEqual(
      { summary: aggregate.count, list: list.items.length },
      { summary: 0, list: 0 },
    );
  } finally {
    await client.close();
  }
});

async function project(): Promise<{ client: Client; db: TestDb }> {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as TestDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'MCP', 'mcp');
  `);
  return { client, db };
}

/** `calls` root tool calls one second apart, one trace each, as one `otlp-run:` turn of `session`. */
async function mcpSession(
  client: Client,
  db: TestDb,
  {
    session,
    run,
    firstTrace,
    calls,
    at,
    status,
  }: {
    session: string;
    run: number;
    firstTrace: number;
    calls: number;
    at: number;
    status: "open" | "closed";
  },
): Promise<void> {
  const traces = Array.from({ length: calls }, (_, index) => firstTrace + index);
  const offset = (trace: number) => at + (trace - firstTrace) * 1_000;
  await insertOtelSpans(
    PROJECT_ID,
    traces.map((trace) => span(trace, { at: offset(trace), costUsd: "0.01" })),
    db,
  );
  const end = offset(traces.at(-1)!) + 100;
  await client.exec(`
    insert into trace_events (id, project_id, type, client_event_id, trace_id, occurred_at, payload) values
      ${traces.map((trace) => `('${eventId(trace)}', '${PROJECT_ID}', 'invoke_end', 'c${trace}', '${traceId(trace)}', '${iso(offset(trace))}', '{}')`).join(",\n      ")};
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at) values
      ('${turnId(run)}', '${PROJECT_ID}', '${session}', 'otlp-run:${eventId(firstTrace)}', 'otlp', 'otlp', '${status}', '${iso(at)}', '${iso(end)}', '${iso(end)}');
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at) values
      ${traces.map((trace, index) => `('${turnId(run)}', '${PROJECT_ID}', ${index + 1}, 'invoke', 'invoke_end', '${eventId(trace)}', '${iso(offset(trace))}', '${iso(offset(trace))}')`).join(",\n      ")};
    insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, spans_max_received_at) values
      ${traces.map((trace) => `('${PROJECT_ID}', '${traceId(trace)}', '${iso(offset(trace))}', 100, false, 2, 1, 0.01, '${iso(offset(trace))}')`).join(",\n      ")};
  `);
}

function turnId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

function eventId(n: number): string {
  return `44444444-4444-4444-8444-${n.toString().padStart(12, "0")}`;
}

function iso(offset: number): string {
  return new Date(T0 + offset).toISOString();
}

function traceId(n: number): string {
  return `a${n.toString(16).padStart(31, "0")}`;
}

function span(index: number, overrides: Partial<NewOtelSpan> & { at: number }): NewOtelSpan {
  const { at, ...rest } = overrides;
  return {
    id: `00000000-0000-8000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    traceId: traceId(index),
    spanId: index.toString(16).padStart(16, "0"),
    parentSpanId: null,
    name: "execute_tool list_traces",
    kind: 1,
    spanClass: "tool",
    startedAt: new Date(T0 + at),
    endedAt: new Date(T0 + at + 100),
    durationMs: 100,
    statusCode: 1,
    serviceName: "fixture-mcp",
    scopeName: "fixture",
    operationName: "execute_tool",
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
