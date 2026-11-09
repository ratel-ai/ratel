import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type CatalogQueriesDb, replaceCatalogSnapshot } from "@/lib/ingest/catalogs/queries";
import { parseCatalogSnapshot } from "@/lib/ingest/catalogs/snapshot";
import { deterministicEventId, parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import {
  insertTraceEventRejects,
  insertTraceEvents,
  listSkillsSearchedButNeverInvoked,
  listTopErroringTools,
  listTopSearchQueries,
  type TraceDb,
} from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

/**
 * The Phase-1 demo, run for real against an in-process Postgres (PGlite): apply
 * the actual migrations, ingest a batch of synthetic usage events through the
 * real parse → insert pipeline, and confirm the three example questions the
 * schema was built to answer resolve correctly — plus that ingestion is
 * idempotent under a re-sent batch.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DAY = 86_400_000;
const BASE = Date.parse("2026-06-27T00:00:00Z"); // "now" for the demo

/** Fresh in-memory Postgres with the real schema + one organization/project seeded. */
async function setup(): Promise<{
  db: TraceDb & CatalogQueriesDb;
  client: PGlite;
}> {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');`,
  );
  const db = drizzle(client, { schema }) as unknown as TraceDb & CatalogQueriesDb;
  return { db, client };
}

/** Build a well-formed wire event with an event time relative to the demo "now". */
function ev(body: Record<string, unknown>, daysAgo = 0): Record<string, unknown> {
  return {
    v: 1,
    ts: BASE - daysAgo * DAY,
    session_id: "sess-1",
    occurred_at: new Date(BASE - daysAgo * DAY).toISOString(),
    ...body,
  };
}

/** The synthetic usage batch the three queries are asserted against. */
function demoBatch(): Record<string, unknown>[] {
  return [
    // Searches surface three skills; only write-changelog is later invoked.
    ev(
      {
        type: "skill_search",
        query: "make a changelog",
        hits: [
          { skill_id: "write-changelog", score: 0.9 },
          { skill_id: "summarize-pr", score: 0.5 },
        ],
      },
      1,
    ),
    ev(
      {
        type: "skill_search",
        query: "make a changelog",
        hits: [
          { skill_id: "write-changelog", score: 0.9 },
          { skill_id: "orphan-skill", score: 0.2 },
        ],
      },
      2,
    ),
    ev({ type: "skill_invoke", skill_id: "write-changelog" }, 1),
    // Tool errors across the three error variants.
    ev({ type: "invoke_error", tool_id: "git.push", error: "auth failed" }, 1),
    ev({ type: "gateway_error", tool_id: "git.push", error: "timeout" }, 2),
    ev({ type: "upstream_error", server: "gh", tool_id: "git.push", error: "429" }, 2),
    ev({ type: "invoke_error", tool_id: "npm.install", error: "ENOENT" }, 1),
    // Tool searches for the "top queries this week" question.
    ev({ type: "search", query: "make a changelog", hits: [{ tool_id: "changelog.gen" }] }, 1),
    ev({ type: "search", query: "fix failing tests", hits: [{ tool_id: "test.run" }] }, 3),
    // An old search that must fall outside a 7-day window.
    ev({ type: "search", query: "ancient query", hits: [{ tool_id: "old.tool" }] }, 30),
  ];
}

test("demo: skills searched-for but never invoked", async () => {
  const { db } = await setup();
  const { valid, rejected } = parseTraceEvents(demoBatch());
  assert.equal(rejected.length, 0);
  await insertTraceEvents(PROJECT_ID, valid, db);

  const rows = await listSkillsSearchedButNeverInvoked(PROJECT_ID, {}, db);
  const skills = rows.map((r) => r.skillId).sort();
  // write-changelog was invoked → excluded; the other two were only ever surfaced.
  assert.deepEqual(skills, ["orphan-skill", "summarize-pr"]);
  // summarize-pr appeared in one search, orphan-skill in one.
  const byId = Object.fromEntries(rows.map((r) => [r.skillId, Number(r.searchAppearances)]));
  assert.equal(byId["summarize-pr"], 1);
  assert.equal(byId["orphan-skill"], 1);
});

test("demo: tools erroring most", async () => {
  const { db } = await setup();
  const { valid } = parseTraceEvents(demoBatch());
  await insertTraceEvents(PROJECT_ID, valid, db);

  const rows = await listTopErroringTools(PROJECT_ID, {}, db);
  assert.deepEqual(
    rows.map((r) => ({ toolId: r.toolId, errors: Number(r.errors) })),
    [
      { toolId: "git.push", errors: 3 }, // invoke + gateway + upstream
      { toolId: "npm.install", errors: 1 },
    ],
  );
});

test("demo: top search queries this week (window excludes the old one)", async () => {
  const { db } = await setup();
  const { valid } = parseTraceEvents(demoBatch());
  await insertTraceEvents(PROJECT_ID, valid, db);

  const since = new Date(BASE - 7 * DAY);
  const rows = await listTopSearchQueries(PROJECT_ID, { since }, db);
  const byQuery = Object.fromEntries(rows.map((r) => [r.query, Number(r.searches)]));
  // search + skill_search both count. "make a changelog": 2 skill_search + 1 search = 3.
  assert.equal(byQuery["make a changelog"], 3);
  assert.equal(byQuery["fix failing tests"], 1);
  // The 30-day-old query is outside the 7-day window.
  assert.equal(byQuery["ancient query"], undefined);
});

test("ingestion is idempotent: re-sending a batch inserts nothing new", async () => {
  const { db, client } = await setup();
  const { valid } = parseTraceEvents(demoBatch());

  const first = await insertTraceEvents(PROJECT_ID, valid, db);
  const second = await insertTraceEvents(PROJECT_ID, valid, db);
  assert.equal(second.accepted, 0, "a re-sent batch accepts zero new rows");
  assert.equal(first.accepted > 0, true);

  const events = await client.query<{ n: number }>(`select count(*)::int as n from trace_events`);
  const hits = await client.query<{ n: number }>(`select count(*)::int as n from trace_event_hits`);
  // Row counts are unchanged after the second flush.
  assert.equal(events.rows[0].n, first.accepted);
  // 3 searches with hit arrays: [2 skill hits] + [2 skill hits] + [1 tool] + [1 tool] + [1 tool old] = 7.
  assert.equal(hits.rows[0].n, 7);
});

test("envelope v2 correlation fields persist with the raw runtime event", async () => {
  const { db, client } = await setup();
  const { valid, rejected } = parseTraceEvents([
    {
      v: 2,
      ts: BASE,
      session_id: "sess-v2",
      event_id: "evt-v2",
      source_id: "source-v2",
      invocation_id: "inv-v2",
      trace_id: "trace-v2",
      span_id: "span-v2",
      type: "future_event",
    },
  ]);

  assert.equal(rejected.length, 0);
  await insertTraceEvents(PROJECT_ID, valid, db);
  const stored = await client.query<{
    event_id: string;
    source_id: string;
    invocation_id: string;
    trace_id: string;
    span_id: string;
  }>(`select event_id, source_id, invocation_id, trace_id, span_id from trace_events`);
  assert.deepEqual(stored.rows, [
    {
      event_id: "evt-v2",
      source_id: "source-v2",
      invocation_id: "inv-v2",
      trace_id: "trace-v2",
      span_id: "span-v2",
    },
  ]);
});

test("an out-of-domain promoted numeric rejects per item without sinking the batch", async () => {
  const { db, client } = await setup();
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "invoke_end", tool_id: "ok.tool", took_ms: 5 }),
    ev({ type: "invoke_end", tool_id: "big.tool", input_tokens: 3_000_000_000 }),
  ]);

  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].error, /input_tokens/);

  const { accepted } = await insertTraceEvents(PROJECT_ID, valid, db);
  await insertTraceEventRejects(
    PROJECT_ID,
    [
      {
        eventId: null,
        type: "invoke_end",
        reason: rejected[0].error,
        sizeBytes: 100,
        sourceId: null,
      },
    ],
    db,
  );

  assert.equal(accepted, 1);
  const stored = await client.query<{ tool_id: string }>(`select tool_id from trace_events`);
  assert.deepEqual(stored.rows, [{ tool_id: "ok.tool" }]);
  const rejects = await client.query<{ n: number }>(
    `select count(*)::int as n from trace_event_rejects`,
  );
  assert.equal(rejects.rows[0].n, 1);
});

test("rejected runtime events store metadata only", async () => {
  const { db, client } = await setup();

  const reject = {
    eventId: "evt-bad",
    type: "search",
    reason: "query: required",
    sizeBytes: 321,
    sourceId: "source-1",
  };
  await insertTraceEventRejects(PROJECT_ID, [reject], db);
  await insertTraceEventRejects(PROJECT_ID, [reject], db);

  const stored = await client.query<{
    event_id: string;
    type: string;
    reason: string;
    size_bytes: number;
    source_id: string;
  }>(`select event_id, type, reason, size_bytes, source_id from trace_event_rejects`);
  assert.deepEqual(stored.rows, [
    {
      event_id: "evt-bad",
      type: "search",
      reason: "query: required",
      size_bytes: 321,
      source_id: "source-1",
    },
  ]);
  const columns = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'trace_event_rejects'`,
  );
  assert.equal(
    columns.rows.some(({ column_name }) => column_name === "payload"),
    false,
  );
});

test("anonymous rejects with one reason stay distinct per payload but dedupe replays", async () => {
  const { db, client } = await setup();
  const reject = (payloadHash: string) => ({
    eventId: null,
    type: "search",
    reason: "query: required",
    sizeBytes: 64,
    sourceId: null,
    payloadHash,
  });

  await insertTraceEventRejects(PROJECT_ID, [reject("hash-item-1")], db);
  await insertTraceEventRejects(PROJECT_ID, [reject("hash-item-2")], db);
  // Retrying the same payload must not double-count.
  await insertTraceEventRejects(PROJECT_ID, [reject("hash-item-1")], db);

  const stored = await client.query<{ n: number }>(
    `select count(*)::int as n from trace_event_rejects`,
  );
  assert.equal(stored.rows[0].n, 2);
});

test("end_user_id is stored on the event, denormalized onto its hits, and drives the per-user reads", async () => {
  const { db, client } = await setup();
  const { valid, rejected } = parseTraceEvents([
    // u-ada searches and finds review-pr; u-bob invokes it. For ada it's
    // "surfaced but never invoked"; project-wide it is NOT (bob invoked it).
    ev(
      {
        type: "skill_search",
        query: "review my pr",
        end_user_id: "u-ada",
        hits: [{ skill_id: "review-pr", score: 0.7 }],
      },
      1,
    ),
    ev(
      {
        type: "skill_search",
        query: "review my pr",
        end_user_id: "u-ada",
        hits: [{ skill_id: "review-pr", score: 0.7 }],
      },
      2,
    ),
    ev({ type: "skill_invoke", skill_id: "review-pr", end_user_id: "u-bob" }, 1),
    // Errors split across users.
    ev(
      { type: "invoke_error", tool_id: "git.push", error: "auth failed", end_user_id: "u-ada" },
      1,
    ),
    ev(
      { type: "invoke_error", tool_id: "git.push", error: "auth failed", end_user_id: "u-bob" },
      1,
    ),
    // A user-attributed search plus an anonymous one.
    ev({ type: "search", query: "review my pr", end_user_id: "u-ada", hits: [] }, 1),
    ev({ type: "search", query: "review my pr", hits: [] }, 1),
  ]);
  assert.equal(rejected.length, 0);
  await insertTraceEvents(PROJECT_ID, valid, db);

  // Column stored + hit rows carry the parent's end-user (raw SQL — the narrowed
  // TraceDb type hides direct table reads).
  const hitRows = await client.query<{ end_user_id: string | null }>(
    `select end_user_id from trace_event_hits where target_id = 'review-pr'`,
  );
  assert.equal(hitRows.rows.length, 2);
  assert.ok(
    hitRows.rows.every((r) => r.end_user_id === "u-ada"),
    "hits inherit the parent's end-user",
  );

  // Per-user anti-join: surfaced to ada, invoked only by bob → still a gap FOR ADA…
  const adaGaps = await listSkillsSearchedButNeverInvoked(PROJECT_ID, { endUserId: "u-ada" }, db);
  assert.deepEqual(adaGaps, [{ skillId: "review-pr", searchAppearances: 2 }]);
  // …but project-wide the invoke clears it.
  const globalGaps = await listSkillsSearchedButNeverInvoked(PROJECT_ID, {}, db);
  assert.ok(!globalGaps.some((g) => g.skillId === "review-pr"));

  // Per-user error + search-query filters.
  const adaErrors = await listTopErroringTools(PROJECT_ID, { endUserId: "u-ada" }, db);
  assert.deepEqual(adaErrors, [{ toolId: "git.push", errors: 1 }]);
  const adaQueries = await listTopSearchQueries(
    PROJECT_ID,
    { since: new Date(BASE - 7 * DAY), endUserId: "u-ada" },
    db,
  );
  // ada's two skill_searches + one search; the anonymous search is excluded.
  assert.deepEqual(adaQueries, [{ query: "review my pr", searches: 3 }]);
});

test("runtime facts atomically consolidate sources, tool counters, search hits, and experiments", async () => {
  const { db, client } = await setup();
  const { valid, rejected } = parseTraceEvents([
    {
      ...ev({
        type: "skill_search",
        query: "explain this failure",
        hits: [{ skill_id: "explain-error", score: 0.9 }],
      }),
      v: 2,
      event_id: "evt-search",
      source_id: "worker-a",
    },
    {
      ...ev({ type: "invoke_end", tool_id: "stable-tool", took_ms: 20 }),
      v: 2,
      event_id: "evt-success",
      source_id: "worker-a",
      invocation_id: "inv-success",
    },
    {
      ...ev({ type: "gateway_invoke", tool_id: "stable-tool", took_ms: 21 }),
      v: 2,
      event_id: "evt-gateway-success",
      source_id: "worker-a",
      invocation_id: "inv-success",
    },
    {
      ...ev({ type: "invoke_error", tool_id: "flaky-tool", took_ms: 30, error: "timeout" }),
      v: 2,
      event_id: "evt-error",
      source_id: "worker-a",
      invocation_id: "inv-error",
    },
    {
      ...ev({
        type: "experiment_comparison",
        experiment_id: "retrieval-v2",
        selection_id: "selection-1",
        arm: "candidate",
        role: "shadow",
        served_arm: "control",
        shadow_arm: "candidate",
        agreement: {
          top1: true,
          exactOrder: false,
          overlapCount: 2,
          jaccardAtK: 0.5,
          k: 3,
        },
      }),
      v: 2,
      event_id: "evt-experiment",
      source_id: "worker-a",
    },
  ]);
  assert.equal(rejected.length, 0);
  const runtime = valid.map((event) => ({ ...event, ingestSource: "runtime" as const }));

  assert.deepEqual(await insertTraceEvents(PROJECT_ID, runtime, db), { accepted: 5 });
  assert.deepEqual(await insertTraceEvents(PROJECT_ID, runtime, db), { accepted: 0 });

  const sources = await client.query<{
    source_id: string;
    facts_started_at: Date;
    first_seen_at: Date;
    last_seen_at: Date;
  }>(`select source_id, facts_started_at, first_seen_at, last_seen_at from runtime_event_sources`);
  assert.equal(sources.rows.length, 1);
  assert.equal(sources.rows[0].source_id, "worker-a");
  assert.ok(
    new Date(sources.rows[0].facts_started_at).getTime() >= Date.now() - 5 * 60_000 - 5_000,
  );
  assert.ok(sources.rows[0].first_seen_at <= sources.rows[0].last_seen_at);

  const counters = await client.query<{
    tool_id: string;
    calls: number;
    errors: number;
    total_duration_ms: number;
  }>(
    `select tool_id, calls::int, errors::int, total_duration_ms::int from tool_usage_counters order by tool_id`,
  );
  assert.deepEqual(counters.rows, [
    { tool_id: "flaky-tool", calls: 1, errors: 1, total_duration_ms: 30 },
    { tool_id: "stable-tool", calls: 1, errors: 0, total_duration_ms: 20 },
  ]);

  const hits = await client.query<{ target_id: string }>(`select target_id from trace_event_hits`);
  assert.deepEqual(hits.rows, [{ target_id: "explain-error" }]);

  const experiment = await client.query<{
    event_name: string;
    event_id: string;
    source_id: string;
    experiment_name: string;
    experiment_selection_id: string;
    experiment_arm: string;
    experiment_role: string;
    experiment_attrs: Record<string, unknown>;
  }>(`select event_name, event_id, source_id, experiment_name, experiment_selection_id,
             experiment_arm, experiment_role, experiment_attrs from otel_logs`);
  assert.deepEqual(experiment.rows, [
    {
      event_name: "ratel.experiment.comparison",
      event_id: "evt-experiment",
      source_id: "worker-a",
      experiment_name: "retrieval-v2",
      experiment_selection_id: "selection-1",
      experiment_arm: "candidate",
      experiment_role: "shadow",
      experiment_attrs: {
        "ratel.experiment.agreement.exact_order": false,
        "ratel.experiment.agreement.jaccard_at_k": 0.5,
        "ratel.experiment.agreement.k": 3,
        "ratel.experiment.agreement.overlap_count": 2,
        "ratel.experiment.agreement.top1": true,
        "ratel.experiment.served.arm": "control",
        "ratel.experiment.shadow.arm": "candidate",
      },
    },
  ]);

  assert.deepEqual(await listSkillsSearchedButNeverInvoked(PROJECT_ID, {}, db), [
    { skillId: "explain-error", searchAppearances: 1 },
  ]);
  assert.deepEqual(await listTopErroringTools(PROJECT_ID, {}, db), [
    { toolId: "flaky-tool", errors: 1 },
  ]);
});

test("SDK experiment lifecycle fields map to canonical OTEL attributes", async () => {
  const { db, client } = await setup();
  const { valid, rejected } = parseTraceEvents([
    {
      ...ev({
        type: "experiment_skip",
        experiment_id: "retrieval-v2",
        skipped_arm: "candidate",
        concurrency: 2,
        reason: "capacity",
      }),
      v: 2,
      event_id: "evt-skip",
      source_id: "worker-a",
    },
    {
      ...ev({
        type: "experiment_fallback",
        experiment_id: "retrieval-v2",
        effective_arm: "control",
        reused_shadow: true,
      }),
      v: 2,
      event_id: "evt-fallback",
      source_id: "worker-a",
    },
    {
      ...ev({
        type: "experiment_drop",
        experiment_id: "retrieval-v2",
        reason: "fallback-consumed",
      }),
      v: 2,
      event_id: "evt-drop",
      source_id: "worker-a",
    },
    {
      ...ev({
        type: "experiment_invocation",
        experiment_id: "retrieval-v2",
        selection_id: "selection-1",
        tool_id: "search-logs",
        turn: 7,
        attributed: true,
        effective_arm: "control",
        rank: 1,
        age_ms: 12,
      }),
      v: 2,
      event_id: "evt-invocation",
      source_id: "worker-a",
    },
  ]);
  assert.equal(rejected.length, 0);

  await insertTraceEvents(
    PROJECT_ID,
    valid.map((event) => ({ ...event, ingestSource: "runtime" as const })),
    db,
  );

  const rows = await client.query<{
    event_name: string;
    experiment_attrs: Record<string, unknown>;
  }>(`select event_name, experiment_attrs from otel_logs order by event_name`);
  assert.deepEqual(rows.rows, [
    {
      event_name: "ratel.experiment.drop",
      experiment_attrs: {
        "ratel.experiment.drop.reason": "fallback-consumed",
      },
    },
    {
      event_name: "ratel.experiment.fallback",
      experiment_attrs: {
        "ratel.experiment.fallback.effective_arm": "control",
        "ratel.experiment.fallback.reused_shadow": true,
      },
    },
    {
      // The invoked tool's id is what lets the quality reads name the revealed
      // target; the turn is the caller's ordinal for ordering replays.
      event_name: "ratel.experiment.invocation",
      experiment_attrs: {
        "ratel.experiment.effective_arm": "control",
        "ratel.experiment.invocation.age_ms": 12,
        "ratel.experiment.invocation.attributed": true,
        "ratel.experiment.invocation.rank": 1,
        "ratel.experiment.invocation.tool_id": "search-logs",
        "ratel.experiment.invocation.turn": 7,
      },
    },
    {
      event_name: "ratel.experiment.skip",
      experiment_attrs: {
        "ratel.experiment.skip.arm": "candidate",
        "ratel.experiment.skip.concurrency": 2,
        "ratel.experiment.skip.reason": "capacity",
      },
    },
  ]);
});

test("a skewed fact cannot backdate or later move the source facts era", async () => {
  const { db, client } = await setup();
  const parseFact = (eventId: string, ts: number) =>
    parseTraceEvents([
      {
        v: 2,
        ts,
        session_id: "sess-skew",
        event_id: eventId,
        source_id: "worker-skewed",
        type: "future_event",
      },
    ]).valid[0];

  const firstReceivedAround = Date.now();
  await insertTraceEvents(
    PROJECT_ID,
    [
      {
        ...parseFact("evt-skewed", Date.parse("2020-01-01T00:00:00Z")),
        ingestSource: "runtime" as const,
      },
    ],
    db,
  );
  const first = await client.query<{ facts_started_at: Date }>(
    `select facts_started_at from runtime_event_sources where source_id = 'worker-skewed'`,
  );
  const boundary = new Date(first.rows[0].facts_started_at).getTime();
  assert.ok(boundary >= firstReceivedAround - 5 * 60_000 - 5_000);

  await insertTraceEvents(
    PROJECT_ID,
    [
      {
        ...parseFact("evt-backfill", Date.parse("2010-01-01T00:00:00Z")),
        ingestSource: "runtime" as const,
      },
    ],
    db,
  );
  const afterBackfill = await client.query<{ facts_started_at: Date }>(
    `select facts_started_at from runtime_event_sources where source_id = 'worker-skewed'`,
  );
  assert.equal(new Date(afterBackfill.rows[0].facts_started_at).getTime(), boundary);
});

test("a future-dated fact cannot move source or tool usage timestamps past receipt", async () => {
  const { db, client } = await setup();
  const [fact] = parseTraceEvents([
    {
      v: 2,
      ts: Date.parse("2036-01-01T00:00:00Z"),
      session_id: "sess-future-skew",
      event_id: "evt-future-skew",
      source_id: "worker-future-skew",
      type: "invoke_end",
      tool_id: "future-tool",
    },
  ]).valid;
  const receivedAfter = Date.now();

  await insertTraceEvents(
    PROJECT_ID,
    [
      {
        ...fact,
        ingestSource: "runtime" as const,
      },
    ],
    db,
  );

  const source = await client.query<{ facts_started_at: Date }>(
    `select facts_started_at from runtime_event_sources where source_id = 'worker-future-skew'`,
  );
  const counter = await client.query<{ first_used_at: Date; last_used_at: Date }>(
    `select first_used_at, last_used_at from tool_usage_counters where source_id = 'worker-future-skew'`,
  );
  assert.ok(new Date(source.rows[0].facts_started_at).getTime() <= receivedAfter + 5_000);
  assert.ok(new Date(counter.rows[0].first_used_at).getTime() <= receivedAfter + 5_000);
  assert.ok(new Date(counter.rows[0].last_used_at).getTime() <= receivedAfter + 5_000);
});

test("a runtime fact establishes the era for a source first seen through catalog sync", async () => {
  const { db } = await setup();
  const snapshot = parseCatalogSnapshot({
    source_id: "worker-catalog-first",
    tools: [],
  });
  await replaceCatalogSnapshot(PROJECT_ID, snapshot, db);
  const [fact] = parseTraceEvents([
    {
      v: 2,
      ts: Date.parse("2020-01-01T00:00:00Z"),
      session_id: "sess-catalog-first",
      event_id: "evt-catalog-first",
      source_id: "worker-catalog-first",
      type: "future_event",
    },
  ]).valid;

  assert.deepEqual(
    await insertTraceEvents(
      PROJECT_ID,
      [
        {
          ...fact,
          ingestSource: "runtime" as const,
        },
      ],
      db,
    ),
    { accepted: 1 },
  );
  assert.deepEqual(
    await insertTraceEvents(
      PROJECT_ID,
      [
        {
          ...fact,
          ingestSource: "otlp" as const,
          clientEventId: "otlp-after-catalog-first-facts",
          eventId: "evt-after-catalog-first-facts",
          occurredAt: new Date(Date.now() + 60_000),
        },
      ],
      db,
    ),
    { accepted: 0 },
  );
});

test("runtime facts establish a per-source era and deduplicate OTLP overlap by event id", async () => {
  const { db, client } = await setup();
  const { valid } = parseTraceEvents([
    {
      ...ev({ type: "search", query: "facts", hits: [] }),
      v: 2,
      event_id: "evt-facts",
      source_id: "worker-a",
    },
  ]);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((event) => ({ ...event, ingestSource: "runtime" as const })),
    db,
  );
  const source = await client.query<{ facts_started_at: Date }>(
    `select facts_started_at from runtime_event_sources where source_id = 'worker-a'`,
  );
  const era = new Date(source.rows[0].facts_started_at).getTime();

  const base = valid[0];
  const otlp = [
    {
      ...base,
      ingestSource: "otlp" as const,
      clientEventId: "otlp-overlap",
      occurredAt: new Date(era - 60_000),
    },
    {
      ...base,
      ingestSource: "otlp" as const,
      clientEventId: "otlp-before-era",
      eventId: "evt-before",
      occurredAt: new Date(era - 60_000),
    },
    {
      ...base,
      ingestSource: "otlp" as const,
      clientEventId: "otlp-after-era",
      eventId: "evt-after",
      occurredAt: new Date(era + 60_000),
    },
    {
      ...base,
      ingestSource: "otlp" as const,
      clientEventId: "otlp-other-source",
      eventId: "evt-other",
      sourceId: "worker-b",
      occurredAt: new Date(era + 60_000),
    },
  ];

  assert.deepEqual(await insertTraceEvents(PROJECT_ID, otlp, db), { accepted: 2 });
  const rows = await client.query<{ client_event_id: string }>(
    `select client_event_id from trace_events order by client_event_id`,
  );
  assert.deepEqual(
    rows.rows.map(({ client_event_id }) => client_event_id),
    ["evt-facts", "otlp-before-era", "otlp-other-source"],
  );
});

test("model-call rows are never superseded by the facts era (the SDK does not send them)", async () => {
  const { db, client } = await setup();
  const { valid } = parseTraceEvents([
    {
      ...ev({ type: "search", query: "facts", hits: [] }),
      v: 2,
      event_id: "evt-facts",
      source_id: "worker-a",
    },
  ]);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((event) => ({ ...event, ingestSource: "runtime" as const })),
    db,
  );
  const source = await client.query<{ facts_started_at: Date }>(
    `select facts_started_at from runtime_event_sources where source_id = 'worker-a'`,
  );
  const era = new Date(source.rows[0].facts_started_at).getTime();
  const base = valid[0];
  assert.deepEqual(
    await insertTraceEvents(
      PROJECT_ID,
      [
        {
          ...base,
          type: "otlp_model_call",
          ingestSource: "otlp" as const,
          clientEventId: "otlp-model",
          eventId: null,
          occurredAt: new Date(era + 60_000),
        },
        {
          ...base,
          ingestSource: "otlp" as const,
          clientEventId: "otlp-search",
          eventId: "evt-after",
          occurredAt: new Date(era + 60_000),
        },
      ],
      db,
    ),
    { accepted: 1 },
  );
  const rows = await client.query<{ client_event_id: string }>(
    `select client_event_id from trace_events order by client_event_id`,
  );
  assert.deepEqual(
    rows.rows.map(({ client_event_id }) => client_event_id),
    ["evt-facts", "otlp-model"],
  );
});

test("a runtime experiment fact merges into, not over, a richer OTLP log row", async () => {
  const { db, client } = await setup();
  const rowId = deterministicEventId(PROJECT_ID, "evt-exp-merge");
  await client.exec(`
    insert into otel_logs
      (id, project_id, occurred_at, event_name, event_id, source_id, ingest_source,
       trace_id, span_id, experiment_name, experiment_arm, experiment_role,
       experiment_selection_id, experiment_attrs, attributes)
    values
      ('${rowId}', '${PROJECT_ID}', '2026-06-26T00:00:00Z', 'ratel.experiment.comparison',
       'evt-exp-merge', 'worker-a', 'otlp', 'trace-otlp', 'span-otlp',
       'retrieval-v2', 'candidate', 'shadow', 'selection-1',
       '{"ratel.experiment.result_ids": ["a", "b"], "ratel.experiment.served.arm": "stale-arm"}'::jsonb,
       '{"ratel.event.id": "evt-exp-merge", "ratel.experiment.item.detail": "kept"}'::jsonb)
  `);

  const { valid, rejected } = parseTraceEvents([
    {
      ...ev({
        type: "experiment_comparison",
        experiment_id: "retrieval-v2",
        selection_id: "selection-1",
        arm: "candidate",
        role: "shadow",
        served_arm: "control",
      }),
      v: 2,
      event_id: "evt-exp-merge",
      source_id: "worker-a",
    },
  ]);
  assert.equal(rejected.length, 0);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((event) => ({ ...event, ingestSource: "runtime" as const })),
    db,
  );

  const rows = await client.query<{
    ingest_source: string;
    trace_id: string;
    experiment_attrs: Record<string, unknown>;
    attributes: Record<string, unknown>;
  }>(`select ingest_source, trace_id, experiment_attrs, attributes from otel_logs`);
  assert.equal(rows.rows.length, 1);
  // Runtime owns the headline fields it projects…
  assert.equal(rows.rows[0].ingest_source, "runtime");
  assert.equal(rows.rows[0].experiment_attrs["ratel.experiment.served.arm"], "control");
  // …but per-item detail the runtime projection does not carry is preserved.
  assert.deepEqual(rows.rows[0].experiment_attrs["ratel.experiment.result_ids"], ["a", "b"]);
  assert.equal(rows.rows[0].attributes["ratel.experiment.item.detail"], "kept");
  assert.equal(rows.rows[0].attributes["ratel.event.id"], "evt-exp-merge");
  // A null runtime correlation must not erase the OTLP-provided one.
  assert.equal(rows.rows[0].trace_id, "trace-otlp");
});

test("disabling runtime ingest lets post-era OTLP derivations store again", async () => {
  const { db, client } = await setup();
  const { valid } = parseTraceEvents([
    {
      ...ev({ type: "search", query: "facts", hits: [] }),
      v: 2,
      event_id: "evt-facts",
      source_id: "worker-a",
    },
  ]);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((event) => ({ ...event, ingestSource: "runtime" as const })),
    db,
  );
  const source = await client.query<{ facts_started_at: Date }>(
    `select facts_started_at from runtime_event_sources where source_id = 'worker-a'`,
  );
  const era = new Date(source.rows[0].facts_started_at).getTime();

  const base = valid[0];
  // Flag off → the facts-era boundary no longer suppresses post-era OTLP rows,
  // but the exact-dupe drop by runtime event id stays.
  assert.deepEqual(
    await insertTraceEvents(
      PROJECT_ID,
      [
        {
          ...base,
          ingestSource: "otlp" as const,
          clientEventId: "otlp-post-era",
          eventId: "evt-post-era",
          occurredAt: new Date(era + 60_000),
        },
        {
          ...base,
          ingestSource: "otlp" as const,
          clientEventId: "otlp-exact-dupe",
          occurredAt: new Date(era + 60_000),
        },
      ],
      db,
      { factsEraSupersede: false },
    ),
    { accepted: 1 },
  );
  // Flag back on → supersede resumes for later post-era derivations.
  assert.deepEqual(
    await insertTraceEvents(
      PROJECT_ID,
      [
        {
          ...base,
          ingestSource: "otlp" as const,
          clientEventId: "otlp-post-era-2",
          eventId: "evt-post-era-2",
          occurredAt: new Date(era + 120_000),
        },
      ],
      db,
    ),
    { accepted: 0 },
  );

  const rows = await client.query<{ client_event_id: string }>(
    `select client_event_id from trace_events order by client_event_id`,
  );
  assert.deepEqual(
    rows.rows.map(({ client_event_id }) => client_event_id),
    ["evt-facts", "otlp-post-era"],
  );
});

test("a runtime fact replaces an earlier OTLP projection with the same event id", async () => {
  const { db, client } = await setup();
  const { valid } = parseTraceEvents([
    {
      ...ev({ type: "search", query: "canonical facts", hits: [{ tool_id: "facts-tool" }] }),
      v: 2,
      event_id: "evt-overlap",
      source_id: "worker-a",
    },
  ]);
  const fact = valid[0];
  const otlp = {
    ...fact,
    ingestSource: "otlp" as const,
    clientEventId: "evt-overlap",
    query: "derived projection",
    payload: { type: "search", query: "derived projection" },
    hits: [],
  };

  assert.deepEqual(await insertTraceEvents(PROJECT_ID, [otlp], db), { accepted: 1 });
  assert.deepEqual(
    await insertTraceEvents(PROJECT_ID, [{ ...fact, ingestSource: "runtime" as const }], db),
    { accepted: 1 },
  );

  const rows = await client.query<{
    ingest_source: string;
    client_event_id: string;
    query: string;
  }>(`select ingest_source, client_event_id, query from trace_events`);
  assert.deepEqual(rows.rows, [
    {
      ingest_source: "runtime",
      client_event_id: "evt-overlap",
      query: "canonical facts",
    },
  ]);
  const hits = await client.query<{ target_id: string }>(`select target_id from trace_event_hits`);
  assert.deepEqual(hits.rows, [{ target_id: "facts-tool" }]);
});
