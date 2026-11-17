import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadTraceSession } from "./trace-session";

/**
 * RC-472: a turn's trace knows its session, so the trace page links to the
 * full session and shows the session's turns on top, each to its own trace.
 */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const TURN_1 = "33333333-3333-4333-8333-333333333331";
const TURN_2 = "33333333-3333-4333-8333-333333333332";
const SEARCH_EVENT = "44444444-4444-4444-8444-444444444441";
const CALL_1 = "55555555-5555-4555-8555-555555555551";
const TRACE_RUNTIME = "a".repeat(32);
const TRACE_OTLP = "b".repeat(32);
const TRACE_LONE = "c".repeat(32);

type Db = ReturnType<typeof getDb>;

/** Session s1: turn 1 on the runtime lane (trace a…, ask with text), turn 2 an OTLP turn (trace b…). Trace c… has no turn. */
async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  const call = JSON.stringify({
    provider: "anthropic",
    model: "m",
    ts: "x",
    messages: [{ role: "user", content: "Book a flight to Lisbon" }],
    input_message_count: 1,
  });
  const span = (trace: string, id: string, at: string) =>
    `(gen_random_uuid(), '${PROJECT}', '${trace}', '${id}', null, 'root', 1, 'other', '${at}', '${at}', 1, 1, '{}')`;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, ended_by, started_at, ended_at, last_received_at, abandoned, re_search_count) values
      ('${TURN_1}', '${PROJECT}', 's1', 'declared:1', 'declared', 'runtime', 'closed', 'next_turn', '2026-10-20T10:00:00Z', '2026-10-20T10:00:05Z', '2026-10-20T10:00:05Z', false, 0),
      ('${TURN_2}', '${PROJECT}', 's1', 'otlp:${TRACE_OTLP}', 'otlp', 'otlp', 'closed', 'idle', '2026-10-20T10:05:00Z', '2026-10-20T10:05:02Z', '2026-10-20T10:05:02Z', false, 0);
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, search_type, hit_count, hit_ids, took_ms) values
      ('${TURN_1}', '${PROJECT}', 1, 'search', 'search', '${SEARCH_EVENT}', '2026-10-20T10:00:02Z', '2026-10-20T10:00:02Z', 'search', 1, '{search_flights}', 400);
    insert into trace_events (id, project_id, type, client_event_id, trace_id, occurred_at, payload) values
      ('${SEARCH_EVENT}', '${PROJECT}', 'search', 'c1', '${TRACE_RUNTIME}', '2026-10-20T10:00:02Z', '{}');
    insert into events (id, project_id, trace_id, occurred_at, model, finish_reason, input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms, payload) values
      ('${CALL_1}', '${PROJECT}', '${TRACE_RUNTIME}', '2026-10-20T10:00:00.500Z', 'm', 'stop', 100, 10, 0, 0.001, 100, '${call}');
    insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes) values
      ${span(TRACE_RUNTIME, "0000000000000001", "2026-10-20T10:00:00Z")},
      ${span(TRACE_OTLP, "0000000000000002", "2026-10-20T10:05:00Z")},
      ${span(TRACE_LONE, "0000000000000003", "2026-10-20T11:00:00Z")};
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

test("a runtime-lane turn's trace reads its session: the first ask as title, every turn with its trace", async () => {
  const { client, db } = await setup();
  try {
    const session = await loadTraceSession(PROJECT, TRACE_RUNTIME, { readContent: true }, db);
    assert.deepEqual(session, {
      sessionId: "s1",
      title: "Book a flight to Lisbon",
      turnIndex: 1,
      turns: [
        { turnIndex: 1, ask: "Book a flight to Lisbon", traceId: TRACE_RUNTIME },
        { turnIndex: 2, ask: null, traceId: TRACE_OTLP },
      ],
    });
  } finally {
    await client.close();
  }
});

test("an OTLP turn's trace reads its session at its own turn; with content off there is no ask", async () => {
  const { client, db } = await setup();
  try {
    const session = await loadTraceSession(PROJECT, TRACE_OTLP, { readContent: false }, db);
    assert.equal(session?.sessionId, "s1");
    assert.equal(session?.turnIndex, 2);
    assert.deepEqual(
      session?.turns.map((turn) => turn.ask),
      [null, null],
    );
    assert.equal(session?.title, "Untitled session · s1");
  } finally {
    await client.close();
  }
});

test("a trace with no turn, or in another project, has no session", async () => {
  const { client, db } = await setup();
  try {
    assert.equal(await loadTraceSession(PROJECT, TRACE_LONE, { readContent: true }, db), null);
    assert.equal(
      await loadTraceSession(OTHER_PROJECT, TRACE_RUNTIME, { readContent: true }, db),
      null,
    );
  } finally {
    await client.close();
  }
});
