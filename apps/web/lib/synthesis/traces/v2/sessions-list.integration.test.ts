import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { SessionsDb } from "@/lib/synthesis/traces-sessions/sessions";
import { listSessionList, type SessionListRow, sessionListPageQuery } from "./sessions-list";

/**
 * RC-502 (decisions sessions-first, session-status): the Sessions tab lists
 * sessions only. Seeded, newest last update first:
 * session-live (ended 1 min before now: Active), trace 5 alone (no session id:
 * not listed), session-a (two OTLP turns, the second failed: Failed),
 * session-b (runtime lane, clean: Completed). Another project's session is
 * newer than all of them and never shows.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const NOW = new Date(T0 + 600_000);

type TestDb = SessionsDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("a single-turn trace without a session id is not listed; sessions come newest last update first", async () => {
  const { client, db } = await seeded();
  try {
    const { items, nextCursor } = await listSessionList(
      PROJECT_ID,
      { filter: "all", now: NOW },
      db,
    );
    assert.deepEqual(
      items.map((row) => row.id),
      ["session-live", "session-a", "session-b"],
    );
    assert.equal(nextCursor, null);
  } finally {
    await client.close();
  }
});

test("status is Active within 5 minutes of the last activity, else Failed when a turn failed, else Completed", async () => {
  const { client, db } = await seeded();
  try {
    const { items } = await listSessionList(PROJECT_ID, { filter: "all", now: NOW }, db);
    assert.deepEqual(
      items.map((row) => [row.id, row.status]),
      [
        ["session-live", "active"],
        ["session-a", "failed"],
        ["session-b", "completed"],
      ],
    );
    // Later, the live session has gone quiet.
    const later = await listSessionList(
      PROJECT_ID,
      { filter: "all", now: new Date(NOW.getTime() + 10 * 60_000) },
      db,
    );
    assert.equal(later.items[0]?.status, "completed");
  } finally {
    await client.close();
  }
});

test("each row carries its first message, last turn, turns, duration, times, tokens and cost from the rollup", async () => {
  const { client, db } = await seeded();
  try {
    const { items } = await listSessionList(PROJECT_ID, { filter: "all", now: NOW }, db);
    const a = items.find((row) => row.id === "session-a");
    assert.deepEqual(a && pick(a), {
      firstMessage: "Where is order 1234?",
      lastTurn: "Refund it",
      turns: 2,
      startedAt: iso(0),
      lastActivityAt: iso(10_100),
      durationMs: 10_100,
      tokens: 45,
      costUsd: 0.03,
      traceIds: [traceId(1), traceId(2)],
      href: `/project/${PROJECT_ID}/sessions/session-a`,
    });
    // A runtime-lane turn reaches its trace through its steps' events.
    const b = items.find((row) => row.id === "session-b");
    assert.deepEqual(b && [b.firstMessage, b.lastTurn, b.turns, b.tokens, b.traceIds], [
      "Cancel my order",
      "Cancel my order",
      1,
      7,
      [traceId(6)],
    ]);
  } finally {
    await client.close();
  }
});

test("pages by last update with a cursor, and Failed keeps only failed sessions", async () => {
  const { client, db } = await seeded();
  try {
    const first = await listSessionList(PROJECT_ID, { filter: "all", limit: 2, now: NOW }, db);
    assert.deepEqual(
      first.items.map((row) => row.id),
      ["session-live", "session-a"],
    );
    assert.ok(first.nextCursor);
    const second = await listSessionList(
      PROJECT_ID,
      { filter: "all", limit: 2, cursor: first.nextCursor, now: NOW },
      db,
    );
    assert.deepEqual(
      second.items.map((row) => row.id),
      ["session-b"],
    );
    assert.equal(second.nextCursor, null);
    const failed = await listSessionList(PROJECT_ID, { filter: "failed", now: NOW }, db);
    assert.deepEqual(
      failed.items.map((row) => row.id),
      ["session-a"],
    );
  } finally {
    await client.close();
  }
});

test("the Failed filter finds the failed sessions once per page, not once per walked turn", () => {
  const text = JSON.stringify(sessionListPageQuery(PROJECT_ID, "failed", null, 51));
  assert.match(text, /with failed_sessions as/);
  assert.match(text, /t\.session_id in \(select session_id from failed_sessions\)/);
  assert.doesNotMatch(text, /f\.session_id = t\.session_id/);
});

test("the page query reads only the turn ledger and the trace rollup", () => {
  const text = JSON.stringify(
    sessionListPageQuery(PROJECT_ID, "failed", { at: iso(0).replace("Z", "000Z"), id: "x" }, 51),
  );
  assert.match(text, /trace_turns/);
  assert.match(text, /otel_trace_summaries/);
  assert.doesNotMatch(text, /otel_spans|\bevents\b/);
});

function pick(row: SessionListRow) {
  const {
    firstMessage,
    lastTurn,
    turns,
    startedAt,
    lastActivityAt,
    durationMs,
    tokens,
    costUsd,
    traceIds,
    href,
  } = row;
  return {
    firstMessage,
    lastTurn,
    turns,
    startedAt,
    lastActivityAt,
    durationMs,
    tokens,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    traceIds,
    href,
  };
}

async function seeded(): Promise<{
  client: Awaited<ReturnType<typeof createMigratedPGlite>>;
  db: TestDb;
}> {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as TestDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  const ask = (content: string) => ({
    "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content }] }]),
  });
  await insertOtelSpans(
    PROJECT_ID,
    [
      span(10, { traceId: traceId(1), at: T0 }),
      span(11, {
        traceId: traceId(1),
        parentSpanId: spanId(10),
        spanClass: "llm_call",
        name: "chat",
        at: T0 + 1,
        attributes: ask("Where is order 1234?"),
      }),
      span(20, { traceId: traceId(2), at: T0 + 10_000 }),
      span(21, {
        traceId: traceId(2),
        parentSpanId: spanId(20),
        spanClass: "llm_call",
        name: "chat",
        at: T0 + 10_001,
        attributes: ask("Refund it"),
      }),
      span(60, { traceId: traceId(6), at: T0 + 4_000 }),
      span(61, {
        traceId: traceId(6),
        parentSpanId: spanId(60),
        spanClass: "llm_call",
        name: "chat",
        at: T0 + 4_001,
        attributes: ask("Cancel my order"),
      }),
    ],
    db,
  );
  const turn = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
  const row = (
    id: number,
    project: string,
    session: string,
    key: string,
    status: string,
    start: number,
    end: number,
    errors = 0,
  ) =>
    `('${turn(id)}', '${project}', '${session}', '${key}', '${key.startsWith("otlp:") ? "otlp" : "declared"}', '${key.startsWith("otlp:") ? "otlp" : "runtime"}', '${status}', '${iso(start)}', '${iso(end)}', '${iso(end)}', ${errors})`;
  const summary = (
    project: string,
    trace: string,
    start: number,
    error: boolean,
    input: number,
    output: number,
    cost: string,
  ) =>
    `('${project}', '${trace}', '${iso(start)}', 100, ${error}, ${input}, ${output}, ${cost}, '${iso(start)}')`;
  await client.exec(`
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, error_count) values
      ${[
        row(1, PROJECT_ID, "session-a", `otlp:${traceId(1)}`, "closed", 0, 100),
        row(2, PROJECT_ID, "session-a", `otlp:${traceId(2)}`, "closed", 10_000, 10_100),
        row(3, PROJECT_ID, "session-b", "declared:b1", "closed", 4_000, 5_000),
        row(4, PROJECT_ID, "session-live", `otlp:${traceId(3)}`, "closed", 500_000, 540_000),
        // Trace 5 came with no session id: ingest keys its turn by the trace id.
        row(5, PROJECT_ID, traceId(5), `otlp:${traceId(5)}`, "closed", 30_000, 30_500),
        row(9, OTHER_PROJECT_ID, "session-x", `otlp:${traceId(1)}`, "closed", 40_000, 590_000),
      ].join(",\n      ")};
    insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, spans_max_received_at) values
      ${[
        summary(PROJECT_ID, traceId(1), 0, false, 10, 5, "0.01"),
        summary(PROJECT_ID, traceId(2), 10_000, true, 20, 10, "0.02"),
        summary(PROJECT_ID, traceId(3), 500_000, false, 1, 1, "0.001"),
        summary(PROJECT_ID, traceId(5), 30_000, true, 1, 1, "0.001"),
        summary(PROJECT_ID, traceId(6), 4_000, false, 5, 2, "0.002"),
        summary(OTHER_PROJECT_ID, traceId(1), 40_000, true, 9, 9, "9"),
      ].join(",\n      ")};
    insert into trace_events (id, project_id, type, client_event_id, trace_id, occurred_at, payload) values
      ('44444444-4444-4444-8444-444444444441', '${PROJECT_ID}', 'search', 'c1', '${traceId(6)}', '${iso(4_100)}', '{}');
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at) values
      ('${turn(3)}', '${PROJECT_ID}', 1, 'search', 'search', '44444444-4444-4444-8444-444444444441', '${iso(4_100)}', '${iso(4_100)}');
  `);
  return { client, db };
}

function iso(offset: number): string {
  return new Date(T0 + offset).toISOString();
}

function traceId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function spanId(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function span(index: number, overrides: Partial<NewOtelSpan> & { at: number }): NewOtelSpan {
  const { at, ...rest } = overrides;
  return {
    id: `00000000-0000-8000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    traceId: traceId(index),
    spanId: spanId(index),
    parentSpanId: null,
    name: "invoke_agent support-agent",
    kind: 1,
    spanClass: "other",
    startedAt: new Date(at),
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
