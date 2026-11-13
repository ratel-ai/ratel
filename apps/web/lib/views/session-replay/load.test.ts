import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadSessionTimeline } from "./load";

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const TURN_1 = "33333333-3333-4333-8333-333333333331";
const TURN_2 = "33333333-3333-4333-8333-333333333332";
const OTHER_TURN = "33333333-3333-4333-8333-333333333339";
const SEARCH_EVENT = "44444444-4444-4444-8444-444444444441";
const INVOKE_EVENT = "44444444-4444-4444-8444-444444444442";
const PRUNED_EVENT = "44444444-4444-4444-8444-444444444443";
const CALL_WITH_TEXT = "55555555-5555-4555-8555-555555555551";
const CALL_COUNTS_ONLY = "55555555-5555-4555-8555-555555555552";
const OTHER_PROJECT_CALL = "55555555-5555-4555-8555-555555555559";
const SECRET = "SECRET-PROMPT-TEXT";

type Db = ReturnType<typeof getDb>;

/**
 * Project A's session s1: turn 1 (a search and a tool call, still in
 * `trace_events`, with two model calls: one with text, one with counts only)
 * and turn 2 (its source event pruned). Project B has a turn in a session of
 * the same id and a model call on the same trace id.
 */
async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  const withText = JSON.stringify({
    provider: "anthropic",
    model: "m",
    ts: "x",
    system: SECRET,
    messages: [{ role: "user", content: SECRET }],
  });
  const countsOnly = JSON.stringify({
    provider: "anthropic",
    model: "m",
    ts: "x",
    messages: [
      { role: "user", content: "" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ],
  });
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, ended_by, started_at, ended_at, last_received_at, abandoned, re_search_count) values
      ('${TURN_1}', '${PROJECT}', 's1', 'declared:1', 'declared', 'runtime', 'closed', 'next_turn', '2026-10-20T10:00:00Z', '2026-10-20T10:00:05Z', '2026-10-20T10:00:05Z', false, 0),
      ('${TURN_2}', '${PROJECT}', 's1', 'declared:2', 'declared', 'runtime', 'closed', 'idle', '2026-10-20T10:05:00Z', '2026-10-20T10:05:05Z', '2026-10-20T10:05:05Z', true, 0),
      ('${OTHER_TURN}', '${OTHER_PROJECT}', 's1', 'declared:1', 'declared', 'runtime', 'closed', 'idle', '2026-10-20T10:00:00Z', '2026-10-20T10:00:05Z', '2026-10-20T10:00:05Z', false, 0);
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, search_type, hit_count, hit_ids, target_type, target_id, outcome) values
      ('${TURN_1}', '${PROJECT}', 1, 'search', 'search', '${SEARCH_EVENT}', '2026-10-20T10:00:02Z', '2026-10-20T10:00:02Z', 'search', 2, '{get_trace,search_docs}', null, null, null),
      ('${TURN_1}', '${PROJECT}', 2, 'invoke', 'invoke_start', '${INVOKE_EVENT}', '2026-10-20T10:00:04Z', '2026-10-20T10:00:04Z', null, null, null, 'tool', 'get_trace', 'ok'),
      ('${TURN_2}', '${PROJECT}', 1, 'invoke', 'invoke_start', '${PRUNED_EVENT}', '2026-10-20T10:05:01Z', '2026-10-20T10:05:01Z', null, null, null, 'tool', 'get_trace', 'error'),
      ('${OTHER_TURN}', '${OTHER_PROJECT}', 1, 'invoke', 'invoke_start', '${INVOKE_EVENT}', '2026-10-20T10:00:04Z', '2026-10-20T10:00:04Z', null, null, null, 'tool', 'other_tool', 'ok');
    insert into trace_events (id, project_id, type, client_event_id, trace_id, occurred_at, query, payload) values
      ('${SEARCH_EVENT}', '${PROJECT}', 'search', 'c1', 'tr1', '2026-10-20T10:00:02Z', '${SECRET}', '{}'),
      ('${INVOKE_EVENT}', '${PROJECT}', 'invoke_start', 'c2', 'tr1', '2026-10-20T10:00:04Z', null, '{}');
    insert into events (id, project_id, trace_id, occurred_at, model, finish_reason, input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms, payload) values
      ('${CALL_WITH_TEXT}', '${PROJECT}', 'tr1', '2026-10-20T10:00:01Z', 'm', 'tool_use', 1200, 40, 0, 0.012, 800, '${withText}'),
      ('${CALL_COUNTS_ONLY}', '${PROJECT}', 'tr1', '2026-10-20T10:00:03Z', 'm', 'tool_use', 1500, 30, 1000, 0.008, 700, '${countsOnly}'),
      ('${OTHER_PROJECT_CALL}', '${OTHER_PROJECT}', 'tr1', '2026-10-20T10:00:03Z', 'm', 'stop', 9, 9, 0, 0.001, 1, '${withText}');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

test("a full session: turns, model calls, searches and tool calls in order, with coverage per step", async () => {
  const { client, db } = await setup();
  try {
    const timeline = await loadSessionTimeline(PROJECT, "s1", db);
    assert.ok(timeline);
    assert.deepEqual(
      timeline.steps.map((step) => [step.index, step.kind, step.coverage, step.marks]),
      [
        [1, "turn", "content", []],
        [2, "model_call", "content", []],
        [3, "search", "content", []],
        [4, "model_call", "tokens_only", []],
        [5, "tool_call", "tokens_only", []],
        [6, "turn", "expired", ["abandoned"]],
        [7, "tool_call", "expired", []],
      ],
    );
    const calls = timeline.steps.filter((step) => step.kind === "model_call");
    assert.deepEqual(
      calls.map((step) => [step.eventId, step.inputTokens, step.costUsd]),
      [
        [CALL_WITH_TEXT, 1200, 0.012],
        [CALL_COUNTS_ONLY, 1500, 0.008],
      ],
    );
    assert.deepEqual(timeline.coverage, { content: 3, tokens_only: 2, expired: 2 });
  } finally {
    await client.close();
  }
});

test("no prompt, message or query text is returned", async () => {
  const { client, db } = await setup();
  try {
    const timeline = await loadSessionTimeline(PROJECT, "s1", db);
    assert.ok(!JSON.stringify(timeline).includes(SECRET));
  } finally {
    await client.close();
  }
});

test("another project's session of the same id stays out, and so do its model calls", async () => {
  const { client, db } = await setup();
  try {
    const timeline = await loadSessionTimeline(OTHER_PROJECT, "s1", db);
    assert.ok(timeline);
    assert.deepEqual(
      timeline.steps.map((step) => [step.kind, step.turnId]),
      [
        ["turn", OTHER_TURN],
        ["tool_call", OTHER_TURN],
      ],
    );
    // Its step points at project A's event id: that row is not B's, so it reads as pruned and joins no call.
    assert.deepEqual(timeline.coverage, { content: 0, tokens_only: 0, expired: 2 });
    assert.equal(await loadSessionTimeline(PROJECT, "no-such-session", db), null);
  } finally {
    await client.close();
  }
});
