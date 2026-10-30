import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadCatalogTools } from "@/lib/readings/intent-engine/catalog";
import { runIntentEngine } from "@/lib/readings/intent-engine/job";
import { defaultNameDeps } from "@/lib/readings/intent-engine/names-job";
import type { EngineDb } from "@/lib/readings/intent-engine/store";
import { foldProjectIntentGraph } from "@/lib/readings/intent-graph/fold-job";
import {
  advanceIntentGraphFoldCursor,
  getIntentGraph,
  getIntentGraphFoldCursor,
  listFoldableTraceEvents,
  listIntentGraphRuntimeStatus,
  listLastFoldedAsks,
  listTraceEventHitsForEvents,
  putIntentGraph,
  syncIntentGraphLiveFromStatus,
  upsertIntentGraphShadowTurns,
} from "@/lib/readings/intent-graph/queries";
import { CLOUD_INTENT_GRAPH_KEY } from "@/lib/readings/intent-types/wire";

/**
 * The open-source edition's promise (ADR-0030): with no model key set, every reading that
 * can run without one still runs, and nothing leaves the process. The lexical readings (the
 * intent graph fold, the intent engine's clustering) must complete on a seeded database with
 * `fetch` disabled, and the engine's naming step must make no call rather than try.
 * The signal runs and topics extend this when they land.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type Db = EngineDb & Parameters<typeof insertTraceEvents>[2];

async function setup(): Promise<Db> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return drizzle(client, { schema }) as unknown as Db;
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

function turn(query: string, tool: string) {
  const turnId = `turn-${seq + 1}`;
  return [
    envelope({
      type: "search",
      query,
      origin: "agent",
      top_k: 1,
      hits: [{ tool_id: tool, score: 0.5 }],
      turn_id: turnId,
    }),
    envelope({ type: "invoke_start", tool_id: tool, turn_id: turnId }),
  ];
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

/** A `fetch` that fails the test: no reading may call out. */
function withNoNetwork<T>(run: () => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error(`outbound call without a key: ${String(input)}`);
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
    assert.deepEqual(calls, [], "no reading may reach the network without a model key");
  });
}

/** The environment a fresh checkout runs with: no model key of any kind. */
const NO_KEYS: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  DECISION_ENGINE: undefined,
};

test("the graph fold and the engine run on a seeded database with no key and no network", async () => {
  const db = await setup();
  await ingest(db, [
    ...turn("assign this task to emp-1", "assign_task"),
    ...turn("assign this task to emp-2", "assign_task"),
    ...turn("create a task for the release", "create_task"),
    ...turn("why is the build broken", "gh_run_list"),
  ]);

  await withNoNetwork(async () => {
    const fold = await foldProjectIntentGraph(PROJECT_ID, {
      db: db as never,
      commitLagMs: 0,
      getCursor: (p, tx) => getIntentGraphFoldCursor(p, tx ?? db),
      advanceCursor: (p, t, tx) => advanceIntentGraphFoldCursor(p, t, tx ?? db),
      listEvents: (p, since, tx, limit, lag) =>
        listFoldableTraceEvents(p, since, tx ?? db, limit, lag),
      listHits: (ids, tx) => listTraceEventHitsForEvents(ids, tx ?? db),
      listLastFoldedAsks: (p, ids, cursor, tx) => listLastFoldedAsks(p, ids, cursor, tx ?? db),
      getIntentGraph: (p, k, tx) => getIntentGraph(p, k, tx ?? db),
      putIntentGraph: (input, tx) => putIntentGraph(input, tx ?? db),
      upsertShadowTurns: (p, k, turns, liveAt, tx) =>
        upsertIntentGraphShadowTurns(p, k, turns, liveAt, tx ?? db),
      syncLive: (p, tx) => syncIntentGraphLiveFromStatus(p, tx ?? db),
      listRuntimeStatus: (p) => listIntentGraphRuntimeStatus(p, db),
      enqueueFoldIntentGraphJob: async () => null,
      trackServerEvent: async () => {},
    });
    assert.equal(fold.outcome, "folded");
    assert.ok((fold.clusterCount ?? 0) > 0, "the lexical graph is built without a model");
    assert.equal((await getIntentGraph(PROJECT_ID, CLOUD_INTENT_GRAPH_KEY, db))?.producer, "cloud");

    const run = await runIntentEngine(PROJECT_ID, {
      db,
      commitLagMs: 0,
      // The real naming collaborators, read from an environment without a key.
      nameDeps: () => defaultNameDeps(NO_KEYS),
      listEvents: (p, since, tx, limit, lag, options) =>
        listFoldableTraceEvents(p, since, tx ?? db, limit, lag, options),
      listHits: (ids, tx) => listTraceEventHitsForEvents(ids, tx ?? db),
      listLastFoldedAsks: (p, ids, cursor, tx) => listLastFoldedAsks(p, ids, cursor, tx ?? db),
      loadCatalogTools: (p) => loadCatalogTools(p, db as never),
      enqueueClusterIntentsJob: async () => null,
      trackServerEvent: async () => {},
      // Past the hold grace: a search nobody acted on is folded as it is.
      now: () => new Date(Date.now() + 5 * 60_000),
    });
    assert.equal(run.outcome, "clustered");
    assert.ok(run.clusters > 0, "asks are clustered lexically");
    // No key: the naming step is never due, so no call is made and nothing is named.
    assert.equal(defaultNameDeps(NO_KEYS).complete, null, "no completion without a key");
    assert.equal(run.naming.calls, 0);
    assert.equal(run.naming.named, 0);
  });
});
