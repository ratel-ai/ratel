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
import {
  firstBoostFromGraphAt,
  listBoostingGraphKeysSince,
  loadBoostSelections,
  loadOutcomesAroundLive,
} from "./queries";

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

async function setup(): Promise<{ client: PGlite; db: IntentGraphDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as IntentGraphDb };
}

test("loadBoostSelections reads the graph's own experiment, oldest first, with both arms and the invoked tool", async () => {
  const { client, db } = await setup();
  let n = 0;
  const log = async (row: {
    experiment: string;
    eventName: string;
    at: string;
    selectionId: string;
    arm?: string;
    role?: string;
    attrs: Record<string, unknown>;
  }) => {
    n += 1;
    await client.query(
      `insert into otel_logs (id, project_id, occurred_at, event_name, severity_number, experiment_name,
         experiment_arm, experiment_role, experiment_selection_id, experiment_attrs, attributes)
       values ($1, $2, $3, $4, 9, $5, $6, $7, $8, $9::jsonb, '{}'::jsonb)`,
      [
        `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`,
        PROJECT_ID,
        row.at,
        row.eventName,
        row.experiment,
        row.arm ?? null,
        row.role ?? null,
        row.selectionId,
        JSON.stringify(row.attrs),
      ],
    );
  };
  const now = new Date();
  const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
  const seed = async (
    experiment: string,
    id: string,
    secondsAgo: number,
    baseline: string[],
    adaptive: string[],
    invoked: string,
  ) => {
    await log({
      experiment,
      eventName: "ratel.experiment.comparison",
      at: at(secondsAgo),
      selectionId: id,
      arm: "adaptive",
      role: "shadow",
      attrs: {
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "adaptive",
        "ratel.experiment.agreement.k": 5,
      },
    });
    await log({
      experiment,
      eventName: "ratel.experiment.results",
      at: at(secondsAgo),
      selectionId: id,
      arm: "baseline",
      role: "serving",
      attrs: { "ratel.experiment.result_ids": baseline },
    });
    await log({
      experiment,
      eventName: "ratel.experiment.results",
      at: at(secondsAgo),
      selectionId: id,
      arm: "adaptive",
      role: "shadow",
      attrs: { "ratel.experiment.result_ids": adaptive },
    });
    await log({
      experiment,
      eventName: "ratel.experiment.invocation",
      at: at(secondsAgo),
      selectionId: id,
      attrs: {
        "ratel.experiment.invocation.attributed": true,
        "ratel.experiment.invocation.tool_id": invoked,
        "ratel.experiment.effective_arm": "baseline",
      },
    });
  };
  await seed(`adaptive-ranking:${SOURCE}`, "s-newer", 10, ["a", "b"], ["b", "a"], "b");
  await seed(`adaptive-ranking:${SOURCE}`, "s-older", 20, ["a", "b"], ["a", "b"], "a");
  await seed("adaptive-ranking:other-source", "s-other", 5, ["z"], ["z"], "z");
  // An offline turn: the reference arm served alone, so there is a selection,
  // its results and the invocation, but no comparison.
  const experiment = `adaptive-ranking:${SOURCE}`;
  await log({
    experiment,
    eventName: "ratel.experiment.selection",
    at: at(30),
    selectionId: "s-offline",
    arm: "baseline",
    role: "serving",
    attrs: {},
  });
  await log({
    experiment,
    eventName: "ratel.experiment.results",
    at: at(30),
    selectionId: "s-offline",
    arm: "baseline",
    role: "serving",
    attrs: { "ratel.experiment.result_ids": ["c", "a"] },
  });
  await log({
    experiment,
    eventName: "ratel.experiment.invocation",
    at: at(30),
    selectionId: "s-offline",
    attrs: {
      "ratel.experiment.invocation.attributed": true,
      "ratel.experiment.invocation.tool_id": "a",
      "ratel.experiment.effective_arm": "baseline",
    },
  });
  // A compared turn also has a selection record; it must not be counted twice.
  await log({
    experiment,
    eventName: "ratel.experiment.selection",
    at: at(10),
    selectionId: "s-newer",
    arm: "baseline",
    role: "serving",
    attrs: {},
  });

  const { selections, diagnostics } = await loadBoostSelections(PROJECT_ID, SOURCE, now, db);
  assert.deepEqual(
    selections.map((s) => s.selectionId),
    ["s-offline", "s-older", "s-newer"],
    "oldest first, this graph only, served-only turns merged in",
  );
  assert.deepEqual(
    selections[2]?.arms.map((a) => [a.arm, a.role, [...a.resultIds]]),
    [
      ["baseline", "serving", ["a", "b"]],
      ["adaptive", "shadow", ["b", "a"]],
    ],
  );
  assert.equal(selections[2]?.invokedToolId, "b");
  assert.deepEqual(
    selections[0]?.arms.map((a) => [a.arm, a.role, [...a.resultIds]]),
    [["baseline", "serving", ["c", "a"]]],
    "the offline turn carries its one arm",
  );
  assert.equal(selections[0]?.invokedToolId, "a");
  assert.equal(diagnostics.selectionCount, 3);
  assert.equal(diagnostics.invokedToolKey, "ratel.experiment.invocation.tool_id");
  assert.deepEqual((await loadBoostSelections(PROJECT_ID, "nothing-ran", now, db)).selections, []);
});

test("outcomes before and after live: Recall@5 on the served list, for the graph's own source", async () => {
  const { client, db } = await setup();
  const liveAt = new Date("2026-09-20T12:00:00Z");
  let n = 0;
  const event = async (
    type: string,
    source: string,
    turn: string,
    at: Date,
    toolId: string | null = null,
  ) => {
    n += 1;
    const id = `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, "0")}`;
    await client.query(
      `insert into trace_events (id, project_id, type, ingest_source, source_id, session_id, turn_id, tool_id, client_event_id, occurred_at, received_at, payload)
       values ($1, $2, $3, 'runtime', $4, 's', $5, $6, $7, $8, $8, '{}'::jsonb)`,
      [id, PROJECT_ID, type, source, turn, toolId, `oe-${n}`, at.toISOString()],
    );
    return id;
  };
  const hit = (eventId: string, target: string, rank = 0) =>
    client.query(
      `insert into trace_event_hits (trace_event_id, project_id, rank, target_type, target_id) values ($1, $2, $3, 'tool', $4)`,
      [eventId, PROJECT_ID, rank, target],
    );
  const at = (hoursFromLive: number, seconds = 0) =>
    new Date(liveAt.getTime() + hoursFromLive * 3_600_000 + seconds * 1_000);

  // Before: turn b1 searched twice and used the tool its last search ranked fifth.
  await hit(await event("search", "billing-agent", "b1", at(-5)), "docker_build");
  const second = await event("search", "billing-agent", "b1", at(-5, 1));
  await hit(second, "docker_build");
  await hit(second, "send_email", 1);
  await hit(second, "gh_run_list", 4);
  await event("invoke_start", "billing-agent", "b1", at(-5, 2), "gh_run_list");
  await event("invoke_error", "billing-agent", "b1", at(-5, 3), "gh_run_list");
  // After: turn a1 searched once and used the first result.
  await hit(await event("search", "billing-agent", "a1", at(2)), "gh_run_list");
  await event("invoke_start", "billing-agent", "a1", at(2, 1), "gh_run_list");
  // Another runtime's traffic does not count for this source's graph.
  await hit(await event("search", "support-agent", "x1", at(2)), "send_email");
  await event("invoke_start", "support-agent", "x1", at(2, 1), "docker_build");
  // A tool call before any search in its turn has no served list: not a turn, not confirmed.
  await event("invoke_start", "billing-agent", "a2", at(3), "docker_build");
  // A search and its tool call in the same millisecond pair up: searches go first within an instant.
  await hit(await event("search", "billing-agent", "a3", at(4)), "send_email", 2);
  await event("invoke_start", "billing-agent", "a3", at(4), "send_email");

  const own = await loadOutcomesAroundLive(
    PROJECT_ID,
    "cloud/billing-agent",
    liveAt,
    14,
    db,
    at(48),
  );
  assert.deepEqual(own.before, { turns: 1, recallAt5: 1 });
  assert.deepEqual(own.after, { turns: 2, recallAt5: 1 });

  // The merged graph reads every runtime.
  const merged = await loadOutcomesAroundLive(PROJECT_ID, "cloud", liveAt, 14, db, at(48));
  assert.deepEqual(merged.after, { turns: 3, recallAt5: 2 / 3 });

  // Nothing in the window: counts are zero and the shares are unknown, not zero.
  const empty = await loadOutcomesAroundLive(PROJECT_ID, "cloud/nobody", liveAt, 14, db, at(48));
  assert.deepEqual(empty.after, { turns: 0, recallAt5: null });
});

test("a graph counts as boosting only when a runtime on it reported a matched boost", async () => {
  const { client, db } = await setup();
  // Two days ago, not a fixed date: the boost reads only look back over event retention.
  const day = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const at = `${day}T10:00:00Z`;
  await client.query(
    `insert into intent_graph_runtime_status (project_id, source_id, status, reason, rev, graph_key, learn, observed_at)
     values ($1, 'billing-agent', 'active', 'enabled', 5, 'cloud/billing-agent', false, $2)`,
    [PROJECT_ID, at],
  );
  const boost = (id: number, intent: string | null) =>
    client.query(
      `insert into trace_events (id, project_id, type, ingest_source, source_id, session_id, client_event_id, occurred_at, received_at, payload)
       values ($1, $2, 'usage_boost', 'runtime', 'billing-agent', 's', $3, $4, $4, $5::jsonb)`,
      [
        `ffffffff-ffff-4fff-8fff-${String(id).padStart(12, "0")}`,
        PROJECT_ID,
        `b-${id}`,
        at,
        JSON.stringify({ intent }),
      ],
    );
  const since = new Date(`${day}T00:00:00Z`);

  // The runtime reports a boost event per search even when no query group matched.
  await boost(1, null);
  assert.deepEqual([...(await listBoostingGraphKeysSince(PROJECT_ID, since, db))], []);
  assert.equal(await firstBoostFromGraphAt(PROJECT_ID, "cloud/billing-agent", db), null);

  await boost(2, "intent_3");
  assert.deepEqual(
    [...(await listBoostingGraphKeysSince(PROJECT_ID, since, db))],
    ["cloud/billing-agent"],
  );
  assert.equal(
    (await firstBoostFromGraphAt(PROJECT_ID, "cloud/billing-agent", db))?.toISOString(),
    new Date(at).toISOString(),
  );
});

test("a boost is credited to the graph the runtime was on at the time, so moving to another graph does not move its online start back", async () => {
  const { client, db } = await setup();
  const t = (minute: number) => new Date(Date.UTC(2026, 8, 30, 10, minute)).toISOString();
  let n = 0;
  const event = (type: string, at: string, payload: Record<string, unknown>) =>
    client.query(
      `insert into trace_events (id, project_id, type, ingest_source, source_id, session_id, client_event_id, occurred_at, received_at, payload)
       values ($1, $2, $3, 'runtime', 'billing-agent', 's', $4, $5, $5, $6::jsonb)`,
      [
        `ffffffff-ffff-4fff-8fff-${String(++n).padStart(12, "0")}`,
        PROJECT_ID,
        type,
        `e-${n}`,
        at,
        JSON.stringify(payload),
      ],
    );
  // On graph A from :00, boosting at :05; moved to graph B at :10, boosting from it at :15.
  await event("usage_ranking_status", t(0), {
    status: "active",
    reason: "enabled",
    graph_key: "cloud/a",
  });
  await event("usage_boost", t(5), { intent: "i1" });
  await event("usage_ranking_status", t(10), {
    status: "active",
    reason: "enabled",
    graph_key: "cloud/b",
  });
  await event("usage_boost", t(15), { intent: "i2" });
  await client.query(
    `insert into intent_graph_runtime_status (project_id, source_id, status, reason, rev, graph_key, learn, observed_at)
     values ($1, 'billing-agent', 'active', 'enabled', 5, 'cloud/b', false, $2)`,
    [PROJECT_ID, t(10)],
  );
  const now = new Date(t(20));

  assert.equal(
    (await firstBoostFromGraphAt(PROJECT_ID, "cloud/b", db, now))?.toISOString(),
    t(15),
    "B's first boost is the one after the switch",
  );
  assert.equal(
    await firstBoostFromGraphAt(PROJECT_ID, "cloud/a", db, now),
    null,
    "no runtime is on A now",
  );
  assert.deepEqual(
    [...(await listBoostingGraphKeysSince(PROJECT_ID, new Date(t(0)), db))],
    ["cloud/b"],
  );
  assert.deepEqual(
    [...(await listBoostingGraphKeysSince(PROJECT_ID, new Date(t(16)), db))],
    [],
    "nothing since :16",
  );
  // A boost older than event retention is not the start of anything the page can show.
  assert.equal(
    await firstBoostFromGraphAt(PROJECT_ID, "cloud/b", db, new Date("2026-11-30T00:00:00Z")),
    null,
  );
});
