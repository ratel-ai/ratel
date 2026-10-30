import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { ToolRegistry } from "@ratel-ai/sdk";
import { drizzle } from "drizzle-orm/pglite";
import { RATEL, RATEL_SEARCH } from "@/lib/ingest/otlp/constants";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveRatelSearches } from "@/lib/ingest/otlp/derive-search";
import { deriveToolInvocations } from "@/lib/ingest/otlp/derive-tools";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { deterministicEventId, parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  type FoldJobDeps,
  foldProjectIntentGraph,
  IntentGraphCapExceededError,
} from "@/lib/readings/intent-graph/fold-job";
import {
  advanceIntentGraphFoldCursor,
  enqueueFoldIntentGraphJob,
  getIntentGraph,
  getIntentGraphFoldCursor,
  type IntentGraphDb,
  listFoldableTraceEvents,
  listIntentGraphRuntimeStatus,
  listLastFoldedAsks,
  listTraceEventHitsForEvents,
  putIntentGraph,
  syncIntentGraphLiveFromStatus,
  upsertIntentGraphShadowTurns,
} from "@/lib/readings/intent-graph/queries";
import { CLOUD_INTENT_GRAPH_KEY } from "@/lib/readings/intent-types/wire";

/** The two registries the match-quality replay would build over a tool corpus. */
function shadowOver(corpus: ReadonlyArray<{ entryId: string; name: string; searchable: string }>) {
  const registry = () => {
    const r = new ToolRegistry();
    for (const entry of corpus) {
      void r.register({
        id: entry.entryId,
        name: entry.name,
        description: entry.searchable,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      });
    }
    return r;
  };
  return { plain: registry(), boosted: registry() };
}

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type Db = IntentGraphDb &
  Parameters<typeof insertTraceEvents>[2] &
  Parameters<typeof enqueueFoldIntentGraphJob>[1];

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
    source_id: "acme-app",
    event_id: `evt-${seq}`,
    ...body,
  };
}

function turn(query: string, tool: string, over: Record<string, unknown> = {}) {
  const turnId = `turn-${seq + 1}`;
  return [
    envelope({
      type: "search",
      query,
      origin: "agent",
      top_k: 2,
      hits: [
        { tool_id: "docker_build", score: 0.6 },
        { tool_id: tool, score: 0.5 },
      ],
      turn_id: turnId,
      ...over,
    }),
    envelope({ type: "invoke_start", tool_id: tool, turn_id: turnId, ...over }),
  ];
}

async function ingest(db: Db, events: Record<string, unknown>[]): Promise<void> {
  const { valid, rejected } = parseTraceEvents(events);
  assert.equal(rejected.length, 0);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((e) => ({ ...e, ingestSource: "runtime" })),
    db,
    {
      intentGraphRuntimeStatus: true,
      // As the events route wires it: a runtime's ranking-status report moves its graph's live period.
      syncIntentGraphLive: (p, tx) => syncIntentGraphLiveFromStatus(p, tx as never),
    },
  );
}

function deps(db: Db, over: Partial<FoldJobDeps> = {}): Partial<FoldJobDeps> {
  const tracked: unknown[] = [];
  return {
    db: db as never,
    getCursor: (p, tx) => getIntentGraphFoldCursor(p, tx ?? db),
    advanceCursor: (p, t, tx) => advanceIntentGraphFoldCursor(p, t, tx ?? db),
    listEvents: (p, since, tx, limit, lag) =>
      listFoldableTraceEvents(p, since, tx ?? db, limit, lag),
    // Rows are ingested a moment before the fold reads them; production waits out an ingest transaction.
    commitLagMs: 0,
    listHits: (ids, tx) => listTraceEventHitsForEvents(ids, tx ?? db),
    listLastFoldedAsks: (p, ids, cursor, tx) => listLastFoldedAsks(p, ids, cursor, tx ?? db),
    getIntentGraph: (p, k, tx) => getIntentGraph(p, k, tx ?? db),
    putIntentGraph: (input, tx) => putIntentGraph(input, tx ?? db),
    loadShadow: async () => null,
    upsertShadowTurns: (p, k, turns, liveAt, tx) =>
      upsertIntentGraphShadowTurns(p, k, turns, liveAt, tx ?? db),
    syncLive: (p, tx) => syncIntentGraphLiveFromStatus(p, tx ?? db),
    listRuntimeStatus: (p) => listIntentGraphRuntimeStatus(p, db),
    enqueueFoldIntentGraphJob: (p) => enqueueFoldIntentGraphJob(p, db),
    trackServerEvent: async (...args) => {
      tracked.push(args);
    },
    ...over,
  };
}

test("first run seeds a cloud graph from stored events and sets the cursor to the last received_at", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    ...turn("why is the build broken", "gh_run_list"),
    ...turn("send the weekly report", "send_email"),
  ]);

  const result = await foldProjectIntentGraph(PROJECT_ID, deps(db));

  assert.equal(result.outcome, "folded");
  assert.equal(result.eventsFolded, 4);
  assert.equal(result.clusterCount, 2);
  const row = await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db);
  assert.ok(row);
  assert.equal(row.producer, "cloud");
  assert.equal(row.clusterCount, 2);
  assert.equal(row.model, null, "a cloud graph is lexical");
  const projection = await client.query<{ n: number }>(
    `select count(*)::int as n from intent_graph_edges where graph_key = '${CLOUD_INTENT_GRAPH_KEY}'`,
  );
  assert.equal(projection.rows[0]?.n, 2);
  // Every source also gets its own graph, learned from its rows alone.
  const perSource = await getIntentGraph(PROJECT_ID, "cloud/acme-app", db);
  assert.equal(perSource?.producer, "cloud");
  assert.equal(perSource?.clusterCount, 2, "both turns came from the one source");
  assert.equal(perSource?.rev, row.rev);
  const cursor = await getIntentGraphFoldCursor(PROJECT_ID, db);
  const maxReceived = await client.query<{ t: string }>(
    `select max(received_at)::text as t from trace_events where project_id = '${PROJECT_ID}'`,
  );
  assert.equal(cursor, maxReceived.rows[0]!.t, "the cursor keeps Postgres's microseconds");
});

test("a rerun with nothing new is a no-op that leaves rev and cursor alone", async () => {
  const { db } = await setup();
  await ingest(db, turn("why is the build broken", "gh_run_list"));
  const first = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  const cursor = await getIntentGraphFoldCursor(PROJECT_ID, db);

  const second = await foldProjectIntentGraph(PROJECT_ID, deps(db));

  assert.equal(second.outcome, "caught_up");
  assert.equal(second.pages, 0);
  assert.equal((await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db))?.rev, first.rev);
  assert.equal(await getIntentGraphFoldCursor(PROJECT_ID, db), cursor);
});

test("new events after the cursor fold onto the stored graph and bump its rev under If-Match", async () => {
  const { db } = await setup();
  await ingest(db, turn("why is the build broken", "gh_run_list"));
  const first = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  // A later ingest gets a later received_at.
  await new Promise((r) => setTimeout(r, 5));
  await ingest(db, turn("send the weekly report", "send_email"));

  const second = await foldProjectIntentGraph(PROJECT_ID, deps(db));

  assert.equal(second.outcome, "folded");
  assert.equal(second.eventsFolded, 2);
  assert.ok(second.rev! > first.rev!);
  const row = await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db);
  assert.equal(row?.clusterCount, 2);
  assert.equal(row?.rev, second.rev);
});

test("a graph over the store's byte cap errors the job before any write and leaves the cursor untouched", async () => {
  const { db } = await setup();
  await ingest(db, turn("why is the build broken", "gh_run_list"));

  // The real check, with the cap shrunk below what one learned turn serializes
  // to. The validator's cluster cap is the other store cap the fold applies,
  // but the SDK's learner bounds clusters itself when it loads a base graph,
  // so a fold cannot reach it; the byte cap is the one a fold can cross.
  let puts = 0;
  const shrunk = deps(db, { maxGraphBytes: 64 });
  const put = shrunk.putIntentGraph!;
  shrunk.putIntentGraph = (input, tx) => {
    puts += 1;
    return put(input, tx);
  };
  await assert.rejects(foldProjectIntentGraph(PROJECT_ID, shrunk), (error: unknown) => {
    assert.ok(error instanceof IntentGraphCapExceededError);
    assert.match(error.message, /byte_size: exceeds 64/);
    return true;
  });
  assert.equal(puts, 0, "the cap is checked before the store is asked");
  assert.equal(await getIntentGraphFoldCursor(PROJECT_ID, db), null);
  assert.equal(await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db), null);

  // Under the cap, the same rows fold.
  const ok = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(ok.outcome, "folded");
});

test("a backlog larger than the page budget continues in a freshly enqueued job", async () => {
  const { client, db } = await setup();
  await ingest(db, [...turn("a", "t1"), ...turn("b", "t2"), ...turn("c", "t3")]);

  const result = await foldProjectIntentGraph(PROJECT_ID, deps(db, { pageLimit: 2, maxPages: 1 }));

  assert.equal(result.pages, 1);
  assert.equal(result.continued, true);
  const queued = await client.query<{ n: number }>(
    `select count(*)::int as n from jobs where kind = 'fold_intent_graph' and status = 'queued'`,
  );
  assert.equal(queued.rows[0]?.n, 1);
});

test("a search and its invoke in the same millisecond pair even when the invoke's row id sorts first", async () => {
  const { db } = await setup();
  // Row ids hash the client event id, so pick client ids whose invoke row sorts
  // before its search row; with an id-only tie-break the learner would see the
  // invoke first and drop it.
  let searchId = "";
  let invokeId = "";
  for (let n = 0; ; n += 1) {
    searchId = `same-ms-search-${n}`;
    invokeId = `same-ms-invoke-${n}`;
    if (deterministicEventId(PROJECT_ID, invokeId) < deterministicEventId(PROJECT_ID, searchId))
      break;
  }
  const ts = 1_790_000_100_000;
  await ingest(db, [
    {
      ...envelope({
        type: "search",
        query: "is the build green",
        origin: "agent",
        top_k: 1,
        turn_id: "t-same",
        hits: [{ tool_id: "gh_run_list", score: 0.5 }],
      }),
      ts,
      event_id: searchId,
    },
    {
      ...envelope({ type: "invoke_start", tool_id: "gh_run_list", turn_id: "t-same" }),
      ts,
      event_id: invokeId,
    },
  ]);

  const result = await foldProjectIntentGraph(PROJECT_ID, deps(db));

  assert.equal(result.outcome, "folded");
  const row = await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db);
  assert.equal(row?.rev, 1, "the turn was learned");
  assert.equal(row?.clusterCount, 1);
});

test("each runtime source gets its own cloud graph from its events alone, beside the merged one", async () => {
  const { db } = await setup();
  await ingest(db, [
    ...turn("why is the build broken", "gh_run_list"),
    ...turn("send the weekly report", "send_email", { source_id: "billing-agent" }),
  ]);

  await foldProjectIntentGraph(PROJECT_ID, deps(db));

  const merged = await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db);
  const app = await getIntentGraph(PROJECT_ID, "cloud/acme-app", db);
  const billing = await getIntentGraph(PROJECT_ID, "cloud/billing-agent", db);
  assert.equal(merged?.clusterCount, 2);
  assert.equal(app?.clusterCount, 1);
  assert.equal(billing?.clusterCount, 1);
  assert.deepEqual(
    [app, billing].map((g) => g?.document.intents.flatMap((i) => Object.keys(i.tools))),
    [["gh_run_list"], ["send_email"]],
  );
});

/**
 * A plain agent trace, as the OTLP route derives it: one chat span carrying
 * the user's ask (content capture on) and one tool-call span per tool. No
 * Ratel SDK anywhere.
 */
let traceSeq = 0;
/** The fold a minute on: every OTLP trace in the store has gone quiet by then. */
function later(db: Db, over: Partial<FoldJobDeps> = {}): Partial<FoldJobDeps> {
  return deps(db, { now: () => new Date(Date.now() + 61_000), ...over });
}

function otlpTurn(ask: string, tools: string[], service = "pm-agent", prompt = true) {
  traceSeq += 1;
  const traceId = traceSeq.toString(16).padStart(32, "0");
  return otlpSpans(traceId, ask, tools, service, prompt);
}

function otlpSpans(
  traceId: string,
  ask: string,
  tools: string[],
  service = "pm-agent",
  prompt = true,
  conversation = true,
  failing: ReadonlySet<string> = new Set(),
) {
  const t0 = 1_790_000_000_000 + traceSeq * 10;
  const span = (
    name: string,
    spanId: string,
    attributes: Record<string, string>,
    offset: number,
  ): DecodedSpan => ({
    traceId,
    spanId: spanId.padStart(16, "0"),
    parentSpanId: null,
    name,
    kind: 1,
    startUnixMs: t0 + offset,
    endUnixMs: t0 + offset + 1,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": service },
    scopeName: null,
  });
  const spans = [
    span(
      "chat",
      "1",
      {
        "gen_ai.operation.name": "chat",
        ...(conversation ? { "gen_ai.conversation.id": `conv-${traceSeq}` } : {}),
        ...(prompt
          ? {
              "gen_ai.input.messages": JSON.stringify([
                { role: "user", parts: [{ type: "text", content: ask }] },
              ]),
            }
          : {}),
      },
      0,
    ),
    // The agent loop calls the model again after each tool, with the same ask.
    span(
      "chat",
      "9",
      {
        "gen_ai.operation.name": "chat",
        ...(conversation ? { "gen_ai.conversation.id": `conv-${traceSeq}` } : {}),
        ...(prompt
          ? {
              "gen_ai.input.messages": JSON.stringify([
                { role: "user", parts: [{ type: "text", content: ask }] },
              ]),
            }
          : {}),
      },
      5,
    ),
    ...tools.map((tool, i) => ({
      ...span(
        `execute_tool ${tool}`,
        String(i + 2),
        {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool,
          ...(conversation ? { "gen_ai.conversation.id": `conv-${traceSeq}` } : {}),
        },
        i + 2,
      ),
      statusCode: failing.has(tool) ? 2 : 0,
    })),
  ];
  return [...deriveModelCalls(spans), ...deriveToolInvocations(spans)].map((row) => ({
    ...row,
    ingestSource: "otlp" as const,
  }));
}

test("a project without the Ratel SDK gets a graph from its traces: the ask once per trace, the tools it called as edges", async () => {
  const { client, db } = await setup();
  await insertTraceEvents(
    PROJECT_ID,
    [
      ...otlpTurn("find my open tasks", ["find_task"]),
      ...otlpTurn("find my open tasks for this week", ["find_task", "list_sprints"]),
      ...otlpTurn("send the weekly report", ["send_email"], "mailer"),
      ...otlpTurn("nothing to learn from", ["find_task"], "pm-agent", false),
    ],
    db,
  );

  const fresh = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(fresh.outcome, "caught_up", "a trace just received may still be exporting: held");
  assert.equal(
    fresh.eventsHeld,
    11,
    "every foldable row: the model calls without a prompt are not read",
  );

  const result = await foldProjectIntentGraph(PROJECT_ID, later(db));
  assert.equal(result.outcome, "folded");
  // 3 asks (one per trace with a prompt) + 5 tool calls; the second model call of each trace repeats
  // the ask, and the trace without a prompt has no ask, so its tool call pairs with nothing.
  assert.equal(result.eventsFolded, 8);

  const merged = await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db);
  const pm = await getIntentGraph(PROJECT_ID, "cloud/pm-agent", db);
  const mailer = await getIntentGraph(PROJECT_ID, "cloud/mailer", db);
  assert.equal(merged?.clusterCount, 2, "the two task asks cluster, the mail ask stands alone");
  assert.equal(pm?.clusterCount, 1);
  assert.equal(mailer?.clusterCount, 1);
  const taskCluster = pm!.document.intents[0]!;
  assert.deepEqual(Object.keys(taskCluster.tools).sort(), ["find_task", "list_sprints"]);
  assert.equal(taskCluster.tools.find_task, 2, "one credit per trace, not per model call");
  assert.deepEqual(taskCluster.members, ["find my open tasks", "find my open tasks for this week"]);

  // The cursor moved past every OTLP row, so a rerun is a no-op.
  const again = await foldProjectIntentGraph(PROJECT_ID, later(db));
  assert.equal(again.outcome, "caught_up");
  const stored = await client.query<{ n: number }>(
    `select count(*)::int as n from trace_events where ingest_source = 'otlp'`,
  );
  assert.ok(stored.rows[0]!.n >= 11);
});

test("a trace whose tool spans are exported before its model call, in their own batch, is learned whole", async () => {
  const { db } = await setup();
  traceSeq += 1;
  const traceId = traceSeq.toString(16).padStart(32, "0");
  // The tool span ends first and carries no conversation id of its own; the
  // root span that would resolve one is not in either batch.
  const rows = otlpSpans(
    traceId,
    "find my open tasks",
    ["find_task", "list_sprints"],
    "pm-agent",
    true,
    false,
  );
  const tools = rows.filter((r) => r.type !== "otlp_model_call");
  const asks = rows.filter((r) => r.type === "otlp_model_call");
  assert.equal(tools.length, 2);
  await insertTraceEvents(PROJECT_ID, tools, db);

  const first = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(first.outcome, "caught_up", "a tool call keeps its trace open");
  assert.equal(first.eventsHeld, 2);
  assert.equal(await getIntentGraphFoldCursor(PROJECT_ID, db), null);

  await insertTraceEvents(PROJECT_ID, asks, db);
  const still = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(still.outcome, "caught_up", "still fresh");

  const done = await foldProjectIntentGraph(PROJECT_ID, later(db));
  assert.equal(done.outcome, "folded");
  assert.equal(done.eventsHeld, 0);
  assert.equal(
    done.eventsFolded,
    3,
    "the ask and both tool calls; the repeated ask is not learned again",
  );
  const graph = await getIntentGraph(PROJECT_ID, "cloud/pm-agent", db);
  assert.equal(graph?.clusterCount, 1);
  assert.deepEqual(graph!.document.intents[0]!.tools, { find_task: 1, list_sprints: 1 });
  assert.deepEqual(graph!.document.intents[0]!.members, ["find my open tasks"]);
});

test("a trace folded in two passes does not learn its repeated ask again", async () => {
  // The agent paused past the hold grace between its first tool and its next
  // model call, so the first pass folded the ask and the first tool, and the
  // second pass sees the loop's repeat of the same ask.
  const { db } = await setup();
  traceSeq += 1;
  const traceId = traceSeq.toString(16).padStart(32, "0");
  const rows = otlpSpans(traceId, "find my open tasks", ["find_task", "list_sprints"], "pm-agent");
  const firstAsk = rows.find((r) => r.type === "otlp_model_call")!;
  const repeat = rows.filter((r) => r.type === "otlp_model_call")[1]!;
  const [findTask, listSprints] = rows.filter((r) => r.type !== "otlp_model_call");
  await insertTraceEvents(PROJECT_ID, [firstAsk, findTask!], db);
  const first = await foldProjectIntentGraph(PROJECT_ID, later(db));
  assert.equal(first.outcome, "folded");
  assert.equal(first.eventsFolded, 2);
  assert.equal(first.eventsRepeated, 0);

  await insertTraceEvents(PROJECT_ID, [repeat, listSprints!], db);
  const second = await foldProjectIntentGraph(PROJECT_ID, later(db));
  assert.equal(second.outcome, "folded");
  assert.equal(second.eventsRepeated, 1, "the repeat was learned in the first pass");
  const graph = await getIntentGraph(PROJECT_ID, "cloud/pm-agent", db);
  assert.equal(graph?.clusterCount, 1);
  const cluster = graph!.document.intents[0]!;
  assert.deepEqual(cluster.members, ["find my open tasks"]);
  assert.equal(cluster.support, 1, "one ask, learned once");
  // Known limit: the tool call whose ask was folded in the earlier pass has no
  // open turn to pair with in this one, so it is not credited.
  assert.deepEqual(cluster.tools, { find_task: 1 });
});

test("a tool call that failed is still the tool the agent chose, and a long ask is learned as the exporter capped it", async () => {
  const { db } = await setup();
  const longAsk = `find every task that mentions ${"the quarterly planning review ".repeat(60)}`;
  assert.ok(longAsk.length > 1_000);
  traceSeq += 1;
  const traceId = traceSeq.toString(16).padStart(32, "0");
  const rows = otlpSpans(
    traceId,
    longAsk,
    ["find_task", "list_sprints"],
    "pm-agent",
    true,
    true,
    new Set(["list_sprints"]),
  );
  assert.deepEqual(
    rows.filter((r) => r.type !== "otlp_model_call").map((r) => r.type),
    ["invoke_end", "invoke_error"],
  );
  await insertTraceEvents(PROJECT_ID, rows, db);

  const result = await foldProjectIntentGraph(PROJECT_ID, later(db));
  assert.equal(result.outcome, "folded");
  assert.equal(result.eventsFolded, 3, "the ask and both tool calls, the failed one included");
  const graph = await getIntentGraph(PROJECT_ID, "cloud/pm-agent", db);
  const cluster = graph!.document.intents[0]!;
  assert.deepEqual(
    cluster.tools,
    { find_task: 1, list_sprints: 1 },
    "a failed call is what the agent reached for; the graph learns the choice",
  );
  assert.equal(cluster.members.length, 1);
  assert.equal(
    cluster.members[0]!.length,
    1_000,
    "the member is the prompt as derivation capped it",
  );
  assert.equal(cluster.members[0], longAsk.slice(0, 1_000));
});

test("a runtime exporting its searches over OTLP stays on the runtime lane and pairs by its own session", async () => {
  const { db } = await setup();
  const traceId = "f".repeat(32);
  const searchSpan = (spanId: string, query: string, offset: number): DecodedSpan => ({
    traceId,
    spanId: spanId.padStart(16, "0"),
    parentSpanId: null,
    name: RATEL_SEARCH,
    kind: 1,
    startUnixMs: 1_790_000_000_000 + offset,
    endUnixMs: 1_790_000_000_001 + offset,
    attributes: {
      [RATEL.searchQuery]: query,
      [RATEL.searchTarget]: "tools",
      [RATEL.origin]: "agent",
      [RATEL.searchTopK]: 1,
    },
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "sdk-over-otel" },
    scopeName: null,
  });
  const searches = deriveRatelSearches([
    searchSpan("1", "find my open tasks", 0),
    searchSpan("2", "close the sprint", 10),
  ]);
  assert.equal(searches.length, 2);
  // The runtime's invokes name the trace as their session, as its searches do.
  const invoke = (tool: string, offset: number) =>
    envelope({
      type: "invoke_start",
      tool_id: tool,
      session_id: traceId,
      source_id: "sdk-over-otel",
      ts: 1_790_000_000_000 + offset,
    });
  await insertTraceEvents(PROJECT_ID, [searches[0]!], db);
  await ingest(db, [invoke("find_task", 5)]);
  await insertTraceEvents(PROJECT_ID, [searches[1]!], db);
  await ingest(db, [invoke("close_sprint", 15)]);

  const result = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(result.outcome, "folded");
  assert.equal(result.eventsHeld, 0, "no trace hold on this lane");
  assert.equal(
    result.eventsFolded,
    4,
    "both searches learned: no one-ask-per-trace rule on this lane",
  );
  const graph = await getIntentGraph(PROJECT_ID, "cloud/sdk-over-otel", db);
  assert.equal(graph?.clusterCount, 2);
});

test("a turn split across two ingest batches is held, then folded whole when its invoke arrives", async () => {
  const { db } = await setup();
  await ingest(db, [
    envelope({
      type: "search",
      query: "is the build green",
      origin: "agent",
      top_k: 1,
      turn_id: "t-split",
      hits: [{ tool_id: "gh_run_list", score: 0.5 }],
    }),
  ]);

  const first = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(first.outcome, "caught_up", "nothing foldable yet");
  assert.equal(first.eventsHeld, 1);
  assert.equal(
    await getIntentGraphFoldCursor(PROJECT_ID, db),
    null,
    "the cursor waits with the held search",
  );
  assert.equal(await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db), null);

  await ingest(db, [
    envelope({ type: "invoke_start", tool_id: "gh_run_list", turn_id: "t-split" }),
  ]);
  const second = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(second.outcome, "folded");
  assert.equal(second.eventsHeld, 0);
  assert.equal(
    (await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db))?.rev,
    1,
    "the turn was learned once, whole",
  );
});

test("a search the agent never acted on stops holding the fold once the grace has passed", async () => {
  const { db } = await setup();
  await ingest(db, [
    ...turn("why is the build broken", "gh_run_list"),
    envelope({
      type: "search",
      query: "who is on call",
      origin: "agent",
      top_k: 1,
      turn_id: "t-orphan",
      hits: [],
    }),
  ]);

  const held = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(held.eventsHeld, 3, "one batch: the orphan holds the whole batch while it is fresh");

  const later = await foldProjectIntentGraph(
    PROJECT_ID,
    deps(db, { now: () => new Date(Date.now() + 5 * 60_000) }),
  );
  assert.equal(later.outcome, "folded");
  assert.equal(later.eventsHeld, 0);
  assert.equal(later.rev, 1, "the complete turn is learned; the orphan teaches nothing");
});

test("with a tool catalog the fold stores Cloud's own with-and-without ranking per search, per graph", async () => {
  const { client, db } = await setup();
  const corpus = [
    ["docker_build", "Build a docker image from a Dockerfile"],
    ["gh_run_list", "List CI workflow runs and whether each build passed"],
    ["send_email", "Send an email to a recipient with a subject and body"],
  ].map(([entryId, searchable]) => ({
    entryId: entryId!,
    name: entryId!,
    searchable: searchable!,
  }));
  const withCatalog = deps(db, { loadShadow: async () => shadowOver(corpus) });
  await ingest(db, [
    ...turn("did the build pass on ci", "gh_run_list"),
    ...turn("did the build pass on ci", "gh_run_list"),
  ]);
  await foldProjectIntentGraph(PROJECT_ID, withCatalog);

  const rows = await client.query<{
    graph_key: string;
    invoked_tool_id: string | null;
    live: boolean;
    n: number;
  }>(
    `select graph_key, invoked_tool_id, live, jsonb_array_length(plain_ids) as n
       from intent_graph_shadow_turns where project_id = '${PROJECT_ID}' order by graph_key, occurred_at`,
  );
  assert.deepEqual(
    rows.rows.map((r) => [r.graph_key, r.invoked_tool_id, r.live]),
    [
      ["cloud", "gh_run_list", false],
      ["cloud", "gh_run_list", false],
      ["cloud/acme-app", "gh_run_list", false],
      ["cloud/acme-app", "gh_run_list", false],
    ],
    "two searches, shadowed for the merged graph and the source's own, watching by default",
  );
  assert.ok(rows.rows.every((r) => r.n >= 1));

  // The runtime starts ranking from the graph in its own code and says so:
  // that report is what makes it live, and later searches are marked as served by it.
  await ingest(db, [
    envelope({
      type: "usage_ranking_status",
      status: "active",
      reason: "enabled",
      rev: 2,
      graph_key: "cloud",
      learn: false,
    }),
  ]);
  assert.notEqual((await getIntentGraph(PROJECT_ID, "cloud", db))?.liveAt ?? null, null);
  assert.equal((await getIntentGraph(PROJECT_ID, "cloud/acme-app", db))?.liveAt ?? null, null);
  await ingest(db, turn("did the build pass on ci", "gh_run_list"));
  await foldProjectIntentGraph(PROJECT_ID, withCatalog);
  const live = await client.query<{ graph_key: string; live: boolean }>(
    `select graph_key, live from intent_graph_shadow_turns
      where project_id = '${PROJECT_ID}' order by occurred_at desc, graph_key limit 2`,
  );
  assert.deepEqual(
    live.rows.map((r) => [r.graph_key, r.live]),
    [
      ["cloud", true],
      ["cloud/acme-app", false],
    ],
  );

  // A search from before the runtime went live, folded only now because the
  // fold was behind, is still a watching turn: online is the search's own
  // time, not the fold's.
  const liveAt = (await getIntentGraph(PROJECT_ID, "cloud", db))!.liveAt!;
  const before = liveAt.getTime() - 60_000;
  await ingest(db, [
    {
      ...envelope({
        type: "search",
        query: "did the build pass on ci",
        origin: "agent",
        top_k: 2,
        turn_id: "turn-late",
        hits: [{ tool_id: "gh_run_list", score: 0.5 }],
      }),
      ts: before,
    },
    {
      ...envelope({ type: "invoke_start", tool_id: "gh_run_list", turn_id: "turn-late" }),
      ts: before + 1,
    },
  ]);
  await foldProjectIntentGraph(PROJECT_ID, withCatalog);
  const late = await client.query<{ live: boolean }>(
    `select live from intent_graph_shadow_turns
      where project_id = '${PROJECT_ID}' and graph_key = 'cloud' and occurred_at = to_timestamp(${before} / 1000.0)`,
  );
  assert.deepEqual(
    late.rows.map((r) => r.live),
    [false],
    "folded after going live, searched before it",
  );

  // Once the runtime sends both rankings on a search it changed (`base_hits`),
  // the graph it ranks from takes its word: no replay, live, reported. The
  // source's own graph, which it does not rank from, is still replayed.
  const reportedTurnId = `turn-${seq + 1}`;
  await ingest(db, [
    envelope({
      type: "search",
      query: "did the build pass on ci",
      origin: "agent",
      top_k: 2,
      hits: [
        { tool_id: "gh_run_list", score: 0.9 },
        { tool_id: "docker_build", score: 0.5 },
      ],
      base_hits: [
        { tool_id: "docker_build", score: 0.6 },
        { tool_id: "gh_run_list", score: 0.5 },
      ],
      turn_id: reportedTurnId,
    }),
    envelope({ type: "invoke_start", tool_id: "gh_run_list", turn_id: reportedTurnId }),
  ]);
  await foldProjectIntentGraph(PROJECT_ID, withCatalog);
  const reported = await client.query<{
    graph_key: string;
    live: boolean;
    reported: boolean;
    plain_ids: string[];
    boosted_ids: string[];
  }>(
    `select graph_key, live, reported, plain_ids, boosted_ids from intent_graph_shadow_turns
      where project_id = '${PROJECT_ID}' order by occurred_at desc, graph_key limit 2`,
  );
  assert.deepEqual(
    reported.rows.map((r) => [r.graph_key, r.live, r.reported]),
    [
      ["cloud", true, true],
      ["cloud/acme-app", false, false],
    ],
  );
  assert.deepEqual(reported.rows[0]!.plain_ids, ["docker_build", "gh_run_list"]);
  assert.deepEqual(reported.rows[0]!.boosted_ids, ["gh_run_list", "docker_build"]);
});

test("a fold that creates the graph a runtime already ranks from stores that page's turns as live", async () => {
  // The runtime reported ranking from `cloud` before Cloud had built it (a
  // restart with a cached graph, or a graph created and released). The first
  // fold creates the graph, and its live_at is only set after the write; the
  // turns folded by that same page must still be dated against it.
  const { client, db } = await setup();
  const corpus = [
    ["gh_run_list", "List GitHub Actions runs for a repository"],
    ["docker_build", "Build a container image"],
  ].map(([entryId, searchable]) => ({
    entryId: entryId!,
    name: entryId!,
    searchable: searchable!,
  }));
  const withCatalog = deps(db, { loadShadow: async () => shadowOver(corpus) });
  await ingest(db, [
    envelope({
      type: "usage_ranking_status",
      status: "active",
      reason: "enabled",
      rev: 1,
      graph_key: "cloud",
      learn: false,
    }),
  ]);
  assert.equal(await getIntentGraph(PROJECT_ID, "cloud", db), null, "no graph yet");
  await ingest(db, turn("did the build pass on ci", "gh_run_list"));
  await foldProjectIntentGraph(PROJECT_ID, withCatalog);
  assert.notEqual(
    (await getIntentGraph(PROJECT_ID, "cloud", db))?.liveAt ?? null,
    null,
    "created live",
  );
  const rows = await client.query<{ graph_key: string; live: boolean }>(
    `select graph_key, live from intent_graph_shadow_turns where project_id = '${PROJECT_ID}' order by graph_key`,
  );
  assert.deepEqual(
    rows.rows.map((r) => [r.graph_key, r.live]),
    [
      ["cloud", true],
      ["cloud/acme-app", false],
    ],
  );
});

test("without a tool catalog the fold builds the graph and stores no shadow rows", async () => {
  const { client, db } = await setup();
  await ingest(db, turn("why is the build broken", "gh_run_list"));
  const result = await foldProjectIntentGraph(PROJECT_ID, deps(db));
  assert.equal(result.outcome, "folded");
  const count = await client.query<{ n: number }>(
    `select count(*)::int as n from intent_graph_shadow_turns`,
  );
  assert.equal(count.rows[0]?.n, 0);
});

test("gateway_search rows are never folded even when present", async () => {
  const { db } = await setup();
  await ingest(db, [
    envelope({
      type: "gateway_search",
      query: "why is the build broken",
      origin: "agent",
      top_k: 2,
      hits: 2,
    }),
    ...turn("why is the build broken", "gh_run_list"),
  ]);

  const result = await foldProjectIntentGraph(PROJECT_ID, deps(db));

  assert.equal(result.eventsFolded, 2, "the gateway summary is not one of them");
});

/** Four asks about different records, each invoking the same tool: four lexical fragments of one intent. */
function fragmentedTurns() {
  return [
    ...turn("search tasks about Gemini model upgrade", "search_tasks"),
    ...turn("search tasks by text Ironclad", "search_tasks"),
    ...turn("search tasks about invite workspace", "search_tasks"),
    ...turn("search tasks for Chroma deadline lease", "search_tasks"),
    ...turn("send the weekly report", "send_email"),
  ];
}

test("fragments that agree on their edge are stored as one cluster and the next page folds onto it", async () => {
  const { client, db } = await setup();
  await ingest(db, fragmentedTurns());

  const result = await foldProjectIntentGraph(
    PROJECT_ID,
    deps(db, { compactionOptions: { settleMs: 0 } }),
  );

  assert.equal(result.outcome, "folded");
  assert.equal(result.clustersBeforeCompaction, 5, "the learner seeded one cluster per ask");
  assert.equal(result.clusterCount, 2, "four search_tasks fragments became one");
  assert.equal(result.clustersMerged, 3);
  const row = await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db);
  assert.ok(row);
  assert.equal(row.clusterCount, 2);
  const merged = row.document.intents.find((it) => it.tools.search_tasks !== undefined);
  assert.ok(merged);
  assert.equal(merged.support, 4);
  assert.equal(merged.members.length, 4);
  assert.deepEqual(merged.tools, { search_tasks: 4 });
  assert.ok(merged.members.includes(merged.label), "label recomputed from the merged members");
  const edges = await client.query<{ n: number }>(
    `select count(*)::int as n from intent_graph_edges where graph_key = '${CLOUD_INTENT_GRAPH_KEY}'`,
  );
  assert.equal(edges.rows[0]?.n, 2);
  // The per-source graph is compacted the same way.
  const perSource = await getIntentGraph(PROJECT_ID, "cloud/acme-app", db);
  assert.equal(perSource?.clusterCount, 2);

  // A later ask joins the merged cluster instead of seeding a fifth fragment.
  await ingest(db, turn("search tasks by text Ironclad please", "search_tasks"));
  const again = await foldProjectIntentGraph(
    PROJECT_ID,
    deps(db, { compactionOptions: { settleMs: 0 } }),
  );
  assert.equal(again.clusterCount, 2);
  assert.equal(again.clustersMerged, 0);
  const after = await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db);
  assert.equal(
    after?.document.intents.find((it) => it.tools.search_tasks !== undefined)?.support,
    5,
  );
});

test("a fragment the fold just observed is not absorbed until it has settled", async () => {
  const { db } = await setup();
  await ingest(db, fragmentedTurns());

  // Default gates: every cluster's last_ts is this fold's time, so none has settled.
  const result = await foldProjectIntentGraph(PROJECT_ID, deps(db));

  assert.equal(result.clusterCount, 5);
  assert.equal(result.clustersMerged, 0);
});
