import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadTurnTraceIds } from "./turn-traces";

/**
 * RC-314: the runs (traces) behind each turn of a session. An OTLP turn is
 * one run; a runtime-lane turn has the runs its steps' events carry, which
 * may be several. Only runs with spans in this project count.
 */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const TURN_OTLP = "33333333-3333-4333-8333-333333333331";
const TURN_RUNTIME = "33333333-3333-4333-8333-333333333332";
const TURN_EMPTY = "33333333-3333-4333-8333-333333333333";
const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);
const TRACE_C = "c".repeat(32);
const TRACE_GONE = "d".repeat(32);
const AT = "2026-11-02T09:00:00.000Z";

test("loadTurnTraceIds lists each turn's runs that have spans, in time order", async () => {
  const client = await createMigratedPGlite();
  try {
    const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
    const span = (project: string, trace: string, id: string, at: string) =>
      `(gen_random_uuid(), '${project}', '${trace}', '${id}', null, 'root', 1, 'other', '${at}', '${at}', 1, 1, '{}')`;
    const event = (id: number, trace: string | null) =>
      `('00000000-0000-4000-8000-${String(id).padStart(12, "0")}', '${PROJECT}', 'search', 'e${id}', ${trace ? `'${trace}'` : "null"}, '{}')`;
    const step = (turn: string, ordinal: number, eventId: number) =>
      `('${turn}', '${PROJECT}', ${ordinal}, 'search', 'search', '00000000-0000-4000-8000-${String(eventId).padStart(12, "0")}', '${AT}', '${AT}')`;
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'P', 'p'), ('${OTHER}', '${ORG}', 'O', 'o');
      insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes) values
        ${span(PROJECT, TRACE_A, "0000000000000001", AT)},
        ${span(PROJECT, TRACE_B, "0000000000000002", "2026-11-02T09:00:05.000Z")},
        ${span(PROJECT, TRACE_C, "0000000000000003", "2026-11-02T09:00:01.000Z")},
        ${span(OTHER, TRACE_GONE, "0000000000000004", AT)};
      insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at) values
        ('${TURN_OTLP}', '${PROJECT}', 's1', 'otlp:${TRACE_A}', 'otlp', 'otlp', 'closed', '${AT}', '${AT}', '${AT}'),
        ('${TURN_RUNTIME}', '${PROJECT}', 's1', 'declared:t2', 'declared', 'runtime', 'closed', '${AT}', '${AT}', '${AT}'),
        ('${TURN_EMPTY}', '${PROJECT}', 's1', 'declared:t3', 'declared', 'runtime', 'closed', '${AT}', '${AT}', '${AT}');
      insert into trace_events (id, project_id, type, client_event_id, trace_id, payload) values
        ${event(1, TRACE_B)}, ${event(2, TRACE_C)}, ${event(3, TRACE_B)}, ${event(4, null)}, ${event(5, TRACE_GONE)};
      insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at) values
        ${step(TURN_RUNTIME, 1, 1)}, ${step(TURN_RUNTIME, 2, 2)}, ${step(TURN_RUNTIME, 3, 3)},
        ${step(TURN_EMPTY, 1, 4)}, ${step(TURN_EMPTY, 2, 5)};
    `);
    const traces = await loadTurnTraceIds(PROJECT, [TURN_OTLP, TURN_RUNTIME, TURN_EMPTY], db);
    assert.deepEqual(traces.get(TURN_OTLP), [TRACE_A]);
    // Several runs, earliest first, each once.
    assert.deepEqual(traces.get(TURN_RUNTIME), [TRACE_C, TRACE_B]);
    // No trace id, or one whose spans are in another project: no trace.
    assert.deepEqual(traces.get(TURN_EMPTY), []);
    assert.equal(
      (await loadTurnTraceIds(OTHER, [TURN_OTLP], db)).get(TURN_OTLP)?.length,
      0,
      "another project's turn reads nothing",
    );
    assert.equal((await loadTurnTraceIds(PROJECT, [], db)).size, 0);
  } finally {
    await client.close();
  }
});
