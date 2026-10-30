import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  expireIntentGraphClusterMembers,
  type IntentGraphMaintenanceDb,
  pruneIntentGraphRevisions,
} from "@/lib/readings/intent-graph/maintenance";
import {
  countIntentGraphs,
  countMissingToolsByGraph,
  getIntentGraph,
  getIntentGraphClusterMembers,
  getIntentGraphDetail,
  type IntentGraphDb,
  listFoldableTraceEvents,
  listIntentGraphSummaries,
  listIntentGraphTopClusters,
  listRecentLearningSources,
  putIntentGraph,
  syncIntentGraphLiveFromStatus,
  touchIntentGraphPull,
} from "@/lib/readings/intent-graph/queries";
import { type IntentGraphDocument, intentGraphContentHash } from "@/lib/readings/intent-types/wire";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE = "billing-agent";

function graph(over: Partial<IntentGraphDocument> = {}): IntentGraphDocument {
  return {
    v: 1,
    built_from_ts: 1753000000000,
    rev: 1,
    intents: [
      {
        id: "intent_0",
        label: "is the build green",
        terms: ["build", "ci"],
        members: ["why is the build broken", "did ci pass"],
        support: 3,
        seeded_support: 1,
        last_ts: 1753000000000,
        tools: { gh_run_list: 2, gh_run_view: 1 },
        skills: { triage: 1 },
      },
      {
        id: "intent_1",
        label: "roll back",
        terms: ["rollback"],
        members: ["roll back the deploy"],
        support: 1,
        tools: { deploy_rollback: 1 },
        skills: {},
      },
    ],
    ...over,
  };
}

async function put(db: IntentGraphDb, doc: IntentGraphDocument, ifMatch: string | null = null) {
  const canonical = JSON.stringify(doc);
  return putIntentGraph(
    {
      projectId: PROJECT_ID,
      sourceId: SOURCE,
      graph: doc,
      contentHash: intentGraphContentHash(doc),
      byteSize: Buffer.byteLength(canonical),
      ifMatch,
    },
    db,
  );
}

async function counts(client: PGlite) {
  const c = await client.query<{ n: number }>(
    `select count(*)::int as n from intent_graph_clusters where project_id = $1`,
    [PROJECT_ID],
  );
  const e = await client.query<{ n: number }>(
    `select count(*)::int as n from intent_graph_edges where project_id = $1`,
    [PROJECT_ID],
  );
  const r = await client.query<{ n: number }>(
    `select count(*)::int as n from intent_graph_revisions where project_id = $1`,
    [PROJECT_ID],
  );
  return { clusters: c.rows[0]?.n ?? 0, edges: e.rows[0]?.n ?? 0, revisions: r.rows[0]?.n ?? 0 };
}

test("first put stores the graph, a revision, and the flattened projection", async () => {
  const { client, db } = await setup();
  const result = await put(db, graph());
  assert.equal(result.outcome, "stored");
  assert.equal(result.rev, 1);

  const row = await getIntentGraph(PROJECT_ID, SOURCE, db);
  assert.ok(row);
  assert.equal(row.producer, "runtime");
  assert.equal(row.rev, 1);
  assert.equal(row.schemaVersion, 1);
  assert.equal(row.model, null);
  assert.equal(row.clusterCount, 2);
  assert.equal(row.builtFromTs.getTime(), 1753000000000);
  assert.deepEqual(row.document, graph());

  assert.deepEqual(await counts(client), { clusters: 2, edges: 4, revisions: 1 });
  const cluster = await client.query<{
    member_count: number;
    support: number;
    seeded_support: number;
    has_centroid: boolean;
    last_ts: string | null;
  }>(
    `select member_count, support, seeded_support, has_centroid, last_ts from intent_graph_clusters where cluster_id = 'intent_0'`,
  );
  assert.equal(cluster.rows[0]?.member_count, 2);
  assert.equal(cluster.rows[0]?.support, 3);
  assert.equal(cluster.rows[0]?.seeded_support, 1);
  assert.equal(cluster.rows[0]?.has_centroid, false);
  assert.ok(cluster.rows[0]?.last_ts);
  const edges = await client.query<{ kind: string; capability_id: string; weight: number }>(
    `select kind, capability_id, weight from intent_graph_edges where cluster_id = 'intent_0' order by kind, capability_id`,
  );
  assert.deepEqual(edges.rows, [
    { kind: "skill", capability_id: "triage", weight: 1 },
    { kind: "tool", capability_id: "gh_run_list", weight: 2 },
    { kind: "tool", capability_id: "gh_run_view", weight: 1 },
  ]);
});

test("an identical resave is unchanged: no new revision, updated_at untouched, received_at moves", async () => {
  const { client, db } = await setup();
  await put(db, graph());
  const before = await getIntentGraph(PROJECT_ID, SOURCE, db);
  const again = await put(db, graph({ rev: 7 }));
  assert.equal(again.outcome, "unchanged");
  assert.equal(again.rev, 1);
  const after = await getIntentGraph(PROJECT_ID, SOURCE, db);
  assert.equal(after?.updatedAt.getTime(), before?.updatedAt.getTime());
  assert.ok((after?.receivedAt.getTime() ?? 0) >= (before?.receivedAt.getTime() ?? 1));
  assert.equal((await counts(client)).revisions, 1);
});

test("a changed graph bumps rev, appends a revision, and fully replaces the projection", async () => {
  const { client, db } = await setup();
  await put(db, graph());
  const changed = graph({
    rev: 2,
    intents: [
      {
        id: "intent_0",
        label: "is the build green",
        terms: ["build"],
        members: ["why is the build broken"],
        support: 4,
        tools: { gh_run_list: 3 },
        skills: {},
      },
    ],
  });
  const result = await put(db, changed);
  assert.equal(result.outcome, "stored");
  assert.equal(result.rev, 2);
  assert.deepEqual(await counts(client), { clusters: 1, edges: 1, revisions: 2 });
  const gone = await client.query(
    `select 1 from intent_graph_clusters where cluster_id = 'intent_1'`,
  );
  assert.equal(gone.rows.length, 0);
});

test("a Cloud-built graph keeps no revision rows; a runtime push still appends one", async () => {
  const { client, db } = await setup();
  const cloud = (over: Partial<Parameters<typeof putIntentGraph>[0]> = {}) =>
    putIntentGraph(
      {
        projectId: PROJECT_ID,
        sourceId: "cloud",
        graph: graph(),
        contentHash: intentGraphContentHash(graph()),
        byteSize: 100,
        ifMatch: null,
        producer: "cloud",
        ...over,
      },
      db,
    );
  assert.equal((await cloud()).outcome, "stored");
  const changed = graph({ rev: 2, intents: [graph().intents[0]!] });
  assert.equal(
    (await cloud({ graph: changed, contentHash: intentGraphContentHash(changed) })).outcome,
    "stored",
  );
  assert.equal(
    (await getIntentGraph(PROJECT_ID, "cloud", db))?.rev,
    2,
    "the graph itself moves on",
  );
  assert.equal((await counts(client)).revisions, 0, "no copy per fold");
  assert.equal((await counts(client)).clusters, 1, "the projection is still rebuilt");

  await put(db, graph());
  assert.equal((await counts(client)).revisions, 1, "the runtime's push keeps its history");
});

test("rev equal but content different is accepted as the next revision", async () => {
  const { client, db } = await setup();
  await put(db, graph({ rev: 5 }));
  const result = await put(db, graph({ rev: 5, built_from_ts: 1753000001000 }));
  assert.equal(result.outcome, "stored");
  assert.equal(result.rev, 6);
  // The served document carries the assigned rev, not the one the client sent.
  const row = await getIntentGraph(PROJECT_ID, SOURCE, db);
  assert.equal(row?.rev, 6);
  assert.equal(row?.document.rev, 6);
  const revision = await client.query<{ rev: number }>(
    `select (document->>'rev')::int as rev from intent_graph_revisions
     where project_id = $1 and graph_key = $2 and rev = 6`,
    [PROJECT_ID, SOURCE],
  );
  assert.equal(revision.rows[0]?.rev, 6);
});

test("a graph sent without rev is stored and served with the assigned rev", async () => {
  const { db } = await setup();
  const first = await put(db, graph({ rev: undefined }));
  assert.equal(first.outcome, "stored");
  assert.equal(first.rev, 0);
  assert.equal((await getIntentGraph(PROJECT_ID, SOURCE, db))?.document.rev, 0);
  const second = await put(db, graph({ rev: undefined, built_from_ts: 1753000001000 }));
  assert.equal(second.outcome, "stored");
  assert.equal(second.rev, 1);
  const row = await getIntentGraph(PROJECT_ID, SOURCE, db);
  assert.equal(row?.rev, 1);
  assert.equal(row?.document.rev, 1);
});

test("a lower rev is stale and writes nothing", async () => {
  const { client, db } = await setup();
  const first = await put(db, graph({ rev: 5 }));
  const result = await put(db, graph({ rev: 4, built_from_ts: 1 }));
  assert.equal(result.outcome, "stale");
  assert.equal(result.rev, 5);
  assert.equal(result.etag, first.etag);
  assert.equal((await counts(client)).revisions, 1);
  assert.equal(
    (await getIntentGraph(PROJECT_ID, SOURCE, db))?.builtFromTs.getTime(),
    1753000000000,
  );
});

test("an If-Match that does not match the stored ETag is stale; a matching one is accepted", async () => {
  const { db } = await setup();
  const first = await put(db, graph());
  const stale = await put(db, graph({ rev: 2, built_from_ts: 2 }), '"somebody-else"');
  assert.equal(stale.outcome, "stale");
  const ok = await put(db, graph({ rev: 2, built_from_ts: 2 }), first.etag);
  assert.equal(ok.outcome, "stored");
});

test("a first write ignores If-Match: there is nothing to clobber", async () => {
  const { db } = await setup();
  const result = await put(db, graph(), '"from-a-previous-life"');
  assert.equal(result.outcome, "stored");
});

test("unknown fields survive the jsonb round trip", async () => {
  const { db } = await setup();
  const doc = graph({
    cluster_policy: { similarity: 0.7, coverage: 0.5 },
    intents: [{ ...graph().intents[0], cohesion: 0.9, surfaced_tools: { gh_run_list: 5 } }],
  });
  const result = await put(db, doc);
  const row = await getIntentGraph(PROJECT_ID, SOURCE, db);
  assert.deepEqual(row?.document, { ...doc, rev: result.rev });
  assert.equal(row?.document.rev, doc.rev, "a first write keeps the client's rev");
});

test("touchIntentGraphPull stamps the project", async () => {
  const { client, db } = await setup();
  const now = new Date("2026-09-15T10:00:00Z");
  await touchIntentGraphPull(PROJECT_ID, now, db);
  const r = await client.query<{ t: string }>(
    `select intent_graph_pulled_at as t from projects where id = $1`,
    [PROJECT_ID],
  );
  assert.equal(new Date(r.rows[0]?.t ?? 0).getTime(), now.getTime());
});

test("a 1,200-cluster graph is chunked into the projection", async () => {
  const { client, db } = await setup();
  const intents = Array.from({ length: 1_200 }, (_, i) => ({
    id: `intent_${i}`,
    label: `q ${i}`,
    terms: [`t${i}`],
    members: [`query number ${i}`],
    support: 1,
    tools: { [`tool_${i}`]: 1, shared_tool: 1 },
    skills: {},
  }));
  const result = await put(db, graph({ intents }));
  assert.equal(result.outcome, "stored");
  assert.deepEqual(await counts(client), { clusters: 1_200, edges: 2_400, revisions: 1 });
});

test("pruning keeps the newest revisions and never the current one", async () => {
  const { client, db } = await setup();
  for (let rev = 1; rev <= 13; rev += 1) {
    await put(db, graph({ rev, built_from_ts: 1753000000000 + rev }));
  }
  assert.equal((await counts(client)).revisions, 13);
  // Make the current row point at the oldest revision, which pruning must spare.
  await client.query(`update intent_graphs set rev = 1 where project_id = $1`, [PROJECT_ID]);
  const pruned = await pruneIntentGraphRevisions({}, db as unknown as IntentGraphMaintenanceDb);
  assert.equal(pruned, 2);
  const left = await client.query<{ rev: number }>(
    `select rev::int from intent_graph_revisions where project_id = $1 order by rev`,
    [PROJECT_ID],
  );
  assert.deepEqual(
    left.rows.map((r) => r.rev),
    [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  assert.equal(await pruneIntentGraphRevisions({}, db as unknown as IntentGraphMaintenanceDb), 0);
});

test("the fold reader stays the commit lag behind now, so a slow ingest transaction cannot commit behind the cursor unseen", async () => {
  const { client, db } = await setup();
  await client.query(
    `insert into trace_events (id, project_id, type, ingest_source, session_id, client_event_id, occurred_at, received_at, payload)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', $1, 'search', 'runtime', 's', 'lag-1', now() - interval '10 seconds', now() - interval '10 seconds', '{}'::jsonb),
            ('aaaaaaaa-aaaa-4aaa-8aaa-000000000002', $1, 'search', 'runtime', 's', 'lag-2', now() - interval '2 minutes', now() - interval '2 minutes', '{}'::jsonb)`,
    [PROJECT_ID],
  );
  const since = new Date(Date.now() - 3_600_000);
  assert.deepEqual(
    (await listFoldableTraceEvents(PROJECT_ID, since, db)).map((r) => r.id),
    ["aaaaaaaa-aaaa-4aaa-8aaa-000000000002"],
  );
  assert.equal(
    (await listFoldableTraceEvents(PROJECT_ID, since, db, undefined, 0)).length,
    2,
    "no lag reads both",
  );
});

test("a cloud graph forgets a cluster unobserved past event retention, members and all; a runtime's own graph is kept", async () => {
  const { client, db } = await setup();
  const now = new Date("2026-10-06T00:00:00Z");
  const day = 86_400_000;
  const stale = { ...graph().intents[0]!, last_ts: now.getTime() - 31 * day };
  const fresh = { ...graph().intents[1]!, last_ts: now.getTime() - 2 * day };
  const undated = { ...graph().intents[1]!, id: "intent_2", members: ["undated ask"] };
  const doc = graph({ rev: 4, intents: [stale, fresh, undated] });
  const cloud = await putIntentGraph(
    {
      projectId: PROJECT_ID,
      sourceId: "cloud",
      graph: doc,
      contentHash: intentGraphContentHash(doc),
      byteSize: Buffer.byteLength(JSON.stringify(doc)),
      ifMatch: null,
      producer: "cloud",
      now,
    },
    db,
  );
  assert.equal(cloud.outcome, "stored");
  // The same clusters pushed by a runtime are its author's to keep.
  await put(db, doc);

  assert.deepEqual(await expireIntentGraphClusterMembers({ now }, db), { graphs: 1, clusters: 1 });
  const after = await getIntentGraph(PROJECT_ID, "cloud", db);
  assert.deepEqual(
    after!.document.intents.map((intent) => intent.id),
    ["intent_1", "intent_2"],
    "a fresh cluster and one the learner never dated stay",
  );
  assert.equal(after!.rev, cloud.rev + 1, "the rewrite is a revision, so a runtime adopts it");
  const projected = await client.query<{ n: number }>(
    `select count(*)::int as n from intent_graph_clusters where project_id = $1 and graph_key = 'cloud'`,
    [PROJECT_ID],
  );
  assert.equal(projected.rows[0]?.n, 2, "the projection follows");
  assert.equal((await getIntentGraph(PROJECT_ID, SOURCE, db))!.document.intents.length, 3);

  assert.deepEqual(
    await expireIntentGraphClusterMembers({ now }, db),
    { graphs: 0, clusters: 0 },
    "nothing left to expire",
  );
});

test("the fold reader maps a plain agent trace to the runtime shape: the ask as a baseline search, the tool spans as invokes, the trace as the turn", async () => {
  const { client, db } = await setup();
  const at = "2026-09-30T10:00:00Z";
  await client.query(
    `insert into trace_events (id, project_id, type, ingest_source, source_id, session_id, trace_id, tool_id, client_event_id, occurred_at, received_at, payload)
     values
       ('e0000000-0000-4000-8000-000000000001', $1, 'otlp_model_call', 'otlp', 'pm-agent', 'conv-1', 'trace-a', null, 'o1', $2, $2, '{"prompt":"find my open tasks"}'::jsonb),
       ('e0000000-0000-4000-8000-000000000002', $1, 'invoke_end', 'otlp', 'pm-agent', 'trace-a', 'trace-a', 'find_task', 'o2', $3, $2, '{}'::jsonb),
       ('e0000000-0000-4000-8000-000000000003', $1, 'invoke_error', 'otlp', 'pm-agent', 'conv-1', 'trace-a', 'list_sprints', 'o3', $4, $2, '{}'::jsonb),
       ('e0000000-0000-4000-8000-000000000004', $1, 'otlp_model_call', 'otlp', 'pm-agent', 'conv-2', 'trace-b', null, 'o4', $2, $2, '{"menu":["find_task"]}'::jsonb),
       ('e0000000-0000-4000-8000-000000000005', $1, 'invoke_end', 'runtime', 'worker-a', 's', null, 'send_email', 'o5', $2, $2, '{}'::jsonb),
       ('e0000000-0000-4000-8000-000000000006', $1, 'search', 'otlp', 'sdk-over-otel', 'trace-c', 'trace-c', null, 'o6', $5, $2, '{}'::jsonb),
       ('e0000000-0000-4000-8000-000000000007', $1, 'otlp_model_call', 'runtime', 'worker-a', 's', null, null, 'o7', $2, $2, '{"prompt":"a loose runtime row"}'::jsonb)`,
    [PROJECT_ID, at, "2026-09-30T10:00:01Z", "2026-09-30T10:00:02Z", "2026-09-30T10:00:03Z"],
  );
  await client.query(
    `update trace_events set query = 'close the sprint' where id = 'e0000000-0000-4000-8000-000000000006'`,
  );
  const rows = await listFoldableTraceEvents(PROJECT_ID, new Date("2026-09-29T00:00:00Z"), db);
  assert.deepEqual(
    rows.map((r) => [r.type, r.lane, r.query, r.origin, r.toolId, r.sessionId, r.turnId, r.topK]),
    [
      // The tool span resolved no conversation id; the pair still keys alike, on the trace.
      ["search", "otlp", "find my open tasks", "baseline", null, "trace-a", "trace-a", 0],
      ["invoke_start", "otlp", null, null, "find_task", "trace-a", "trace-a", null],
      ["invoke_start", "otlp", null, null, "list_sprints", "trace-a", "trace-a", null],
      // An SDK runtime's search exported over OTLP is a runtime-lane row as before.
      ["search", "runtime", "close the sprint", null, null, "trace-c", null, null],
    ],
    "a model call without a prompt, a runtime lane invoke_end and a runtime lane otlp_model_call are not learning events",
  );
});

test("deleting the project cascades to every intent graph table", async () => {
  const { client, db } = await setup();
  await put(db, graph());
  await client.query(`delete from projects where id = $1`, [PROJECT_ID]);
  assert.deepEqual(await counts(client), { clusters: 0, edges: 0, revisions: 0 });
  assert.equal(await getIntentGraph(PROJECT_ID, SOURCE, db), null);
});

test("countIntentGraphs counts a project's stored graphs", async () => {
  const { db } = await setup();
  assert.equal(await countIntentGraphs(PROJECT_ID, db), 0);
  await put(db, graph());
  await put(db, graph({ rev: 2, built_from_ts: 2 }));
  assert.equal(await countIntentGraphs(PROJECT_ID, db), 1, "a resave is the same graph");
  await putIntentGraph(
    {
      projectId: PROJECT_ID,
      sourceId: "other-source",
      graph: graph(),
      contentHash: intentGraphContentHash(graph()),
      byteSize: 10,
      ifMatch: null,
    },
    db,
  );
  assert.equal(await countIntentGraphs(PROJECT_ID, db), 2);
});

test("summaries aggregate edges and members per graph without loading the document", async () => {
  const { client, db } = await setup();
  await put(db, graph());
  await putIntentGraph(
    {
      projectId: PROJECT_ID,
      sourceId: "other-source",
      graph: graph({ rev: 1, intents: [graph().intents[1]] }),
      contentHash: intentGraphContentHash(graph({ intents: [graph().intents[1]] })),
      byteSize: 10,
      ifMatch: null,
      // Strictly after the first graph's write, so it is the newest change.
      now: new Date(Date.now() + 60_000),
    },
    db,
  );
  const rows = await listIntentGraphSummaries(PROJECT_ID, db);
  assert.deepEqual(
    rows.map((r) => [r.graphKey, r.toolEdgeCount, r.skillEdgeCount, r.memberCount, r.clusterCount]),
    [
      ["other-source", 1, 0, 1, 1],
      [SOURCE, 3, 1, 3, 2],
    ],
    "newest change first, then aggregates",
  );
  assert.ok(!("document" in rows[0]));
  const main = rows.find((r) => r.graphKey === SOURCE);
  // clusters with support 3 and 1 -> (1 + 1/3) / 2
  assert.ok(Math.abs((main?.maturity ?? 0) - 2 / 3) < 1e-9, `maturity ${main?.maturity}`);
  const top = await listIntentGraphTopClusters(PROJECT_ID, 1, db);
  assert.deepEqual(
    top.map((t) => [t.graphKey, t.clusterId, t.support]),
    [
      [SOURCE, "intent_0", 3],
      ["other-source", "intent_1", 1],
    ],
    "one strongest cluster per graph",
  );
  await client.query(`delete from intent_graph_edges where graph_key = $1`, ["other-source"]);
  const after = await listIntentGraphSummaries(PROJECT_ID, db);
  assert.equal(
    after.find((r) => r.graphKey === "other-source")?.toolEdgeCount,
    0,
    "no edges is zero, not null",
  );
});

test("detail returns the projection and flags edges the runtime catalog does not know", async () => {
  const { client, db } = await setup();
  assert.equal(await getIntentGraphDetail(PROJECT_ID, "nope", db), null);
  await put(db, graph());
  const before = await getIntentGraphDetail(PROJECT_ID, SOURCE, db);
  assert.ok(before);
  assert.equal(before.clusters.length, 2);
  assert.equal(before.clusters[0]?.clusterId, "intent_0", "support descending");
  assert.ok(!("members" in (before.clusters[0] ?? {})), "the detail read never carries members");
  assert.deepEqual(
    await getIntentGraphClusterMembers(PROJECT_ID, SOURCE, "intent_0", db),
    ["why is the build broken", "did ci pass"],
    "members come from their own per-cluster read",
  );
  assert.equal(await getIntentGraphClusterMembers(PROJECT_ID, SOURCE, "nope", db), null);
  assert.equal(before.edges.length, 4);
  assert.ok(!("document" in before.graph));
  assert.deepEqual([...before.missingCapabilities].sort(), [
    "skill:triage",
    "tool:deploy_rollback",
    "tool:gh_run_list",
    "tool:gh_run_view",
  ]);
  await client.query(
    `insert into runtime_catalog_entries (project_id, kind, entry_id, name, description, searchable_description, searchable_description_overridden, use_cloud_definitions, provenance, content_hash)
     values ($1, 'tool', 'gh_run_list', 'gh_run_list', 'd', 'd', false, false, 'snapshot', 'h'),
            ($1, 'skill', 'gh_run_view', 'gh_run_view', 'd', 'd', false, false, 'snapshot', 'h')`,
    [PROJECT_ID],
  );
  const after = await getIntentGraphDetail(PROJECT_ID, SOURCE, db);
  assert.deepEqual(
    [...(after?.missingCapabilities ?? [])].sort(),
    ["skill:triage", "tool:deploy_rollback", "tool:gh_run_view"],
    "a skill entry does not satisfy a tool edge with the same id",
  );
  // Only entries that an edge of this graph points at, matched per kind: the
  // skill row named gh_run_view has no skill edge, so it is not a capability here.
  assert.deepEqual(Object.keys(after?.capabilities ?? {}), ["tool:gh_run_list"]);
  assert.equal(after?.capabilities["tool:gh_run_list"]?.name, "gh_run_list");
  assert.equal(after?.capabilities["tool:gh_run_list"]?.calls, 0, "no usage counters yet");
  assert.equal(after?.capabilities["tool:gh_run_list"]?.skillId, null);
  assert.equal(
    before.capabilities["tool:gh_run_list"],
    undefined,
    "nothing known before the catalog arrived",
  );
});

async function setup(): Promise<{ client: PGlite; db: IntentGraphDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as IntentGraphDb };
}

test("touching a pull with a graph key stamps that row's pulled_at and no other", async () => {
  const { db } = await setup();
  await put(db, graph());
  await putIntentGraph(
    {
      projectId: PROJECT_ID,
      sourceId: "cloud",
      graph: graph({ rev: 1 }),
      contentHash: intentGraphContentHash(graph({ rev: 1 })),
      byteSize: 10,
      ifMatch: null,
      producer: "cloud",
    },
    db,
  );
  const at = new Date("2026-09-25T10:00:00.000Z");

  await touchIntentGraphPull(PROJECT_ID, at, db, "cloud");

  const rows = await listIntentGraphSummaries(PROJECT_ID, db);
  const byKey = new Map(rows.map((r) => [r.graphKey, r]));
  assert.equal(byKey.get("cloud")?.pulledAt?.toISOString(), at.toISOString());
  assert.equal(byKey.get(SOURCE)?.pulledAt, null);
  assert.equal(byKey.get("cloud")?.producer, "cloud");
});

/* — surfaced counts ————————————————————————————————————————————————————————— */

test("the projection stores surfaced counts per edge, null where the graph has none", async () => {
  const { client, db } = await setup();
  const doc = graph();
  doc.intents[0].surfaced_tools = { gh_run_list: 9 };
  await put(db, doc);

  const rows = await client.query<{ capability_id: string; surfaced: number | null }>(
    `select capability_id, surfaced from intent_graph_edges where cluster_id = 'intent_0' and kind = 'tool' order by capability_id`,
  );
  assert.deepEqual(rows.rows, [
    { capability_id: "gh_run_list", surfaced: 9 },
    { capability_id: "gh_run_view", surfaced: null },
  ]);
});

test("a cloud graph is live from the moment a runtime reports ranking from it, and watching again once it stops", async () => {
  const { client, db } = await setup();
  await put(db, graph());
  await putIntentGraph(
    {
      projectId: PROJECT_ID,
      sourceId: "cloud",
      graph: graph(),
      contentHash: intentGraphContentHash(graph()),
      byteSize: 100,
      ifMatch: null,
      producer: "cloud",
    },
    db,
  );
  const liveAt = async (key: string) =>
    (await getIntentGraph(PROJECT_ID, key, db))?.liveAt?.toISOString() ?? null;
  // As ingest stores it: a report without a key keeps the previous one.
  const report = (
    source: string,
    status: string,
    graphKey: string | null,
    at: string,
    reason = "enabled",
  ) =>
    client.query(
      `insert into intent_graph_runtime_status (project_id, source_id, status, reason, rev, graph_key, learn, observed_at)
       values ($1, $2, $3, $6, 1, $4, false, $5)
       on conflict (project_id, source_id) do update
         set status = excluded.status, reason = excluded.reason,
             graph_key = coalesce(excluded.graph_key, intent_graph_runtime_status.graph_key),
             observed_at = excluded.observed_at`,
      [PROJECT_ID, source, status, graphKey, at, reason],
    );

  await syncIntentGraphLiveFromStatus(PROJECT_ID, db);
  assert.equal(await liveAt("cloud"), null, "watching: built and served, no runtime ranks from it");

  // A runtime's own graph is not Cloud's to date, whatever the runtime reports.
  await report(SOURCE, "active", SOURCE, "2026-09-30T09:00:00.000Z");
  await syncIntentGraphLiveFromStatus(PROJECT_ID, db);
  assert.equal(await liveAt("cloud"), null);
  assert.equal(await liveAt(SOURCE), null);

  await report("worker-b", "active", "cloud", "2026-09-30T10:00:00.000Z");
  await syncIntentGraphLiveFromStatus(PROJECT_ID, db);
  assert.equal(await liveAt("cloud"), "2026-09-30T10:00:00.000Z");
  const summary = (await listIntentGraphSummaries(PROJECT_ID, db)).find(
    (r) => r.graphKey === "cloud",
  );
  assert.equal(summary?.liveAt?.toISOString(), "2026-09-30T10:00:00.000Z");

  // Adopting a newer revision reports again, later: the first moment is kept.
  await report("worker-b", "active", "cloud", "2026-09-30T11:00:00.000Z");
  await syncIntentGraphLiveFromStatus(PROJECT_ID, db);
  assert.equal(await liveAt("cloud"), "2026-09-30T10:00:00.000Z");

  // The inactive half of a re-enable, seen on its own, does not end the live period.
  await report("worker-b", "inactive", null, "2026-09-30T11:30:00.000Z", "disabled");
  await syncIntentGraphLiveFromStatus(PROJECT_ID, db, new Date("2026-09-30T11:30:01.000Z"));
  assert.equal(await liveAt("cloud"), "2026-09-30T10:00:00.000Z");

  // Still stopped after the grace: back to watching.
  await syncIntentGraphLiveFromStatus(PROJECT_ID, db, new Date("2026-09-30T11:45:00.000Z"));
  assert.equal(await liveAt("cloud"), null);
});

test("a graph's live period is held only by its own runtimes' disable reports, never by another graph's or a pause", async () => {
  const { client, db } = await setup();
  for (const key of ["cloud", "cloud/billing-agent"]) {
    await putIntentGraph(
      {
        projectId: PROJECT_ID,
        sourceId: key,
        graph: graph(),
        contentHash: intentGraphContentHash(graph()),
        byteSize: 100,
        ifMatch: null,
        producer: "cloud",
      },
      db,
    );
  }
  const liveAt = async (key: string) =>
    (await getIntentGraph(PROJECT_ID, key, db))?.liveAt?.toISOString() ?? null;
  const report = (
    source: string,
    status: string,
    graphKey: string | null,
    at: string,
    reason = "enabled",
  ) =>
    client.query(
      `insert into intent_graph_runtime_status (project_id, source_id, status, reason, rev, graph_key, learn, observed_at)
       values ($1, $2, $3, $6, 1, $4, false, $5)
       on conflict (project_id, source_id) do update
         set status = excluded.status, reason = excluded.reason,
             graph_key = coalesce(excluded.graph_key, intent_graph_runtime_status.graph_key),
             observed_at = excluded.observed_at`,
      [PROJECT_ID, source, status, graphKey, at, reason],
    );

  await report("billing-agent", "active", "cloud/billing-agent", "2026-09-30T10:00:00.000Z");
  await report("worker-b", "active", "cloud", "2026-09-30T10:00:00.000Z");
  await syncIntentGraphLiveFromStatus(PROJECT_ID, db);
  assert.equal(await liveAt("cloud/billing-agent"), "2026-09-30T10:00:00.000Z");
  assert.equal(await liveAt("cloud"), "2026-09-30T10:00:00.000Z");

  // billing-agent stops for good. worker-b keeps re-enabling on the merged
  // graph: its disable reports are not billing-agent's graph's business.
  await report("billing-agent", "inactive", null, "2026-09-30T11:00:00.000Z", "disabled");
  await report("worker-b", "inactive", null, "2026-09-30T11:20:00.000Z", "disabled");
  await syncIntentGraphLiveFromStatus(PROJECT_ID, db, new Date("2026-09-30T11:21:00.000Z"));
  assert.equal(
    await liveAt("cloud/billing-agent"),
    null,
    "released: its own disable is past the grace",
  );
  assert.equal(
    await liveAt("cloud"),
    "2026-09-30T10:00:00.000Z",
    "held: its own runtime disabled a minute ago",
  );

  // A runtime paused on its graph (model mismatch) is not ranking from it and does not hold it live.
  await report("worker-b", "paused", "cloud", "2026-09-30T11:22:00.000Z", "rebuilt");
  await syncIntentGraphLiveFromStatus(PROJECT_ID, db, new Date("2026-09-30T11:23:00.000Z"));
  assert.equal(
    await liveAt("cloud"),
    null,
    "a pause within the grace does not hold the graph live",
  );
});

/* — setup facts ————————————————————————————————————————————————————————————— */

test("recent learning sources count searches and tool calls per runtime; missing tools compare a cloud graph with the catalog", async () => {
  const { client, db } = await setup();
  const at = "2026-09-30T10:00:00Z";
  const event = (id: number, type: string, source: string, lane = "runtime", payload = "{}") =>
    client.query(
      `insert into trace_events (id, project_id, type, ingest_source, source_id, session_id, client_event_id, occurred_at, received_at, payload)
       values ($1, $2, $3, $7, $4, 's', $5, $6, $6, $8::jsonb)`,
      [
        `dddddddd-dddd-4ddd-8ddd-${String(id).padStart(12, "0")}`,
        PROJECT_ID,
        type,
        source,
        `e-${id}`,
        at,
        lane,
        payload,
      ],
    );
  await event(1, "search", "billing-agent");
  await event(2, "search", "billing-agent");
  await event(3, "invoke_start", "billing-agent");
  await event(4, "search", "support-agent");
  await event(5, "usage_boost", "support-agent"); // not a learning event
  // A plain agent over OpenTelemetry: two asks, one model call without one, two tool calls.
  await event(6, "otlp_model_call", "pm-agent", "otlp", '{"prompt":"find my tasks"}');
  await event(7, "otlp_model_call", "pm-agent", "otlp", '{"prompt":"close the sprint"}');
  await event(8, "otlp_model_call", "pm-agent", "otlp", '{"menu":["find_task"]}');
  await event(9, "invoke_end", "pm-agent", "otlp");
  await event(10, "invoke_error", "pm-agent", "otlp");
  await event(11, "invoke_end", "billing-agent", "runtime"); // the runtime lane's invoke_end is not learning
  await client.query(
    `update trace_events set received_at = '2026-09-30T10:05:00Z' where client_event_id = 'e-10'`,
  );

  const sources = await listRecentLearningSources(PROJECT_ID, new Date("2026-09-30T00:00:00Z"), db);
  assert.deepEqual(
    sources.map((s) => [s.sourceId, s.lane, s.searches, s.invokes, s.silentCalls]),
    [
      ["billing-agent", "runtime", 2, 1, 0],
      ["pm-agent", "otlp", 2, 2, 1],
      ["support-agent", "runtime", 1, 0, 0],
    ],
  );
  assert.equal(sources[0]!.lastAt.toISOString(), new Date(at).toISOString());
  assert.equal(
    sources[1]!.lastAt.toISOString(),
    "2026-09-30T10:05:00.000Z",
    "the agent's newest row, a tool call",
  );
  assert.deepEqual(
    await listRecentLearningSources(PROJECT_ID, new Date("2026-10-01T00:00:00Z"), db),
    [],
  );

  // A cloud graph whose tools are gh_run_list, gh_run_view and deploy_rollback.
  await putIntentGraph(
    {
      projectId: PROJECT_ID,
      sourceId: "cloud",
      graph: graph(),
      contentHash: intentGraphContentHash(graph()),
      byteSize: 100,
      ifMatch: null,
      producer: "cloud",
    },
    db,
  );
  assert.deepEqual(
    [...(await countMissingToolsByGraph(PROJECT_ID, db))],
    [],
    "no catalog to compare against: nothing to say",
  );
  await client.query(
    `insert into runtime_catalog_entries
       (project_id, kind, entry_id, name, description, searchable_description, searchable_description_overridden, content_hash)
     values ($1, 'tool', 'gh_run_list', 'gh_run_list', 'List runs', 'List runs', false, 'h')`,
    [PROJECT_ID],
  );
  assert.deepEqual([...(await countMissingToolsByGraph(PROJECT_ID, db))], [["cloud", 2]]);
});
