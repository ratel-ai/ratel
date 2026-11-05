import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadSessionLens } from "./annotations-load";
import { loadSessionTimeline } from "./load";

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TURN = "33333333-3333-4333-8333-333333333331";
const SEARCH_EVENT = "44444444-4444-4444-8444-444444444441";
const INVOKE_EVENT = "44444444-4444-4444-8444-444444444442";
const CALL_1 = "55555555-5555-4555-8555-555555555551";
const CALL_2 = "55555555-5555-4555-8555-555555555552";
const SECRET_QUERY = "Find The Trace for order 4711";
const SECRET_PROMPT = "SECRET-SYSTEM-PROMPT";

type Db = ReturnType<typeof getDb>;

/**
 * One turn: call 1 (content captured: a system prompt with a skills block and
 * a tool result), a search listing get_trace above search_docs, call 2
 * (loading search_docs and never_used, not get_trace), then search_docs runs.
 * The query is labelled get_trace, and calibration recorded a mismatch on it.
 */
async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  const payload = JSON.stringify({
    provider: "anthropic",
    model: "m",
    ts: "x",
    system: `${SECRET_PROMPT} base instructions. <skills>skill a, skill b</skills>`,
    messages: [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "search_docs", arguments: {} }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: "a long tool result that fills the history with characters",
      },
      { role: "user", content: "next" },
    ],
  });
  const metrics = (history: number) =>
    `'{"skills":200,"tools":80,"history":${history},"memory":0,"user_input":20}', '{"tools_used":0,"tools_unused":80,"history_cached":0,"history_uncached":${history}}', '{"search_docs":{"calls":0,"tokens":50},"never_used":{"calls":0,"tokens":30}}'`;
  await client.exec(`
    insert into organizations (id, name, slug, plan) values ('${ORG}', 'Org', 'org', 'pro');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, ended_by, started_at, ended_at, last_received_at, abandoned) values
      ('${TURN}', '${PROJECT}', 's1', 'declared:1', 'declared', 'runtime', 'closed', 'next_turn', '2026-10-20T10:00:00Z', '2026-10-20T10:00:05Z', '2026-10-20T10:00:05Z', false);
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, search_type, hit_count, hit_ids, target_type, target_id, outcome) values
      ('${TURN}', '${PROJECT}', 1, 'search', 'search', '${SEARCH_EVENT}', '2026-10-20T10:00:02Z', '2026-10-20T10:00:02Z', 'search', 2, '{get_trace,search_docs}', null, null, null),
      ('${TURN}', '${PROJECT}', 2, 'invoke', 'invoke_start', '${INVOKE_EVENT}', '2026-10-20T10:00:04Z', '2026-10-20T10:00:04Z', null, null, null, 'tool', 'search_docs', 'ok');
    insert into trace_events (id, project_id, type, client_event_id, trace_id, occurred_at, query, payload) values
      ('${SEARCH_EVENT}', '${PROJECT}', 'search', 'c1', 'tr1', '2026-10-20T10:00:02Z', '${SECRET_QUERY}', '{}'),
      ('${INVOKE_EVENT}', '${PROJECT}', 'invoke_start', 'c2', 'tr1', '2026-10-20T10:00:04Z', null, '{}');
    insert into events (id, project_id, trace_id, occurred_at, model, input_tokens, payload) values
      ('${CALL_1}', '${PROJECT}', 'tr1', '2026-10-20T10:00:01Z', 'm', 400, '${payload}'),
      ('${CALL_2}', '${PROJECT}', 'tr1', '2026-10-20T10:00:03Z', 'm', 900, '{"provider":"anthropic","model":"m","ts":"x","messages":[]}');
    insert into event_metrics (event_id, project_id, event_time, input_tokens, categorizer_version, tokens_by_category, splits, tools_by_name) values
      ('${CALL_1}', '${PROJECT}', '2026-10-20T10:00:01Z', 400, 4, ${metrics(100)}),
      ('${CALL_2}', '${PROJECT}', '2026-10-20T10:00:03Z', 900, 4, ${metrics(600)});
    insert into match_quality_labels (project_id, query_key, query, entry_id, source, observed_at) values
      ('${PROJECT}', 'find the trace for order 4711', '${SECRET_QUERY}', 'get_trace', 'judge', '2026-10-20T10:00:00Z');
    insert into otel_logs (id, project_id, occurred_at, event_name, trace_id, experiment_selection_id, experiment_attrs, attributes) values
      ('66666666-6666-4666-8666-666666666661', '${PROJECT}', '2026-10-20T10:00:02Z', 'ratel.experiment.comparison', 'tr1', 'sel-1', '{"ratel.experiment.agreement.exact_order": false}', '{}'),
      ('66666666-6666-4666-8666-666666666662', '${PROJECT}', '2026-10-20T10:00:02Z', 'ratel.experiment.comparison', 'tr1', 'sel-2', '{"ratel.experiment.agreement.exact_order": true}', '{}');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

async function lensOf(db: Db) {
  const timeline = await loadSessionTimeline(PROJECT, "s1", db);
  assert.ok(timeline);
  return loadSessionLens(PROJECT, timeline, db);
}

test("each model call gets a composition summing to its input tokens; sizes split the prompt and the tool results", async () => {
  const { client, db } = await setup();
  try {
    const lens = await lensOf(db);
    assert.deepEqual(
      lens.calls.map((call) => [call.step, call.composition.eventId]),
      [
        [2, CALL_1],
        [4, CALL_2],
      ],
    );
    const first = lens.calls[0]!.composition;
    assert.equal(
      Object.values(first.parts).reduce((a, b) => a + b, 0),
      400,
    );
    assert.ok(first.parts.system > 0 && first.parts.skills > 0, "base prompt split from skills");
    assert.ok(first.parts.tool_results > 0, "tool results split from history");
    assert.deepEqual(first.gaps, []);
    // Call 2 carried no text: its prompt stays in skills and its tool results in history.
    assert.deepEqual(lens.calls[1]!.composition.gaps, [
      "system_in_skills",
      "tool_results_in_history",
    ]);
    assert.deepEqual(lens.gaps, ["no_window_size"]);
  } finally {
    await client.close();
  }
});

test("markers: tools never used, the tool needed but not loaded, and the bloat start", async () => {
  const { client, db } = await setup();
  try {
    const lens = await lensOf(db);
    assert.deepEqual(lens.unusedTools, [
      { step: 2, tools: ["never_used"] },
      { step: 4, tools: ["never_used"] },
    ]);
    assert.deepEqual(lens.missingTools, [{ step: 4, tools: ["get_trace"] }]);
    assert.equal(lens.bloatStartStep, 4);
  } finally {
    await client.close();
  }
});

test("annotations: a higher-scored tool not loaded, the label naming it, and the calibration mismatch", async () => {
  const { client, db } = await setup();
  try {
    const lens = await lensOf(db);
    assert.deepEqual(
      lens.annotations.map((a) => [a.step, a.reason, a.picked, a.better, a.selectionId]),
      [
        [3, "calibration_mismatch", null, null, "sel-1"],
        [5, "scored_higher_not_loaded", "search_docs", "get_trace", null],
        [5, "label_disagrees", "search_docs", "get_trace", null],
      ],
    );
  } finally {
    await client.close();
  }
});

test("no query or prompt text is returned", async () => {
  const { client, db } = await setup();
  try {
    const json = JSON.stringify(await lensOf(db)).toLowerCase();
    assert.ok(!json.includes("find the trace"));
    assert.ok(!json.includes(SECRET_PROMPT.toLowerCase()));
  } finally {
    await client.close();
  }
});
