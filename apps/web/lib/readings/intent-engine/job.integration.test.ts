import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadCatalogTools } from "@/lib/readings/intent-engine/catalog";
import { type IntentEngineJobDeps, runIntentEngine } from "@/lib/readings/intent-engine/job";
import type { NamesComplete } from "@/lib/readings/intent-engine/names-job";
import {
  claimNamingSlot,
  type EngineDb,
  getEngineState,
  loadClusters,
} from "@/lib/readings/intent-engine/store";
import {
  type IntentGraphDb,
  listFoldableTraceEvents,
  listLastFoldedAsks,
  listTraceEventHitsForEvents,
} from "@/lib/readings/intent-graph/queries";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type Db = IntentGraphDb & Parameters<typeof insertTraceEvents>[2];

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

let seq = 0;
function envelope(body: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return {
    v: 2,
    ts: 1_790_000_000_000 + seq,
    session_id: "sess-a",
    source_id: "app",
    event_id: `evt-${seq}`,
    ...body,
  };
}

function turn(query: string, tool?: string, userMessage?: string) {
  const turnId = `turn-${seq + 1}`;
  const out: Record<string, unknown>[] = [];
  if (userMessage)
    out.push(envelope({ type: "turn_start", turn_id: turnId, user_message: userMessage }));
  out.push(
    envelope({
      type: "search",
      query,
      origin: "agent",
      top_k: 1,
      hits: tool ? [{ tool_id: tool, score: 0.5 }] : [],
      turn_id: turnId,
    }),
  );
  if (tool) out.push(envelope({ type: "invoke_start", tool_id: tool, turn_id: turnId }));
  return out;
}

async function ingest(db: Db, events: Record<string, unknown>[]): Promise<void> {
  const { valid, rejected } = parseTraceEvents(events);
  assert.equal(rejected.length, 0);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((e) => ({ ...e, ingestSource: "runtime" })),
    db,
    { intentGraphRuntimeStatus: true },
  );
}

function deps(db: Db, over: Partial<IntentEngineJobDeps> = {}): Partial<IntentEngineJobDeps> {
  return {
    db: db as unknown as EngineDb,
    frames: false,
    llmKeys: false,
    seed: false,
    nameDeps: () => ({ model: "test-model", complete: null, maxNames: 20 }),
    listEvents: (p, since, tx, limit, lag, options) =>
      listFoldableTraceEvents(p, since, tx ?? db, limit, lag, options),
    commitLagMs: 0,
    listHits: (ids, tx) => listTraceEventHitsForEvents(ids, tx ?? db),
    listLastFoldedAsks: (p, ids, cursor, tx) => listLastFoldedAsks(p, ids, cursor, tx ?? db),
    enqueueClusterIntentsJob: async () => null,
    loadCatalogTools: (p) => loadCatalogTools(p, db as never),
    trackServerEvent: async () => {},
    // Past the hold grace: a search nobody acted on is folded as it is.
    now: () => new Date(Date.now() + 5 * 60_000),
    ...over,
  };
}

const count = async (client: PGlite, sql: string) =>
  (await client.query<{ n: number }>(sql)).rows[0]!.n;

test("clusters, assignments, levels and the cursor; no Intents rows and no model call without a key", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    ...turn("assign this task to emp-1", "assign_task"),
    ...turn("assign this task to emp-2", "assign_task"),
    ...turn("create task", "create_task"),
    ...turn("update task", "update_task"),
    ...turn("cancel my subscription"),
  ]);
  const events: string[] = [];
  const result = await runIntentEngine(
    PROJECT_ID,
    deps(db, { trackServerEvent: async (name) => void events.push(name) }),
  );
  assert.equal(result.outcome, "clustered");
  assert.equal(result.seeded, true);
  assert.equal(result.asks, 5);
  assert.equal(result.assignments, 5);
  assert.equal(await count(client, "select count(*)::int as n from intent_cluster_assignments"), 5);
  assert.ok(result.levels >= 2, "levels 1 and 2 are built");
  assert.ok(result.intents >= 1);
  const topics = await client.query<{ label: string }>(
    "select label from intent_clusters where level = 2 and jsonb_array_length(children) > 1",
  );
  assert.deepEqual(
    topics.rows.map((r) => r.label),
    ["Task operations"],
  );
  const unanswered = await client.query<{ support: number; asks: number }>(
    "select support, asks from intent_clusters where level = 0 and members @> '[\"cancel my subscription\"]'",
  );
  assert.deepEqual(unanswered.rows, [{ support: 0, asks: 1 }]);
  assert.equal(
    await count(client, "select count(*)::int as n from query_intents"),
    0,
    "the engine writes no Intents rows",
  );
  assert.equal(result.naming.calls, 0);
  assert.deepEqual(events, ["intent_engine_clustered"]);
  const state = await getEngineState(PROJECT_ID, db as unknown as EngineDb);
  const max = await client.query<{ t: string }>(
    "select max(received_at)::text as t from trace_events",
  );
  assert.equal(state?.cursor, max.rows[0]!.t);

  const again = await runIntentEngine(PROJECT_ID, deps(db));
  assert.equal(again.outcome, "caught_up");
  assert.equal(
    await count(client, "select count(*)::int as n from intent_cluster_assignments"),
    5,
    "idempotent",
  );
});

test("with seeding on, a first run starts from the project's recurring asks; off, from nothing", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into query_intents (id, project_id, normalized_text, text, member_text, occurrences)
    values ('33333333-3333-4333-8333-333333333333', '${PROJECT_ID}', 'export the quarterly report', 'export the quarterly report', 'download the quarterly report', 3);
  `);
  await ingest(db, turn("export the quarterly report", "export_report"));
  const seeded = await runIntentEngine(PROJECT_ID, deps(db, { seed: true }));
  assert.equal(seeded.seeded, true);
  const linked = await client.query<{ asks: number }>(
    "select asks from intent_clusters where level = 0 and query_intent_id is not null",
  );
  assert.deepEqual(
    linked.rows,
    [{ asks: 3 + 1 }],
    "the recurring ask's cluster, and the ask that joined it",
  );

  const fresh = await setup();
  await fresh.client.exec(`
    insert into query_intents (id, project_id, normalized_text, text, occurrences)
    values ('33333333-3333-4333-8333-333333333333', '${PROJECT_ID}', 'export the quarterly report', 'export the quarterly report', 3);
  `);
  await ingest(fresh.db, turn("export the quarterly report", "export_report"));
  await runIntentEngine(PROJECT_ID, deps(fresh.db));
  assert.equal(
    await count(
      fresh.client,
      "select count(*)::int as n from intent_clusters where level = 0 and query_intent_id is not null",
    ),
    0,
    "the default seeds nothing",
  );
});

test("a turn's user message is an ask of its own, placed once, credited with the turn's calls", async () => {
  const { client, db } = await setup();
  await ingest(
    db,
    turn("reconcile payouts", "reconcile_payouts", "please reconcile last month's payouts"),
  );
  const first = await runIntentEngine(PROJECT_ID, deps(db));
  assert.equal(first.asks, 2, "the search and the user's message");
  const kinds = await client.query<{
    kind: string;
    turn_id: string | null;
    session_id: string | null;
  }>("select kind, turn_id, session_id from intent_cluster_assignments order by kind");
  assert.deepEqual(
    kinds.rows.map((r) => r.kind),
    ["search", "user_message"],
  );
  assert.ok(
    kinds.rows.every((r) => r.turn_id && r.session_id === "sess-a"),
    "both carry the declared turn",
  );
  const message = await client.query<{ usage: Record<string, number>; support: number }>(
    "select usage, support from intent_clusters where level = 0 and members @> '[\"please reconcile last month''s payouts\"]'",
  );
  assert.deepEqual(
    message.rows,
    [{ usage: { "tool:reconcile_payouts": 1 }, support: 0 }],
    "evidence only, never served",
  );
  const state = await getEngineState(PROJECT_ID, db as unknown as EngineDb);
  const cursor = await client.query<{ t: string }>(
    "select max(received_at)::text as t from trace_events where type <> 'turn_start'",
  );
  assert.equal(state?.cursor, cursor.rows[0]!.t, "the cursor follows the fold's rows");

  // The same turn read again (a later page, a rebuilt cursor) does not place its message twice.
  await client.exec("update intent_engine_state set clustered_through = null");
  await runIntentEngine(PROJECT_ID, deps(db));
  assert.equal(
    await count(
      client,
      "select count(*)::int as n from intent_cluster_assignments where kind = 'user_message'",
    ),
    1,
  );
});

test("a run reads a bounded set of clusters, the most recently active, and says when it is capped", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    ...turn("book a meeting room"),
    ...turn("cancel my subscription"),
    ...turn("export the invoices"),
  ]);
  await runIntentEngine(PROJECT_ID, deps(db));
  assert.equal(
    (await loadClusters(PROJECT_ID, db as unknown as EngineDb)).length,
    3,
    "the default limit reads them all",
  );
  await client.exec(
    "update intent_clusters set last_ts = 1 where level = 0 and members @> '[\"book a meeting room\"]'",
  );
  // A new restatement of the cold cluster cannot reach it while it is out of the bounded set.
  await ingest(db, turn("book a meeting room"));
  const bounded = await runIntentEngine(PROJECT_ID, deps(db, { clusterLimit: 2 }));
  assert.equal(bounded.capped, true);
  assert.equal(bounded.clustersCreated, 1);
  assert.equal(bounded.clusters, 2, "maintenance works on the bounded set too");
  const orphans = await count(
    client,
    `select count(*)::int as n from intent_clusters c where c.level = 0 and c.parent_id is not null
       and not exists (select 1 from intent_clusters p where p.id = c.parent_id)`,
  );
  assert.equal(orphans, 0, "the unread cluster's group is kept: its asks keep their place");
  const cold = await client.query<{ parent_id: string | null }>(
    "select parent_id from intent_clusters where level = 0 and last_ts = 1",
  );
  assert.ok(cold.rows[0]?.parent_id, "it still has its group");
});

test("the catalog teaches the engine its actions, with no call needed", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into tool_definitions (project_id, name, description, parameters, source)
    values ('${PROJECT_ID}', 'escalate_ticket', 'Escalate a support ticket to the next tier', '{}'::jsonb, 'sdk');
  `);
  // Two asks nobody acted on: no invoke says what they are, only the catalog's verb.
  await ingest(db, [
    ...turn("escalate ticket 4412 to tier two"),
    ...turn("escalate ticket 9087 to tier three"),
  ]);
  await runIntentEngine(PROJECT_ID, deps(db));
  const parents = await client.query<{ parent_id: string }>(
    "select parent_id from intent_clusters where level = 0 order by created_at",
  );
  assert.equal(parents.rows.length, 2);
  assert.equal(
    parents.rows[0].parent_id,
    parents.rows[1].parent_id,
    "one action, two tickets: one level-1 intent",
  );
});

test("frames: one assignment per action, keyed level 1, and the raw ask served once and never a member", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into tool_definitions (project_id, name, description, parameters, source) values
      ('${PROJECT_ID}', 'create_task', 'Create a new task in a project; returns the new task id', '{"properties":{"title":{}}}'::jsonb, 'sdk'),
      ('${PROJECT_ID}', 'add_task_comment', 'Add a comment to an existing task', '{"properties":{"taskId":{}}}'::jsonb, 'sdk'),
      ('${PROJECT_ID}', 'list_tasks', 'List the tasks in a project', '{}'::jsonb, 'sdk');
  `);
  const multi = "create task comment on task list tasks in project";
  await ingest(db, [
    ...turn(multi, "create_task"),
    ...turn("give new task id for it"),
    ...turn("create a task in project", "create_task"),
  ]);
  const result = await runIntentEngine(PROJECT_ID, deps(db, { frames: true }));
  assert.equal(result.frames, true);
  assert.equal(result.split, 1);
  const parts = await client.query<{ ask_index: number }>(
    "select a.ask_index from intent_cluster_assignments a join trace_events e on e.id = a.trace_event_id where e.query = $1 order by a.ask_index",
    [multi],
  );
  assert.deepEqual(
    parts.rows.map((r) => r.ask_index),
    [0, 1, 2],
    "one assignment per action",
  );
  const clusters = await loadClusters(PROJECT_ID, db as unknown as EngineDb);
  assert.ok(
    clusters.every((c) => !c.members.includes(multi)),
    "the raw ask is never a member",
  );
  assert.deepEqual(
    clusters.flatMap((c) => c.servedMembers).filter((m) => m === multi),
    [multi],
    "served once, whole",
  );
  // "give new task id" and "create task" are one level-1 intent, named for it.
  const intents = await client.query<{ label: string; n: number }>(
    "select label, jsonb_array_length(children)::int as n from intent_clusters where level = 1 order by n desc, label",
  );
  assert.equal(intents.rows[0].label, "Create task");
  assert.ok(intents.rows[0].n >= 2);
  assert.ok(intents.rows.some((r) => r.label === "Create comment"));
});

/** A fake model that names every cluster it is sent. */
function namer(prompts: string[]): NamesComplete {
  return async (_system, user) => {
    prompts.push(user);
    const ids = [...user.matchAll(/<cluster id="(c\d+)" kind="(intent|query)">/g)];
    return JSON.stringify({
      names: ids.map(([, id, kind]) => ({
        id,
        name: `${kind === "intent" ? "Intent" : "Query"} name ${id}`,
      })),
    });
  };
}

test("names: intents only, once, kept across runs and while a new name is due, at most once an hour", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    ...turn("create task", "create_task"),
    ...turn("create a task in project", "create_task"),
    ...turn("list tasks in project", "list_tasks"),
    ...turn("book a meeting room"),
  ]);
  const prompts: string[] = [];
  let clock = Date.now() + 5 * 60_000;
  const named = (over: Partial<IntentEngineJobDeps> = {}) =>
    deps(db, {
      nameDeps: () => ({ model: "test-model", complete: namer(prompts), maxNames: 50 }),
      now: () => new Date(clock),
      ...over,
    });

  const events: Array<[string, Record<string, unknown>]> = [];
  const first = await runIntentEngine(
    PROJECT_ID,
    named({ trackServerEvent: async (name, _ctx, props) => void events.push([name, props ?? {}]) }),
  );
  assert.ok(first.naming.named > 0);
  assert.equal(prompts.length, 1, "one batch call");
  assert.ok(!prompts[0].includes('kind="query"'), "query clusters are not named with keys off");
  const levels = await client.query<{ level: number; n: number }>(
    "select level, count(*)::int as n from intent_clusters where llm_label is not null group by level",
  );
  assert.deepEqual(levels.rows, [{ level: 1, n: first.naming.named }]);
  const ev = events.find(([name]) => name === "intent_engine_named")!;
  assert.equal(ev[1].named, first.naming.named);
  assert.equal(ev[1].cut_off_calls, 0);
  assert.ok(
    !JSON.stringify(events).includes("create a task"),
    "events carry counts, never ask text",
  );

  // Within the hour: no call, and the stored names stand.
  await ingest(db, turn("list all tasks in the project", "list_tasks"));
  clock += 10 * 60_000;
  await runIntentEngine(PROJECT_ID, named());
  assert.equal(prompts.length, 1, "the interval holds the next pass back");
  const kept = await count(
    client,
    "select count(*)::int as n from intent_clusters where level = 1 and llm_label is not null and label <> llm_label",
  );
  assert.equal(kept, 0, "the rule-based relabel does not undo a model name");

  // A run without a key (MODELS=off) still shows the names it has.
  await ingest(db, turn("create one more task", "create_task"));
  clock += 2 * 60 * 60_000;
  await runIntentEngine(PROJECT_ID, deps(db, { now: () => new Date(clock) }));
  assert.equal(prompts.length, 1);
  assert.ok(
    (await count(
      client,
      "select count(*)::int as n from intent_clusters where level = 1 and label like 'Intent name%'",
    )) > 0,
  );
});

test("names: the cap, a failing model and no key leave rule-based names and never fail the run", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    ...turn("create task", "create_task"),
    ...turn("list tasks in project", "list_tasks"),
    ...turn("book a meeting room"),
  ]);
  let calls = 0;
  const capped = await runIntentEngine(
    PROJECT_ID,
    deps(db, {
      nameDeps: () => ({
        model: "test-model",
        maxNames: 1,
        complete: async (_s, user) => {
          calls += 1;
          const [, id] = user.match(/<cluster id="(c\d+)"/)!;
          return JSON.stringify({ names: [{ id, name: "Only one" }] });
        },
      }),
    }),
  );
  assert.equal(capped.naming.named, 1);
  assert.equal(calls, 1);
  assert.deepEqual(
    (
      await client.query<{ level: number }>(
        "select level from intent_clusters where llm_label is not null",
      )
    ).rows,
    [{ level: 1 }],
  );

  await client.exec("update intent_engine_state set clustered_through = null, named_at = null");
  const failing = await runIntentEngine(
    PROJECT_ID,
    deps(db, {
      nameDeps: () => ({
        model: "test-model",
        maxNames: 50,
        complete: async () => {
          throw new Error("overloaded");
        },
      }),
    }),
  );
  assert.equal(failing.outcome, "clustered", "a failed call never fails the run");
  assert.equal(failing.naming.named, 0);
  assert.equal(failing.naming.failedCalls, 1);
});

test("model keys: the model's action and object group intents and domains in the same run; off, the rules do", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into tool_definitions (project_id, name, description, parameters, source) values
      ('${PROJECT_ID}', 'assign_task', 'Assign a task to a member', '{}'::jsonb, 'sdk'),
      ('${PROJECT_ID}', 'create_task', 'Create a task in a project', '{}'::jsonb, 'sdk');
  `);
  await ingest(db, [
    // Two wordings far enough apart to be two query clusters, with no verb the rules know.
    ...turn("give Ada the Falcon onboarding checklist", "assign_task"),
    ...turn("put Chen on the new hire checklist", "assign_task"),
    ...turn("create task in project", "create_task"),
  ]);
  const seen: boolean[] = [];
  const kinds: string[][] = [];
  const complete: NamesComplete = async (system, user, keyed) => {
    seen.push(keyed);
    if (keyed) assert.match(system, /"action" must be one of: .*assign.*\./);
    const blocks = [
      ...user.matchAll(/<cluster id="(c\d+)" kind="(intent|query)">([\s\S]*?)<\/cluster>/g),
    ];
    kinds.push(blocks.map(([, , kind]) => kind));
    return JSON.stringify({
      names: blocks.map(([, id, kind, asks]) => ({
        id,
        name: `${kind} ${id}`,
        ...(kind === "query" && keyed
          ? asks.includes("checklist")
            ? { action: "assign", object: "checklist" }
            : { action: "create", object: "task" }
          : {}),
      })),
    });
  };
  const run = await runIntentEngine(
    PROJECT_ID,
    deps(db, {
      frames: true,
      llmKeys: true,
      nameDeps: () => ({ model: "test-model", complete, maxNames: 50 }),
    }),
  );
  assert.equal(run.keys, true);
  assert.deepEqual(
    seen,
    [true, true],
    "one keyed call, then one for the intents the keys regrouped",
  );
  assert.ok(
    kinds[1].length > 0 && kinds[1].every((k) => k === "intent"),
    "the second call names intents only",
  );
  const parents = async () => {
    const rows = (
      await client.query<{ q: string; p: string; pl: string; d: string }>(
        `select c.members->>0 as q, p.id::text as p, p.label as pl, d.label as d from intent_clusters c
         join intent_clusters p on p.id = c.parent_id left join intent_clusters d on d.id = p.parent_id
        where c.level = 0`,
      )
    ).rows;
    const of = (start: string) => rows.find((r) => r.q.startsWith(start))!;
    return { ada: of("give Ada"), chen: of("put Chen"), create: of("create") };
  };
  const keyed = await parents();
  assert.equal(
    keyed.ada.p,
    keyed.chen.p,
    "both checklist asks share one intent, within the run that keyed them",
  );
  assert.match(
    keyed.ada.pl,
    /^intent c\d+$/,
    "and that intent is named by the model in the same run",
  );
  assert.match(keyed.ada.d, /checklist/i);
  assert.notEqual(keyed.ada.p, keyed.create.p);
  assert.equal(
    await count(
      client,
      "select count(*)::int as n from intent_clusters where level = 0 and llm_action is not null and llm_object is not null",
    ),
    3,
  );

  // Keys off: the rules' grouping comes back on the next run; the keys stay, unread.
  await client.exec("update intent_engine_state set clustered_through = null, named_at = null");
  await runIntentEngine(
    PROJECT_ID,
    deps(db, {
      frames: true,
      llmKeys: false,
      nameDeps: () => ({ model: "test-model", complete, maxNames: 50 }),
    }),
  );
  const rules = await parents();
  assert.notEqual(rules.ada.p, rules.chen.p, '"give" and "put" are no verbs the rules know');
  assert.equal(
    await count(
      client,
      "select count(*)::int as n from intent_clusters where level = 0 and llm_action is not null and llm_object is not null",
    ),
    3,
  );
});

test("a run past its page budget queues its follow-up; one past its time budget does too", async () => {
  const { db } = await setup();
  await ingest(db, [...turn("create task", "create_task"), ...turn("list tasks", "list_tasks")]);
  const queued: string[] = [];
  const enqueue = async (p: string) => {
    queued.push(p);
    return { id: "job-2" };
  };
  const paged = await runIntentEngine(
    PROJECT_ID,
    deps(db, { pageLimit: 1, maxPages: 1, enqueueClusterIntentsJob: enqueue }),
  );
  assert.equal(paged.pages, 1);
  assert.equal(paged.continued, true);
  const timed = await runIntentEngine(
    PROJECT_ID,
    deps(db, { timeBudgetMs: 0, enqueueClusterIntentsJob: enqueue }),
  );
  assert.equal(timed.pages, 0);
  assert.equal(timed.continued, true);
  assert.deepEqual(queued, [PROJECT_ID, PROJECT_ID]);
});

test("a run that finds another one holding the project's lock stops at once: busy, nothing read", async () => {
  const calls: string[] = [];
  const busyTx = {
    execute: async (query: unknown) => {
      calls.push("execute");
      void query;
      return { rows: [{ locked: false }] };
    },
  };
  const busyDb = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(busyTx),
  } as unknown as EngineDb;
  const listed: string[] = [];
  const result = await runIntentEngine(PROJECT_ID, {
    db: busyDb,
    frames: false,
    llmKeys: false,
    seed: false,
    nameDeps: () => ({ model: "m", complete: null, maxNames: 20 }),
    listEvents: async () => {
      listed.push("events");
      return [];
    },
    loadCatalogTools: async () => [],
    trackServerEvent: async () => {},
    enqueueClusterIntentsJob: async () => null,
  });
  assert.equal(result.outcome, "busy");
  assert.equal(result.busy, true);
  assert.deepEqual(listed, [], "no page is read without the lock");
  assert.deepEqual(calls, ["execute", "execute"], "the timeouts, then the try");
});

test("the hour's naming pass is claimed by one run; a second claim within the hour fails", async () => {
  const { client, db } = await setup();
  await client.exec(`insert into intent_engine_state (project_id) values ('${PROJECT_ID}')`);
  const now = new Date("2026-10-20T12:00:00Z");
  assert.equal(await claimNamingSlot(PROJECT_ID, now, 3_600_000, db as unknown as EngineDb), true);
  assert.equal(
    await claimNamingSlot(
      PROJECT_ID,
      new Date(now.getTime() + 10 * 60_000),
      3_600_000,
      db as unknown as EngineDb,
    ),
    false,
  );
  assert.equal(
    await claimNamingSlot(
      PROJECT_ID,
      new Date(now.getTime() + 61 * 60_000),
      3_600_000,
      db as unknown as EngineDb,
    ),
    true,
  );
});

test("a turn's message is still found when one event of the page has a wild clock", async () => {
  const { client, db } = await setup();
  await ingest(
    db,
    turn("reconcile payouts", "reconcile_payouts", "please reconcile last month's payouts"),
  );
  // A drifted client clock on the search: decades off.
  await client.exec(
    "update trace_events set occurred_at = '1990-01-01T00:00:00Z' where type = 'search'",
  );
  const rows = await listFoldableTraceEvents(PROJECT_ID, new Date(0), db, 5_000, 0, {
    userMessages: true,
  });
  assert.ok(
    rows.some((r) => (r.type as string) === "turn_start"),
    "the lookup stays around the page's receipt, not 1990",
  );
});

test("queueing: one queued run per project, ingest pacing, and the cron safety net", async () => {
  const { client, db } = await setup();
  const {
    enqueueClusterIntentsJob,
    enqueueDueIntentEngineRuns,
    listProjectsWithUnclusteredEvents,
  } = await import("@/lib/readings/intent-engine/jobs");
  const due = () =>
    listProjectsWithUnclusteredEvents(db as never).then((rows) => rows.map((r) => r.id));
  const safetyNet = () =>
    enqueueDueIntentEngineRuns({
      listProjectsWithUnclusteredEvents: () => listProjectsWithUnclusteredEvents(db as never),
      enqueueClusterIntentsJob: (p) => enqueueClusterIntentsJob(p, db as never),
    });

  // Asks older than the commit lag, in a project the engine has never met: not a candidate.
  await ingest(db, turn("create task", "create_task"));
  await client.exec("update trace_events set received_at = now() - interval '2 minutes'");
  assert.deepEqual(
    await due(),
    [],
    "the safety net only revisits projects with a state row or a job",
  );

  // Ingest queues once; a second queue while one is queued is coalesced.
  assert.ok(await enqueueClusterIntentsJob(PROJECT_ID, db as never));
  assert.equal(
    await enqueueClusterIntentsJob(PROJECT_ID, db as never),
    null,
    "one queued job at most",
  );
  assert.deepEqual(await due(), [], "a queued job satisfies the safety net");

  // The job ran: now the project is a candidate, but ingest pacing holds a fresh queue back.
  await client.exec(
    "update jobs set status = 'done', finished_at = now() where kind = 'cluster_intents'",
  );
  assert.deepEqual(await due(), [PROJECT_ID]);
  assert.equal(
    await enqueueClusterIntentsJob(PROJECT_ID, db as never, { minIntervalMs: 60_000 }),
    null,
    "paced: a run just finished",
  );

  // The safety net ignores the pacing.
  assert.equal((await safetyNet()).enqueued, 1);
  assert.equal(
    await count(
      client,
      "select count(*)::int as n from jobs where kind = 'cluster_intents' and status = 'queued'",
    ),
    1,
  );

  // A run that errored in the past hour backs the safety net off.
  await client.exec(
    "update jobs set status = 'error', finished_at = now() where kind = 'cluster_intents' and status = 'queued'",
  );
  assert.deepEqual(await due(), [], "error backoff");

  // Caught up: the cursor stands at the newest ask, so nothing is due until a newer one lands.
  await client.exec("delete from jobs where kind = 'cluster_intents'");
  const run = await runIntentEngine(PROJECT_ID, deps(db));
  assert.equal(run.outcome, "clustered");
  assert.deepEqual(await due(), [], "caught up");
  await ingest(db, turn("list tasks", "list_tasks"));
  await client.exec(
    "update trace_events set received_at = now() - interval '1 minute' where received_at > now() - interval '1 minute'",
  );
  assert.deepEqual(await due(), [PROJECT_ID], "an ask past the cursor and the commit lag is due");
});

test("retention: idle clusters and their assignments expire, under the lock, a bounded batch at a time", async () => {
  const { client, db } = await setup();
  await ingest(db, [...turn("create task", "create_task"), ...turn("book a meeting room")]);
  await runIntentEngine(PROJECT_ID, deps(db));
  const { expireIntentEngineClusters } = await import("@/lib/readings/intent-engine/jobs");
  // The fixtures' asks happened at 1_790_000_000_000; ten days on, none is idle.
  const now = new Date(1_790_000_000_000 + 10 * 86_400_000);
  assert.equal(await expireIntentEngineClusters({ now }, db as never), 0, "nothing is idle yet");
  await client.exec(
    "update intent_clusters set last_ts = 1 where level = 0 and members @> '[\"book a meeting room\"]'",
  );
  assert.equal(await expireIntentEngineClusters({ now }, db as never), 1);
  assert.equal(
    await count(client, "select count(*)::int as n from intent_clusters where level = 0"),
    1,
  );
  assert.equal(
    await count(client, "select count(*)::int as n from intent_cluster_assignments"),
    1,
    "its assignment went with it",
  );
});
