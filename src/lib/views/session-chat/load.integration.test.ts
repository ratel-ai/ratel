import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadSessionChat } from "./load";

/** RC-281: the chat loader on the migrated schema (the same PGlite fixture as lib/session-replay). */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const TURN_1 = "33333333-3333-4333-8333-333333333331";
const TURN_2 = "33333333-3333-4333-8333-333333333332";
const SEARCH_EVENT = "44444444-4444-4444-8444-444444444441";
const INVOKE_EVENT = "44444444-4444-4444-8444-444444444442";
const CALL_1 = "55555555-5555-4555-8555-555555555551";
const CALL_2 = "55555555-5555-4555-8555-555555555552";
const OTHER_PROJECT_CALL = "55555555-5555-4555-8555-555555555559";
const LONG_ASK = `Book me a flight to Lisbon ${"please ".repeat(200)}`.trim();

type Db = ReturnType<typeof getDb>;

/** Session s1: turn 1 (a search, a failed tool call, two model calls with text), then turn 2 five minutes later. */
async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  const call1 = JSON.stringify({
    provider: "anthropic",
    model: "m",
    ts: "x",
    messages: [
      { role: "user", content: LONG_ASK },
      { role: "assistant", content: [{ type: "text", text: "Searching." }] },
    ],
    input_message_count: 1,
  });
  const call2 = JSON.stringify({
    provider: "anthropic",
    model: "m",
    ts: "x",
    messages: [
      { role: "user", content: LONG_ASK },
      { role: "assistant", content: [{ type: "text", text: "Found 3 flights." }] },
    ],
    input_message_count: 1,
    output: [{ role: "assistant", content: [{ type: "text", text: "Found 3 flights." }] }],
  });
  const other = JSON.stringify({
    provider: "anthropic",
    model: "m",
    ts: "x",
    messages: [{ role: "user", content: "OTHER" }],
  });
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, ended_by, started_at, ended_at, last_received_at, abandoned, re_search_count) values
      ('${TURN_1}', '${PROJECT}', 's1', 'declared:1', 'declared', 'runtime', 'closed', 'next_turn', '2026-10-20T10:00:00Z', '2026-10-20T10:00:05Z', '2026-10-20T10:00:05Z', false, 0),
      ('${TURN_2}', '${PROJECT}', 's1', 'declared:2', 'declared', 'runtime', 'closed', 'idle', '2026-10-20T10:05:00Z', '2026-10-20T10:05:02Z', '2026-10-20T10:05:02Z', false, 0);
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, search_type, hit_count, hit_ids, target_type, target_id, outcome, took_ms) values
      ('${TURN_1}', '${PROJECT}', 1, 'search', 'search', '${SEARCH_EVENT}', '2026-10-20T10:00:02Z', '2026-10-20T10:00:02Z', 'search', 2, '{search_flights,book}', null, null, null, 400),
      ('${TURN_1}', '${PROJECT}', 2, 'invoke', 'invoke_start', '${INVOKE_EVENT}', '2026-10-20T10:00:04Z', '2026-10-20T10:00:04Z', null, null, null, 'tool', 'search_flights', 'error', 600);
    insert into trace_events (id, project_id, type, client_event_id, trace_id, occurred_at, payload) values
      ('${SEARCH_EVENT}', '${PROJECT}', 'search', 'c1', 'tr1', '2026-10-20T10:00:02Z', '{}'),
      ('${INVOKE_EVENT}', '${PROJECT}', 'invoke_start', 'c2', 'tr1', '2026-10-20T10:00:04Z', '{}');
    insert into events (id, project_id, trace_id, occurred_at, model, finish_reason, input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms, payload) values
      ('${CALL_1}', '${PROJECT}', 'tr1', '2026-10-20T10:00:00.500Z', 'm', 'tool_use', 1200, 40, 0, 0.012, 1000, '${call1}'),
      ('${CALL_2}', '${PROJECT}', 'tr1', '2026-10-20T10:00:02.500Z', 'm', 'stop', 1500, 30, 1000, 0.008, 1500, '${call2}'),
      ('${OTHER_PROJECT_CALL}', '${OTHER_PROJECT}', 'tr1', '2026-10-20T10:00:03Z', 'm', 'stop', 9, 9, 0, 0.001, 1, '${other}');
    insert into event_metrics (event_id, project_id, event_time, tokens_by_category, splits, categorizer_version) values
      ('${CALL_1}', '${PROJECT}', '2026-10-20T10:00:00.500Z', '{"skills":0,"tools":200,"history":0,"memory":0,"user_input":1000}', '{"history_cached":0,"history_uncached":0,"tools_used":0,"tools_unused":200}', 1),
      ('${CALL_2}', '${PROJECT}', '2026-10-20T10:00:02.500Z', '{"skills":0,"tools":200,"history":300,"memory":0,"user_input":1000}', '{"history_cached":300,"history_uncached":0,"tools_used":200,"tools_unused":0}', 1);
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

test("opt-in on: full ask and reply text, work lines, a wait and the failed step", async () => {
  const { client, db } = await setup();
  try {
    const chat = await loadSessionChat(PROJECT, "s1", { readContent: true }, db);
    assert.ok(chat);
    assert.equal(chat.textOff, false);
    assert.deepEqual(
      chat.turns.map((t) => [t.turnIndex, t.ask, t.reply, t.work.label]),
      [
        [1, LONG_ASK, "Found 3 flights.", "2 actions · 5 s · 1 to check"],
        [2, null, null, "No actions · 2 s"],
      ],
    );
    assert.deepEqual(
      chat.problems.map((p) => p.kinds),
      [["failed"]],
    );
    const wait = chat.segments.find((s) => s.kind === "wait");
    assert.equal(wait?.label, "5 min later");
    const search = chat.segments.find((s) => s.kind === "search");
    assert.deepEqual([search?.realMs, search?.measured], [400, true]);
    assert.deepEqual(
      chat.calls.map((c) => [c.callNumber, c.eventId]),
      [
        [1, CALL_1],
        [2, CALL_2],
      ],
    );
    assert.ok(chat.splits);
    assert.deepEqual(
      Object.keys(chat.splits).map(Number).sort(),
      chat.calls.map((c) => c.stepIndex).sort(),
    );
  } finally {
    await client.close();
  }
});

test("RC-524: each model call's What-if fork target and the tool-choice verdicts by step", async () => {
  const { client, db } = await setup();
  try {
    const chat = await loadSessionChat(PROJECT, "s1", { readContent: false }, db);
    assert.ok(chat?.forks && chat.verdicts);
    assert.deepEqual(
      chat.calls.map((c) => chat.forks![c.stepIndex]),
      [
        { turnId: TURN_1, call: 0 },
        { turnId: TURN_1, call: 1 },
      ],
    );
    const invoke = chat.segments.find((s) => s.kind === "tool_call")!;
    const verdicts = Object.entries(chat.verdicts).flatMap(([step, chips]) =>
      chips.map((chip) => [Number(step), chip.tone, chip.text]),
    );
    assert.deepEqual(verdicts, [
      [
        invoke.stepIndex,
        "good",
        `At step ${invoke.stepIndex} the agent picked search_flights, the top search result.`,
      ],
      [invoke.stepIndex, "bad", `At step ${invoke.stepIndex} the call to search_flights failed.`],
    ]);
  } finally {
    await client.close();
  }
});

test("opt-in off: the same shape with no words", async () => {
  const { client, db } = await setup();
  try {
    const chat = await loadSessionChat(PROJECT, "s1", { readContent: false }, db);
    assert.ok(chat);
    assert.equal(chat.textOff, true);
    assert.deepEqual(
      chat.turns.map((t) => [t.ask, t.reply, t.work.label]),
      [
        [null, null, "2 actions · 5 s · 1 to check"],
        [null, null, "No actions · 2 s"],
      ],
    );
    assert.equal(JSON.stringify(chat).includes("Lisbon"), false);
  } finally {
    await client.close();
  }
});

test("a session with no closed turn in the project is null", async () => {
  const { client, db } = await setup();
  try {
    assert.equal(await loadSessionChat(OTHER_PROJECT, "s1", { readContent: true }, db), null);
  } finally {
    await client.close();
  }
});

const CODE_EVENT = "44444444-4444-4444-8444-444444444443";
const MESSAGE_EVENT = "44444444-4444-4444-8444-444444444444";

/** Turn 2 gets a user message and a code step; one task runs from turn 1 into turn 2, a second one inside turn 2. */
async function typedSetup() {
  const fixture = await setup();
  await fixture.client.exec(`
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_id, outcome, took_ms) values
      ('${TURN_2}', '${PROJECT}', 1, 'user_message', 'otlp_model_call', '${MESSAGE_EVENT}', '2026-10-20T10:05:00.100Z', '2026-10-20T10:05:00.100Z', null, null, null),
      ('${TURN_2}', '${PROJECT}', 2, 'code', 'otlp_step', '${CODE_EVENT}', '2026-10-20T10:05:01Z', '2026-10-20T10:05:01Z', 'load_cart', 'ok', 300);
    insert into task_segments (id, project_id, session_id, workflow_id, start_turn_id, start_ordinal, end_turn_id, end_ordinal, started_at, ended_at, turn_ids, piece_count) values
      ('66666666-6666-4666-8666-666666666661', '${PROJECT}', 's1', 'booking', '${TURN_1}', 1, '${TURN_2}', 1, '2026-10-20T10:00:00Z', '2026-10-20T10:05:00.100Z', '{${TURN_1},${TURN_2}}', 2),
      ('66666666-6666-4666-8666-666666666662', '${PROJECT}', 's1', 'carts', '${TURN_2}', 2, '${TURN_2}', 2, '2026-10-20T10:05:01Z', '2026-10-20T10:05:02Z', '{${TURN_2}}', 1);
    insert into trace_workflow_labels (project_id, workflow_id, input_hash, name) values ('${PROJECT}', 'booking', 'h', 'Book a flight');
    insert into trace_topics (project_id, topic_id, name, input_hash) values ('${PROJECT}', 'tp1', 'Flight changes', 'h');
    insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, sentiment, started_at) values ('${TURN_2}', '${PROJECT}', 'tp1', 'topic', 'negative', '2026-10-20T10:05:00Z');
  `);
  return fixture;
}

test("user messages and code are steps, task bands cross turns, and each turn says its intent", async () => {
  const { client, db } = await typedSetup();
  try {
    const chat = await loadSessionChat(PROJECT, "s1", { readContent: false }, db);
    assert.ok(chat);
    assert.deepEqual(
      chat.segments
        .filter((s) => s.kind === "user_message" || s.kind === "code")
        .map((s) => [s.kind, s.label]),
      [
        ["user_message", "User message"],
        ["code", "Load cart"],
      ],
    );
    assert.deepEqual(
      chat.bands?.map((band) => [band.workflowId, band.label]),
      [
        ["booking", "Book a flight"],
        ["carts", "Task"],
      ],
    );
    const stepOf = (kind: string) => chat.segments.find((s) => s.kind === kind)?.stepIndex;
    const booking = chat.bands?.[0];
    assert.ok(booking);
    assert.deepEqual(
      [booking.firstStep, booking.lastStep],
      [stepOf("search"), stepOf("user_message")],
    );
    assert.deepEqual(chat.intents, { 2: { topic: "Flight changes", sentiment: "negative" } });
  } finally {
    await client.close();
  }
});
