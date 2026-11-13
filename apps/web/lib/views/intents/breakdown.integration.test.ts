import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  loadIntentBreakdown,
  loadIntentBreakdownSummary,
  ReadBudgetExceeded,
  readBreakdownInput,
  readIntentBreakdowns,
  resetBreakdownCache,
} from "@/lib/views/intents/breakdown-queries";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T12:00:00Z");
const AT = "2026-10-19T10:00:00Z";

// Events, turns, clusters (level 1 G1, G2; level 0 c1..c3).
const E = {
  s0: "aaaaaaaa-0000-4000-8000-000000000000",
  s1: "aaaaaaaa-0000-4000-8000-000000000001",
  s2: "aaaaaaaa-0000-4000-8000-000000000002",
  u: "aaaaaaaa-0000-4000-8000-000000000003",
  p1: "aaaaaaaa-0000-4000-8000-000000000004",
  p2: "aaaaaaaa-0000-4000-8000-000000000005",
};
const T = {
  search: "bbbbbbbb-0000-4000-8000-000000000001",
  user: "bbbbbbbb-0000-4000-8000-000000000002",
  otlp: "bbbbbbbb-0000-4000-8000-000000000003",
  old: "bbbbbbbb-0000-4000-8000-000000000004",
};
const G1 = "cccccccc-0000-4000-8000-000000000001";
const G2 = "cccccccc-0000-4000-8000-000000000002";
const C = {
  c1: "dddddddd-0000-4000-8000-000000000001",
  c2: "dddddddd-0000-4000-8000-000000000002",
  c3: "dddddddd-0000-4000-8000-000000000003",
};

async function setup(): Promise<{ client: PGlite; db: BoundReadDb }> {
  resetBreakdownCache();
  const client = await createMigratedPGlite();
  const event = (id: string, type: string, extra: string) =>
    `insert into trace_events (id, project_id, type, client_event_id, received_at, occurred_at, payload ${extra.split("|")[0]})
     values ('${id}', '${PROJECT}', '${type}', '${id}', '${AT}', '${AT}', ${extra.split("|")[1]});`;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Site', 'site');
    ${event(E.s0, "search", `, session_id, query|'{}'::jsonb, 's-r', ''`)}
    ${event(E.s1, "search", `, session_id, query|'{}'::jsonb, 's-r', 'check the delivery status of po-1'`)}
    ${event(E.s2, "search", `, session_id, query|'{}'::jsonb, 's-r', 'another search later'`)}
    ${event(E.u, "turn_start", `, session_id, turn_id|'{"user_message":"when does the drywall arrive"}'::jsonb, 's-u', 'tu-1'`)}
    ${event(E.p1, "otlp_model_call", `, ingest_source, trace_id|'{"prompt":"is the pour on track and when does steel arrive"}'::jsonb, 'otlp', 'tr-1'`)}
    insert into trace_events (id, project_id, type, client_event_id, received_at, occurred_at, payload, ingest_source, trace_id)
    values ('${E.p2}', '${PROJECT}', 'otlp_model_call', '${E.p2}', '${AT}', '2026-10-19T10:05:00Z', '{"prompt":"a later prompt"}'::jsonb, 'otlp', 'tr-1');

    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at) values
      ('${T.search}', '${PROJECT}', 's-r', 'inferred:${E.s0}', 'inferred', 'runtime', 'closed', '${AT}', '${AT}', '${AT}'),
      ('${T.user}', '${PROJECT}', 's-u', 'declared:tu-1', 'declared', 'runtime', 'closed', '${AT}', '${AT}', '${AT}'),
      ('${T.otlp}', '${PROJECT}', 'conv-1', 'otlp:tr-1', 'otlp', 'otlp', 'closed', '${AT}', '${AT}', '${AT}'),
      ('${T.old}', '${PROJECT}', 's-r', 'inferred:old', 'inferred', 'runtime', 'closed', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at) values
      ('${T.search}', '${PROJECT}', 1, 'search', 'search', '${E.s0}', '${AT}', '${AT}'),
      ('${T.search}', '${PROJECT}', 2, 'search', 'search', '${E.s1}', '${AT}', '${AT}'),
      ('${T.search}', '${PROJECT}', 3, 'search', 'search', '${E.s2}', '${AT}', '${AT}');
    insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, ask_source, started_at) values
      ('${T.search}', '${PROJECT}', 'delivery', 'topic', 'search', '${AT}'),
      ('${T.user}', '${PROJECT}', 'delivery', 'topic', 'user', '${AT}'),
      ('${T.otlp}', '${PROJECT}', 'schedule', 'topic', 'prompt', '${AT}'),
      ('${T.old}', '${PROJECT}', 'schedule', 'topic', 'search', '2026-08-01T00:00:00Z');

    insert into intent_clusters (id, project_id, level, label, children, llm_label) values
      ('${G1}', '${PROJECT}', 1, 'Check delivery', '["${C.c1}","${C.c3}"]'::jsonb, 'Check a delivery date'),
      ('${G2}', '${PROJECT}', 1, 'Read schedule', '["${C.c2}"]'::jsonb, null);
    update intent_clusters set label = llm_label where id = '${G1}';
    insert into intent_clusters (id, project_id, level, parent_id, label, members) values
      ('${C.c1}', '${PROJECT}', 0, '${G1}', 'check the delivery status of po-1', '["check the delivery status of po-1","track po-2","check the delivery status of po-1"]'::jsonb),
      ('${C.c2}', '${PROJECT}', 0, '${G2}', 'is the pour on track', '["is the pour on track"]'::jsonb),
      ('${C.c3}', '${PROJECT}', 0, '${G1}', 'when does the drywall arrive', '["when does the drywall arrive","when does steel arrive"]'::jsonb);
    insert into intent_cluster_assignments (project_id, trace_event_id, ask_index, cluster_id, kind, session_id, turn_id, trace_id, occurred_at) values
      ('${PROJECT}', '${E.s1}', 0, '${C.c1}', 'search', 's-r', null, null, '${AT}'),
      ('${PROJECT}', '${E.s2}', 0, '${C.c2}', 'search', 's-r', null, null, '${AT}'),
      ('${PROJECT}', '${E.u}', 0, '${C.c3}', 'user_message', 's-u', 'tu-1', null, '${AT}'),
      ('${PROJECT}', '${E.p1}', 0, '${C.c2}', 'prompt', 'tr-1', 'tr-1', 'tr-1', '${AT}'),
      ('${PROJECT}', '${E.p1}', 1, '${C.c3}', 'prompt', 'tr-1', 'tr-1', 'tr-1', '${AT}'),
      ('${PROJECT}', '${E.p2}', 0, '${C.c1}', 'prompt', 'tr-1', 'tr-1', 'tr-1', '2026-10-19T10:05:00Z');
    insert into intent_engine_state (project_id) values ('${PROJECT}');
    insert into trace_topics (project_id, topic_id, name, input_hash) values
      ('${PROJECT}', 'delivery', 'Delivery status', 'h1'), ('${PROJECT}', 'schedule', 'Schedule status', 'h2');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as BoundReadDb };
}

test("each turn's ask is the one its Intent was read from: first search with a query, the turn's message, the trace's first prompt", async () => {
  const { db } = await setup();
  const input = await readBreakdownInput(PROJECT, { now: NOW }, db);
  assert.deepEqual(
    Object.fromEntries(input.asksByTopic),
    { delivery: 2, schedule: 1 },
    "the old turn is outside the window",
  );
  const asks = input.asks.map((a) => [a.topicId, a.clusters]).sort();
  assert.deepEqual(asks, [
    ["delivery", [C.c1]],
    ["delivery", [C.c3]],
    ["schedule", [C.c2, C.c3]],
  ]);
  assert.equal(input.groups.get(G1)?.named, true);
  assert.equal(input.groups.get(G2)?.named, false);
});

test("each Intent's turns are read newest first up to the per-Intent cap, and the cap says so", async () => {
  const { db } = await setup();
  const one = await readBreakdownInput(PROJECT, { now: NOW, turnsPerIntent: 1 }, db);
  assert.deepEqual(Object.fromEntries(one.asksByTopic), { delivery: 1, schedule: 1 });
  assert.deepEqual([...one.capped], ["delivery"], "delivery had two turns; schedule's one fit");
  const all = await readBreakdownInput(PROJECT, { now: NOW }, db);
  assert.equal(all.capped.size, 0);
});

test("the breakdown places groups by majority, counts each ask once, and fills samples", async () => {
  const { db } = await setup();
  const delivery = await loadIntentBreakdown(PROJECT, "delivery", {
    now: NOW,
    db,
    timeoutMs: 5_000,
  });
  assert.ok(delivery);
  assert.equal(delivery.whatTheyAskFor.skipped, true, "one group: the level is skipped");
  const [group] = delivery.whatTheyAskFor.groups;
  assert.deepEqual([group!.label, group!.asks, group!.totalAsks], ["Check a delivery date", 2, 2]);
  assert.deepEqual(group!.waysOfAsking.ways.map((w) => [w.label, w.asks, w.of, w.samples]).sort(), [
    ["check the delivery status of po-1", 1, 2, ["track po-2"]],
    ["when does the drywall arrive", 1, 2, ["when does steel arrive"]],
  ]);
  const schedule = await loadIntentBreakdown(PROJECT, "schedule", {
    now: NOW,
    db,
    timeoutMs: 5_000,
  });
  assert.deepEqual(
    schedule?.whatTheyAskFor.groups.map((g) => [g.label, g.quoted, g.asks]),
    [["is the pour on track", true, 1]],
    "no model named it: its ask, quoted",
  );
  assert.deepEqual(
    schedule?.alsoWants,
    [{ topicId: "delivery", asks: 1, share: 1 }],
    "the second frame wants Delivery",
  );

  const summary = await loadIntentBreakdownSummary(PROJECT, { now: NOW, db, timeoutMs: 5_000 });
  const { rows, ...counts } = summary.get("delivery")!;
  assert.deepEqual(counts, {
    topicId: "delivery",
    asks: 2,
    placed: 2,
    groups: 1,
    children: 2,
    skipped: true,
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.label, r.quoted, r.asks, r.share]).sort(), [
    ["way", "check the delivery status of po-1", true, 1, 0.5],
    ["way", "when does the drywall arrive", true, 1, 0.5],
  ]);
  assert.equal(await loadIntentBreakdown(PROJECT, "nothing-here", { now: NOW, db }), null);
});

test("a failed read degrades to nothing, logged and reported, never thrown", async () => {
  resetBreakdownCache();
  const logged: string[] = [];
  const reported: string[] = [];
  const broken = {
    transaction: async () => {
      throw new Error("canceling statement due to statement timeout");
    },
  } as unknown as BoundReadDb;
  const deps = {
    logError: (message: string) => void logged.push(message),
    reportServerException: ((_err: unknown, distinctId: string) =>
      void reported.push(distinctId)) as never,
  };
  assert.equal(
    await loadIntentBreakdown(
      PROJECT,
      "delivery",
      { now: NOW, db: broken, timeoutMs: 5_000 },
      deps,
    ),
    null,
  );
  assert.deepEqual(
    (await loadIntentBreakdownSummary(PROJECT, { now: NOW, db: broken, timeoutMs: 5_000 }, deps))
      .size,
    0,
  );
  assert.deepEqual(logged, ["read degraded to fallback", "read degraded to fallback"]);
  assert.deepEqual(reported, [`project:${PROJECT}`, `project:${PROJECT}`]);
});

/** The fixture's database, counting the transactions run on it. */
function counting(db: BoundReadDb): { db: BoundReadDb; transactions: () => number } {
  let count = 0;
  const counted = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "transaction" && typeof value === "function") {
        return (...args: unknown[]) => {
          count += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { db: counted, transactions: () => count };
}

test("a project the engine never ran for reads as none, without reading its turns", async () => {
  const { client, db } = await setup();
  await client.exec(`delete from intent_engine_state where project_id = '${PROJECT}'`);
  const { db: counted, transactions } = counting(db);
  assert.equal(
    (await readIntentBreakdowns(PROJECT, { now: NOW, db: counted, timeoutMs: 5_000 })).size,
    0,
  );
  assert.equal(transactions(), 1, "the key's read only");
});

test("reads of one reading at once share one read; the next is kept", async () => {
  const { db } = await setup();
  const { db: counted, transactions } = counting(db);
  const [a, b] = await Promise.all([
    readIntentBreakdowns(PROJECT, { now: NOW, db: counted, timeoutMs: 5_000 }),
    readIntentBreakdowns(PROJECT, { now: NOW, db: counted, timeoutMs: 5_000 }),
  ]);
  assert.equal(a, b, "the same result");
  assert.equal(transactions(), 3, "two key reads, one read of the turns");
  await readIntentBreakdowns(PROJECT, { now: NOW, db: counted, timeoutMs: 5_000 });
  assert.equal(transactions(), 4, "kept: the key's read only");
});

test("a read past its budget stops between statements; for a minute after, the reading reads as none", async () => {
  const { db } = await setup();
  await assert.rejects(
    readIntentBreakdowns(PROJECT, { now: NOW, db, timeoutMs: 5_000, budgetMs: -1 }),
    ReadBudgetExceeded,
  );
  assert.equal(
    (await readIntentBreakdowns(PROJECT, { now: NOW, db, timeoutMs: 5_000 })).size,
    0,
    "the failure is remembered, not read again",
  );
  const later = new Date(NOW.getTime() + 61_000);
  assert.ok(
    (await readIntentBreakdowns(PROJECT, { now: later, db, timeoutMs: 5_000 })).size > 0,
    "a minute later it reads again",
  );
});
