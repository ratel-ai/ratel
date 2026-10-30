import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { TurnFixture } from "@/lib/ledger/test-support";
import type { Namer } from "@/lib/readings/topics/evolve";
import { type AssignTopicsDeps, assignProjectTopics } from "@/lib/readings/topics/job";
import {
  enqueueAssignTopicsJob,
  loadHelperTools,
  loadModelOnlyTraces,
  loadPreviousPlacements,
  loadRefusedTraces,
  loadSelfCorrectionKinds,
  loadStoredTopics,
  loadTaskRuns,
  loadTopicReading,
  loadTurnTasks,
  readingStart,
  saveTopicReading,
  topicReadingInFlight,
} from "@/lib/readings/topics/queries";
import {
  type Db,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { loadVerdicts, saveVerdicts } from "@/lib/readings/trace-signals/workflows/decide-queries";
import { loadAskSourcesByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * One topic reading end to end against the real schema (migration 0067):
 * asks read from turn scopes' user messages, grouped into topics named from
 * their own words, a repeated ask read as a retry, sentiment from the users'
 * words, every turn's place written, and the same ids kept by the next
 * reading when a model renames the topics.
 */

const START = Date.parse("2026-09-01T09:00:00Z");
const NOW = new Date("2026-09-10T12:00:00Z");
const MINUTE = 60_000;

interface Spec {
  session: string;
  user: string;
  at: number;
  message: string;
  tool: string;
  fails?: boolean;
}

function specs(): Spec[] {
  const out: Spec[] = [];
  const delivery = [
    "check delivery status of PO 12",
    "check the delivery status of the switchgear",
    "check delivery status for rebar",
  ];
  const inspection = [
    "book a site inspection for friday",
    "book an inspection with the city",
    "book a site inspection for monday",
  ];
  for (let i = 0; i < 6; i += 1) {
    const at = START + i * 60 * MINUTE;
    out.push({
      session: `s${i}`,
      user: `u${i}`,
      at,
      message: delivery[i % 3]!,
      tool: "track_delivery",
      fails: i === 0,
    });
    out.push({
      session: `s${i}`,
      user: `u${i}`,
      at: at + 3 * MINUTE,
      message: inspection[i % 3]!,
      tool: "book_inspection",
    });
  }
  // Asked again right after, in the user's own words, and thanks.
  out.push({
    session: "s0",
    user: "u0",
    at: START + 6 * MINUTE,
    message: "Book a site inspection for Friday",
    tool: "book_inspection",
  });
  out.push({
    session: "s1",
    user: "u1",
    at: START + 60 * MINUTE + 6 * MINUTE,
    message: "thanks, that's perfect",
    tool: "noop",
  });
  return out;
}

async function seed(): Promise<{ client: PGlite; db: Db; byMessage: Map<string, string[]> }> {
  const { client, db } = await setupDb();
  const all = specs();
  const fixtures = all.map((spec, index) => {
    const fixture = new TurnFixture({
      session: spec.session,
      endUser: spec.user,
      turnId: `turn-${index}`,
      start: spec.at,
    }).invoke(spec.tool);
    return spec.fails ? fixture.error(spec.tool) : fixture;
  });
  await seedLedger(client, db, fixtures);
  for (const [index, spec] of all.entries()) {
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, ingest_source, payload)
       values (gen_random_uuid(), $1, 'turn_start', $2, $3, $3, $4, 'runtime', $5::jsonb)`,
      [
        PROJECT_ID,
        spec.session,
        new Date(spec.at).toISOString(),
        `start-${index}`,
        JSON.stringify({
          type: "turn_start",
          turn_id: `turn-${index}`,
          user_message: spec.message,
        }),
      ],
    );
  }
  const turns = (
    await client.query<{ id: string; turn_key: string }>(`select id, turn_key from trace_turns`)
  ).rows;
  const byMessage = new Map<string, string[]>();
  for (const turn of turns) {
    const message = all[Number(turn.turn_key.replace("declared:turn-", ""))]!.message;
    byMessage.set(message, [...(byMessage.get(message) ?? []), turn.id]);
  }
  return { client, db, byMessage };
}

function deps(
  db: Db,
  tracked: string[],
  over: Partial<AssignTopicsDeps> = {},
): Partial<AssignTopicsDeps> {
  return {
    now: () => NOW,
    readingStart: (p, w, max) => readingStart(p, w, max, db),
    listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
    loadAsks: (p, ids) => loadAskSourcesByTurn(p, ids, db),
    loadModelOnlyTraces: (p, w, closed, max) => loadModelOnlyTraces(p, w, closed, max, db),
    loadRefusedTraces: (p, ids) => loadRefusedTraces(p, ids, db),
    idleCloseMs: 30 * MINUTE,
    hashSalt: "test-salt",
    loadTurnTasks: (p, ids) => loadTurnTasks(p, ids, db),
    loadHelperTools: (p) => loadHelperTools(p, db),
    loadSelfCorrections: (p, ids) => loadSelfCorrectionKinds(p, ids, db),
    loadTopics: (p) => loadStoredTopics(p, db),
    loadPreviousPlacements: (p, ids) => loadPreviousPlacements(p, ids, db),
    loadReading: (p) => loadTopicReading(p, db),
    loadVerdicts: (p, hash, hashes) => loadVerdicts(p, hash, hashes, db),
    saveVerdicts: (p, hash, model, rows) => saveVerdicts(p, hash, model, rows, db),
    saveReading: (p, reading) => saveTopicReading(p, reading, db),
    judge: null,
    sentimentJudge: null,
    name: null,
    nameModel: "test-model",
    observability: { trackSystemEvent: async (event) => void tracked.push(event) },
    ...over,
  };
}

test("a first reading without a model makes topics from the asks' own words and places every turn", async () => {
  const { client, db, byMessage } = await seed();
  const [deliveryTurn] = byMessage.get("check delivery status of PO 12")!;
  await client.query(`update trace_turns set workflow_id = 'wf_delivery' where id = $1`, [
    deliveryTurn,
  ]);
  const tracked: string[] = [];
  const result = await assignProjectTopics(PROJECT_ID, deps(db, tracked));
  assert.equal(result.turns, 14);
  assert.equal(result.naming, "words");
  assert.equal(result.placement, "words");
  assert.deepEqual(tracked, ["topic_run_completed"]);

  const topics = await loadStoredTopics(PROJECT_ID, db);
  assert.deepEqual(topics.map((t) => [t.name, t.labelSource]).sort(), [
    ["Book an inspection", "words"],
    ["Check delivery status", "words"],
  ]);

  const rows = (
    await client.query<{
      turn_id: string;
      verdict: string;
      topic_id: string | null;
      sentiment: string | null;
      ask_source: string;
    }>(`select turn_id, verdict, topic_id, sentiment, ask_source from trace_turn_topics`)
  ).rows;
  assert.equal(rows.length, 14);
  const byTurn = new Map(rows.map((row) => [row.turn_id, row]));
  const [again] = byMessage.get("Book a site inspection for Friday")!;
  assert.equal(byTurn.get(again!)?.verdict, "retry", "asked again straight after");
  const [thanks] = byMessage.get("thanks, that's perfect")!;
  assert.deepEqual(
    [byTurn.get(thanks!)?.verdict, byTurn.get(thanks!)?.sentiment],
    ["none", "positive"],
  );
  assert.ok(rows.every((row) => row.ask_source === "user"));
  assert.ok(
    rows.every((row) => row.sentiment !== null),
    "every ask was the user's own words",
  );

  const reading = await loadTopicReading(PROJECT_ID, db);
  assert.ok(reading);
  const delivery = reading.insights.topics.find(
    (t) => t.turns === 6 && t.tools[0]?.id === "track_delivery",
  )!;
  assert.ok(delivery, "the delivery topic");
  assert.equal(delivery.answered, 5, "the failed call is unanswered");
  assert.deepEqual(delivery.tasks, [{ id: "wf_delivery", turns: 1 }]);
  assert.equal(delivery.untasked, 5);
  const inspection = reading.insights.topics.find((t) => t.id !== delivery.id)!;
  assert.equal(inspection.askedAgain, 1);
  assert.equal(reading.insights.verdicts.retry, 1);
  assert.ok(reading.insights.flows, "end users keep sessions trusted");
  assert.deepEqual(
    reading.insights.flows!.all.columns.map((c) => c.position),
    [1, 2, 3],
  );
  assert.equal(
    reading.insights.flows!.all.columns[0]!.nodes[0]!.key,
    delivery.id,
    "every conversation starts with a delivery ask",
  );
});

test("the next reading keeps the topic ids, and a model renames the ones named from words", async () => {
  const { db } = await seed();
  await assignProjectTopics(PROJECT_ID, deps(db, []));
  const before = await loadStoredTopics(PROJECT_ID, db);
  const seen: number[] = [];
  const namer: Namer = async (groups) => {
    seen.push(groups.length);
    return groups.map((group, index) => ({
      name: group.asks.some((ask) => ask.includes("delivery"))
        ? "Material delivery"
        : "Inspection booking",
      description: "One plain sentence.",
      groups: [index],
    }));
  };
  const result = await assignProjectTopics(PROJECT_ID, deps(db, [], { name: namer }));
  assert.deepEqual(seen, [2], "one call, both words-named topics");
  assert.equal(result.renamed, 2);
  assert.equal(result.created, 0);
  const after = await loadStoredTopics(PROJECT_ID, db);
  assert.deepEqual(
    after.map((t) => t.topicId).sort(),
    before.map((t) => t.topicId).sort(),
    "same ids",
  );
  assert.deepEqual(after.map((t) => [t.name, t.labelSource, t.model]).sort(), [
    ["Inspection booking", "llm", "test-model"],
    ["Material delivery", "llm", "test-model"],
  ]);
  const third = await assignProjectTopics(PROJECT_ID, deps(db, [], { name: namer }));
  assert.equal(third.renamed, 0, "nothing left to name");
  assert.deepEqual(seen, [2]);
});

test("the reading job is queued once while one waits, and reads as in flight", async () => {
  const { db } = await setupDb();
  assert.equal(await topicReadingInFlight(PROJECT_ID, db), false);
  assert.ok(await enqueueAssignTopicsJob(PROJECT_ID, db));
  assert.equal(await enqueueAssignTopicsJob(PROJECT_ID, db), null);
  assert.equal(await topicReadingInFlight(PROJECT_ID, db), true);
});

test("task runs come from the latest completed signal run", async () => {
  const { client, db } = await setupDb();
  assert.deepEqual(await loadTaskRuns(PROJECT_ID, db), []);
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, summary)
     values ($1, 'manual', 'completed', 30, now() - interval '30 days', now(), $2::jsonb)`,
    [
      PROJECT_ID,
      JSON.stringify({
        workflows: {
          items: [
            { id: "wf_a", runs: 40, typicalOrder: ["find", "book"] },
            { id: "wf_b", runs: 12 },
            { bad: true },
          ],
        },
      }),
    ],
  );
  assert.deepEqual(await loadTaskRuns(PROJECT_ID, db), [
    { id: "wf_a", runs: 40, typicalOrder: ["find", "book"] },
    { id: "wf_b", runs: 12, typicalOrder: [] },
  ]);
});

test("the decision engine places the asks once; later readings read its cached verdicts", async () => {
  const { client, db } = await seed();
  const asked: string[][] = [];
  const judge = {
    model: "fake-engine",
    judge: async (
      cases: readonly { id: string; query: string }[],
      corpus: readonly { entryId: string; name: string }[],
    ) => {
      asked.push(cases.map((c) => c.query));
      const pick = (query: string) =>
        corpus.find(
          (entry) =>
            (query.includes("deliver") ? /deliver/i : /inspect/i).test(entry.name) &&
            !query.includes("thanks"),
        )?.entryId ?? "none";
      return cases.map((c) => ({
        id: c.id,
        entryId: pick(c.query),
        confident: true,
        confidence: 0.95,
      }));
    },
  };
  const sentimentJudge = {
    model: "fake-engine",
    judge: async (cases: readonly { id: string; query: string }[]) =>
      cases.map((c) => ({
        id: c.id,
        entryId: c.query.includes("PO 12") ? "negative" : "",
        confident: true,
      })),
  };
  const failingNamer: Namer = async () => {
    throw new Error("model outage");
  };
  const first = await assignProjectTopics(
    PROJECT_ID,
    deps(db, [], { judge, sentimentJudge, name: failingNamer }),
  );
  assert.equal(first.naming, "words", "a failed naming call falls back to the asks' own words");
  assert.equal(first.created, 2);
  assert.equal(
    first.placement,
    "judged",
    "the new topics' asks were judged against them in the same reading",
  );
  assert.equal(asked.length, 1, "no topics before: one pass, against the new set");
  const rows = (
    await client.query<{ verdict: string; sentiment: string | null; n: number }>(
      `select verdict, sentiment, count(*)::int as n from trace_turn_topics group by 1, 2 order by 1, 2`,
    )
  ).rows;
  assert.deepEqual(rows, [
    { verdict: "none", sentiment: "positive", n: 1 },
    { verdict: "retry", sentiment: "neutral", n: 1 },
    { verdict: "topic", sentiment: "negative", n: 2 },
    { verdict: "topic", sentiment: "neutral", n: 10 },
  ]);
  const second = await assignProjectTopics(
    PROJECT_ID,
    deps(db, [], { judge, sentimentJudge, name: null }),
  );
  assert.equal(second.judged, 0, "every verdict came from the cache");
  assert.equal(second.sentimentJudged, 0);
  assert.equal(asked.length, 1);
  assert.equal(second.placement, "judged");
});

test("a trace of model calls alone is an ask too: read from its prompt, counted unanswered, never written as a turn", async () => {
  const { client, db } = await seed();
  const trace = "a".repeat(32);
  const at = new Date(START + 9 * 60 * MINUTE);
  for (const [index, payload] of [
    { type: "otlp_model_call", prompt: "check the delivery status of the crane" },
    { type: "otlp_model_call" },
  ].entries()) {
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, span_id, ingest_source, payload)
       values (gen_random_uuid(), $1, 'otlp_model_call', 'conv-9', $2, $2, $3, $4, $5, 'otlp', $6::jsonb)`,
      [
        PROJECT_ID,
        new Date(at.getTime() + index * 1_000).toISOString(),
        `model-${index}`,
        trace,
        `span-${index}`,
        JSON.stringify(payload),
      ],
    );
  }
  // A trace with a tool call makes a ledger turn, so it is never read as model-only.
  await client.query(
    `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, ingest_source, payload)
     values (gen_random_uuid(), $1, 'otlp_model_call', 'conv-8', $2, $2, 'model-x', $3, 'otlp', $4::jsonb),
            (gen_random_uuid(), $1, 'invoke_end', 'conv-8', $2, $2, 'tool-x', $3, 'otlp', '{}'::jsonb)`,
    [PROJECT_ID, at.toISOString(), "b".repeat(32), JSON.stringify({ prompt: "rent a lift" })],
  );
  const traces = await loadModelOnlyTraces(
    PROJECT_ID,
    { from: new Date(START), to: NOW },
    new Date(NOW.getTime() - 30 * MINUTE),
    100,
    db,
  );
  assert.deepEqual(
    traces.map((t) => [t.traceId, t.sessionId, t.prompt]),
    [[trace, "conv-9", "check the delivery status of the crane"]],
  );

  const result = await assignProjectTopics(PROJECT_ID, deps(db, []));
  assert.equal(result.turns, 15);
  assert.equal(result.modelOnly, 1);
  const reading = await loadTopicReading(PROJECT_ID, db);
  const delivery = reading!.insights.topics.find((t) => t.tools[0]?.id === "track_delivery")!;
  assert.equal(delivery.turns, 7, "the model-only ask joins the delivery topic");
  assert.equal(delivery.answered, 5, "and counts as unanswered");
  assert.ok(delivery.examples.includes(`trace:${trace}`), "its example is read by trace id");
  assert.equal(reading!.insights.modelOnlyTurns, 1);
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from trace_turn_topics`,
  );
  assert.equal(rows[0]!.n, 14, "only ledger turns get a row");
});

test("a turn that looked something up but whose reply says the agent could not do it is unanswered", async () => {
  const { client, db } = await setupDb();
  const traces = ["c".repeat(32), "d".repeat(32)];
  const fixtures = traces.map((traceId, index) =>
    new TurnFixture({
      session: `otel-${index}`,
      lane: "otlp",
      traceId,
      start: START + index * MINUTE,
    }).invoke("get_project_info"),
  );
  await seedLedger(client, db, fixtures);
  const replies = [
    "I can’t book equipment rentals: there’s no rental tool connected to Site Copilot.",
    "The scissor lift is booked for Monday.",
  ];
  for (const [index, traceId] of traces.entries()) {
    await client.query(
      `insert into events (project_id, occurred_at, payload, trace_id, dedupe_hash)
       values ($1, $2, $3::jsonb, $4, $5)`,
      [
        PROJECT_ID,
        new Date(START + index * MINUTE).toISOString(),
        JSON.stringify({
          finish_reason: "stop",
          messages: [
            { role: "user", content: "rent a lift" },
            { role: "assistant", content: [{ type: "text", text: replies[index] }] },
          ],
        }),
        traceId,
        `hash-${index}`,
      ],
    );
  }
  assert.deepEqual([...(await loadRefusedTraces(PROJECT_ID, traces, db))], [traces[0]]);
  const turns = (
    await client.query<{ id: string; turn_key: string }>(`select id, turn_key from trace_turns`)
  ).rows;
  for (const turn of turns) {
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, ingest_source, payload)
       values (gen_random_uuid(), $1, 'otlp_model_call', 's', $2, $2, $3, $4, 'otlp', $5::jsonb)`,
      [
        PROJECT_ID,
        new Date(START).toISOString(),
        `m-${turn.id}`,
        turn.turn_key.slice("otlp:".length),
        JSON.stringify({ prompt: "rent a scissor lift for monday" }),
      ],
    );
  }
  const result = await assignProjectTopics(PROJECT_ID, deps(db, []));
  assert.equal(result.refused, 1);
  const reading = await loadTopicReading(PROJECT_ID, db);
  assert.equal(reading!.insights.refusedTurns, 1);
  assert.deepEqual(
    reading!.insights.unplaced,
    { turns: 2, answered: 1 },
    "two turns are too few for a topic; one of them was answered",
  );
});

/**
 * Turns that run several tools: 8 delivery asks (7 run sync, get_po and
 * track_delivery, 1 only get_po) and 12 inspection asks (book_inspection
 * and sync), with a signal run that names sync a helper.
 */
async function seedPatterns(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  const delivery = [
    "check delivery status of PO 12",
    "check the delivery status of the switchgear",
    "check delivery status for rebar",
  ];
  const inspection = [
    "book a site inspection for friday",
    "book an inspection with the city",
    "book a site inspection for monday",
  ];
  const all: { message: string; tools: string[]; skillHits?: string[] }[] = [
    ...Array.from({ length: 7 }, (_, i) => ({
      message: delivery[i % 3]!,
      tools: ["sync", "get_po", "track_delivery"],
    })),
    { message: delivery[0]!, tools: ["get_po"] },
    ...Array.from({ length: 12 }, (_, i) => ({
      message: inspection[i % 3]!,
      tools: ["book_inspection", "sync"],
      ...(i === 0 ? { skillHits: ["site-inspections"] } : {}),
    })),
  ];
  const fixtures = all.map((spec, index) => {
    let fixture = new TurnFixture({
      session: `p${index}`,
      endUser: `u${index}`,
      turnId: `turn-${index}`,
      start: START + index * 60 * MINUTE,
    });
    if (spec.skillHits) fixture = fixture.skillSearch(spec.skillHits);
    for (const tool of spec.tools) fixture = fixture.invoke(tool);
    return fixture;
  });
  await seedLedger(client, db, fixtures);
  for (const [index, spec] of all.entries()) {
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, ingest_source, payload)
       values (gen_random_uuid(), $1, 'turn_start', $2, $3, $3, $4, 'runtime', $5::jsonb)`,
      [
        PROJECT_ID,
        `p${index}`,
        new Date(START + index * 60 * MINUTE).toISOString(),
        `start-${index}`,
        JSON.stringify({
          type: "turn_start",
          turn_id: `turn-${index}`,
          user_message: spec.message,
        }),
      ],
    );
  }
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, summary)
     values ($1, 'manual', 'completed', 30, now() - interval '30 days', now(), $2::jsonb)`,
    [PROJECT_ID, JSON.stringify({ workflows: { items: [], ubiquitousTools: ["sync"] } })],
  );
  return { client, db };
}

test("each intent's tool pattern is stored with the reading, the signal run's helper set aside", async () => {
  const { db } = await seedPatterns();
  assert.deepEqual(await loadHelperTools(PROJECT_ID, db), ["sync"]);
  const tracked: string[] = [];
  const result = await assignProjectTopics(PROJECT_ID, deps(db, tracked));
  assert.equal(result.patterns, 2, "both intents have five turns or more");
  const reading = await loadTopicReading(PROJECT_ID, db);
  const delivery = reading!.insights.topics.find((t) => t.turns === 8)!;
  assert.deepEqual(delivery.pattern?.tools, [
    { id: "get_po", turns: 8 },
    { id: "track_delivery", turns: 7 },
  ]);
  assert.deepEqual([delivery.pattern?.runs, delivery.pattern?.inOrder], [7, 7]);
  assert.deepEqual(
    delivery.pattern?.helpers,
    [{ id: "sync", turns: 7 }],
    "named apart, never in the pattern",
  );
  assert.deepEqual(
    delivery.pattern?.comesBefore,
    [{ first: "get_po", tool: "track_delivery", turns: 7, together: 7 }],
    "get_po runs in 8 of 20 turns: a lift of 2.5",
  );
  const inspection = reading!.insights.topics.find((t) => t.turns === 12)!;
  assert.deepEqual(inspection.pattern?.tools, [{ id: "book_inspection", turns: 12 }]);
  assert.deepEqual(
    inspection.pattern?.skills,
    { invoked: 0, offered: 1 },
    "a skill search returned a skill once",
  );
  assert.deepEqual(tracked, ["topic_run_completed"]);
});

test("a helper read that fails costs the patterns, never the reading", async () => {
  const { db } = await seedPatterns();
  const tracked: string[] = [];
  const result = await assignProjectTopics(
    PROJECT_ID,
    deps(db, tracked, {
      loadHelperTools: async () => {
        throw new Error("statement timeout");
      },
    }),
  );
  assert.equal(result.patterns, 0);
  assert.equal(result.topics, 2, "the reading itself is whole");
  assert.deepEqual(tracked, ["topic_run_completed"]);
  const reading = await loadTopicReading(PROJECT_ID, db);
  assert.ok(
    reading!.insights.topics.every((t) => t.pattern === undefined),
    "no pattern with sync read as an intent's own tool",
  );
});

test("a signal run stored before the helper set was kept reads no patterns; an empty set is a known answer", async () => {
  const { client, db } = await seedPatterns();
  await client.query(
    `update trace_signal_runs set summary = '{"workflows": {"items": []}}'::jsonb`,
  );
  assert.equal(await loadHelperTools(PROJECT_ID, db), null);
  assert.equal((await assignProjectTopics(PROJECT_ID, deps(db, []))).patterns, 0);
  await client.query(
    `update trace_signal_runs set summary = '{"workflows": {"items": [], "ubiquitousTools": []}}'::jsonb`,
  );
  assert.deepEqual(await loadHelperTools(PROJECT_ID, db), []);
  assert.equal((await assignProjectTopics(PROJECT_ID, deps(db, []))).patterns, 2);
  const delivery = (await loadTopicReading(PROJECT_ID, db))!.insights.topics.find(
    (t) => t.turns === 8,
  )!;
  assert.deepEqual(
    delivery.pattern?.tools.map((tool) => tool.id),
    ["sync", "get_po", "track_delivery"],
    "with no helpers named, sync is the intent's own",
  );
  await client.query(`delete from trace_signal_runs`);
  assert.equal(await loadHelperTools(PROJECT_ID, db), null, "no run at all: unknown");
});
