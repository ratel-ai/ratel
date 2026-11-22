import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { and, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { Bm25Clusterer } from "@/lib/readings/query-intents/bm25-clusterer";
import { type Clusterer, jaccardClusterer } from "@/lib/readings/query-intents/clusterer";
import {
  categorizeProjectQueries,
  type QueryIntentsDeps,
} from "@/lib/readings/query-intents/pipeline";
import {
  advanceQueryIntentsWatermark,
  getQueryIntentsByNormalizedTexts,
  getQueryIntentsWatermark,
  listNewSearchQueryEvents,
  listQueryIntentsForMatching,
  type QueryIntentsDb,
  recordQueryIntentOccurrences,
} from "@/lib/readings/query-intents/queries";
import { queryIntentOccurrences, queryIntents } from "@/lib/readings/query-intents/schema";

/**
 * The Phase-3 demo, run for real against an in-process Postgres (PGlite): apply
 * the actual migrations, ingest search queries through the real Phase-1 parse ->
 * insert pipeline, then drive the real categorization pipeline (exact match, then
 * deterministic clustering) wired to the real DB queries. Offline: no model call.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BASE = Date.parse("2026-06-27T00:00:00Z");

async function setup(): Promise<{ db: QueryIntentsDb; client: PGlite }> {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');`,
  );
  const db = drizzle(client, { schema }) as unknown as QueryIntentsDb;
  return { db, client };
}

/** The ledger as Tool Explorer reads it: canonicals with an occurrence, most recurring first. */
async function ledger(db: QueryIntentsDb) {
  return db
    .select()
    .from(queryIntents)
    .where(and(eq(queryIntents.projectId, PROJECT_ID), gt(queryIntents.occurrences, 0)))
    .orderBy(desc(queryIntents.occurrences), desc(queryIntents.lastSeenAt));
}

function ev(
  query: string,
  minutesAgo: number,
  type: "search" | "skill_search" | "gateway_search" = "skill_search",
  endUserId?: string,
) {
  const ts = BASE - minutesAgo * 60_000;
  return {
    v: 1,
    ts,
    session_id: "sess-1",
    occurred_at: new Date(ts).toISOString(),
    type,
    query,
    ...(endUserId ? { end_user_id: endUserId } : {}),
  };
}

function realDeps(db: QueryIntentsDb): QueryIntentsDeps {
  return {
    getWatermark: (projectId) => getQueryIntentsWatermark(projectId, db),
    listNewSearchEvents: (projectId, since) => listNewSearchQueryEvents(projectId, since, db),
    lookupExactCanonicals: (projectId, texts) =>
      getQueryIntentsByNormalizedTexts(projectId, texts, db),
    listExistingCanonicals: (projectId) => listQueryIntentsForMatching(projectId, db),
    recordOccurrences: (projectId, occurrences) =>
      recordQueryIntentOccurrences(projectId, occurrences, db),
    advanceWatermark: (projectId, through) => advanceQueryIntentsWatermark(projectId, through, db),
  };
}

test("demo: literal repeats collapse; a below-threshold near-duplicate and a distinct query each start their own", async () => {
  const { db } = await setup();
  const batch = [
    // 3 literal repeats — the exact-match / same-run Jaccard-dedup pass.
    ev("generate a changelog", 10),
    ev("generate a changelog", 9),
    ev("generate a changelog", 8),
    // 2 near-duplicates: Jaccard("generate a changelog", "make a changelog file") =
    // 0.25, just under the 0.3 merge threshold — so they stand as their own canonical.
    ev("make a changelog file", 6),
    ev("make a changelog file", 5),
    // A genuinely different ask.
    ev("review my pull request", 1, "search"),
  ];
  const { valid, rejected } = parseTraceEvents(batch);
  assert.equal(rejected.length, 0);
  await insertTraceEvents(PROJECT_ID, valid, db);

  const result = await categorizeProjectQueries(PROJECT_ID, realDeps(db));
  assert.equal(result.processed, 6);
  assert.equal(result.intentsCreated, 3);
  assert.equal(result.occurrencesAdded, 6);

  const items = await ledger(db);
  assert.equal(items.length, 3);
  assert.equal(items.find((i) => i.text === "generate a changelog")?.occurrences, 3);
  assert.equal(items.find((i) => i.text === "make a changelog file")?.occurrences, 2);
  assert.equal(items.find((i) => i.text === "review my pull request")?.occurrences, 1);
});

test("gateway_search events (MCP-gateway path) are categorized, not just direct-SDK search", async () => {
  // A project wired through the Ratel MCP gateway emits `gateway_search` for the
  // same `search_capabilities` call — regression guard for the miss that left
  // gateway projects with zero detected intents.
  const { db } = await setup();
  const { valid } = parseTraceEvents([
    ev("generate a changelog", 10, "gateway_search"),
    ev("generate a changelog", 9, "gateway_search"),
  ]);
  await insertTraceEvents(PROJECT_ID, valid, db);

  const result = await categorizeProjectQueries(PROJECT_ID, realDeps(db));
  assert.equal(result.processed, 2, "gateway_search events are read as search events");
  assert.equal(result.intentsCreated, 1);

  const items = await ledger(db);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text, "generate a changelog");
  assert.equal(items[0]?.occurrences, 2);
});

test("a second run against an unchanged window is a cheap no-op (watermark idempotency)", async () => {
  const { db } = await setup();
  const { valid } = parseTraceEvents([ev("generate a changelog", 1)]);
  await insertTraceEvents(PROJECT_ID, valid, db);

  const first = await categorizeProjectQueries(PROJECT_ID, realDeps(db));
  assert.equal(first.processed, 1);

  const second = await categorizeProjectQueries(PROJECT_ID, realDeps(db));
  assert.deepEqual(second, {
    processed: 0,
    intentsCreated: 0,
    occurrencesAdded: 0,
    usedExtractor: false,
  });

  const items = await ledger(db);
  assert.equal(items[0]?.occurrences, 1, "the no-op second run must not double-count");
});

test("a below-threshold near-duplicate stands as its own canonical (deterministic clustering, no LLM)", async () => {
  const { db } = await setup();
  const { valid } = parseTraceEvents([
    ev("generate a changelog", 5),
    ev("make a changelog file", 1),
  ]);
  await insertTraceEvents(PROJECT_ID, valid, db);

  const result = await categorizeProjectQueries(PROJECT_ID, realDeps(db));
  assert.equal(result.processed, 2);
  const items = await ledger(db);
  assert.equal(
    items.length,
    2,
    "Jaccard 0.25 < 0.3 -> two canonicals; nothing dropped or miscounted",
  );
});

test("Pass 1 exact-match resolves a repeat of a PREVIOUSLY-PERSISTED canonical WITHOUT invoking the clusterer", async () => {
  const { db } = await setup();
  await insertTraceEvents(PROJECT_ID, parseTraceEvents([ev("generate a changelog", 10)]).valid, db);
  await categorizeProjectQueries(PROJECT_ID, realDeps(db));

  // A brand-new event that's a LITERAL repeat of the now-persisted canonical.
  await insertTraceEvents(PROJECT_ID, parseTraceEvents([ev("generate a changelog", 1)]).valid, db);
  let clusterCalls = 0;
  const spyClusterer: Clusterer = {
    cluster: async (candidates, existing) => {
      clusterCalls++;
      return jaccardClusterer.cluster(candidates, existing);
    },
  };
  const result = await categorizeProjectQueries(PROJECT_ID, {
    ...realDeps(db),
    clusterer: spyClusterer,
  });

  assert.equal(result.processed, 1);
  assert.equal(
    clusterCalls,
    0,
    "an exact repeat resolves via Pass 1, never reaching the clusterer",
  );
  const items = await ledger(db);
  assert.equal(items.length, 1);
  assert.equal(items[0].occurrences, 2, "the repeat increments the existing canonical");
});

test("the pluggable clusterer is honored — a custom clusterer can override the canonical", async () => {
  const { db } = await setup();
  // Two lexically-distant asks (Jaccard 0) that the default clusterer would keep
  // separate; a custom clusterer groups every candidate under one canonical.
  await insertTraceEvents(
    PROJECT_ID,
    parseTraceEvents([ev("spin up a release note", 5), ev("draft the shipping summary", 1)]).valid,
    db,
  );
  const groupingClusterer: Clusterer = {
    cluster: async (candidates) => {
      const out = new Map<string, { normalizedText: string; canonicalText: string }>();
      for (const c of candidates) {
        out.set(c.key, {
          normalizedText: "publish release notes",
          canonicalText: "publish release notes",
        });
      }
      return out;
    },
  };
  const result = await categorizeProjectQueries(PROJECT_ID, {
    ...realDeps(db),
    clusterer: groupingClusterer,
  });

  assert.equal(result.processed, 2);
  const items = await ledger(db);
  assert.equal(
    items.length,
    1,
    "both distinct-worded asks collapsed into the custom clusterer's canonical",
  );
  assert.equal(items[0].text, "publish release notes");
  assert.equal(items[0].occurrences, 2);
});

test("recordQueryIntentOccurrences recomputes counts from the ledger (idempotent + self-healing)", async () => {
  const { db } = await setup();
  const occ = (traceEventId: string, minutesAgo: number) => ({
    traceEventId,
    query: "generate a changelog",
    occurredAt: new Date(BASE - minutesAgo * 60_000),
    sessionId: "s1",
    endUserId: null,
    normalizedText: "generate a changelog",
    canonicalText: "generate a changelog",
  });
  // We need real trace_events rows for the FK; seed two.
  await insertTraceEvents(
    PROJECT_ID,
    parseTraceEvents([ev("generate a changelog", 10), ev("generate a changelog", 5)]).valid,
    db,
  );
  const [{ id: a }, { id: b }] = await listNewSearchQueryEvents(PROJECT_ID, null, db);

  const first = await recordQueryIntentOccurrences(PROJECT_ID, [occ(a, 10)], db);
  assert.equal(first.occurrencesAdded, 1);
  let items = await ledger(db);
  assert.equal(items[0].occurrences, 1);

  // Re-record A (idempotent no-op) AND add B — recompute must yield 2, not 3.
  const second = await recordQueryIntentOccurrences(PROJECT_ID, [occ(a, 10), occ(b, 5)], db);
  assert.equal(second.occurrencesAdded, 1, "only B was genuinely new");
  items = await ledger(db);
  assert.equal(items[0].occurrences, 2, "count is the true ledger size, not an over-increment");
  assert.equal(
    items[0].lastSeenAt.getTime(),
    new Date(BASE - 5 * 60_000).getTime(),
    "lastSeenAt reflects the max occurred_at across the canonical's occurrences",
  );
});

test("a query_intents row with 0 occurrences (a race-orphaned zombie) is hidden from every read", async () => {
  const { db } = await setup();
  // Simulate the residual of a lost concurrent race: a canonical row that never got
  // any occurrence (occurrences defaults to 0).
  await db
    .insert(queryIntents)
    .values({ projectId: PROJECT_ID, normalizedText: "zombie ask", text: "zombie ask" });

  assert.deepEqual(await ledger(db), []);
  assert.deepEqual(
    await getQueryIntentsByNormalizedTexts(PROJECT_ID, ["zombie ask"], db),
    [],
    "a zombie is never resurrected as an exact-match target",
  );
  assert.deepEqual(
    await listQueryIntentsForMatching(PROJECT_ID, db),
    [],
    "nor offered as a fuzzy seed",
  );
});

test("advanceQueryIntentsWatermark never rewinds to an earlier time", async () => {
  const { db } = await setup();
  const later = new Date(BASE);
  const earlier = new Date(BASE - 60 * 60_000);

  await advanceQueryIntentsWatermark(PROJECT_ID, later, db);
  assert.equal((await getQueryIntentsWatermark(PROJECT_ID, db))?.getTime(), later.getTime());

  // A stale/overlapping run trying to set an EARLIER watermark must be ignored.
  await advanceQueryIntentsWatermark(PROJECT_ID, earlier, db);
  assert.equal(
    (await getQueryIntentsWatermark(PROJECT_ID, db))?.getTime(),
    later.getTime(),
    "the guard keeps the max, so a slow run can't rewind the cursor and cause re-processing",
  );
});

test("a tied-timestamp group straddling the batch limit is not lost across runs", async () => {
  const { db } = await setup();
  // BATCH_LIMIT is 500. Seed 498 events at strictly-increasing times, then a 4-way tie
  // at one final timestamp -> 502 total. Run 1 reads 500 (the 498 + 2 of the tie) and
  // must DEFER the whole tied group; run 2 must then pick up all 4.
  const distinct = Array.from({ length: 498 }, (_, i) => ev(`q${i}`, 600 - i)); // times 1..498 min ago (older->newer as i grows? 600-i decreasing)
  const tied = Array.from({ length: 4 }, (_, i) => ev(`tied-${i}`, 0)); // all share "now"
  const batch = [...distinct, ...tied];
  const { valid, rejected } = parseTraceEvents(batch);
  assert.equal(rejected.length, 0);
  assert.equal(valid.length, 502);
  await insertTraceEvents(PROJECT_ID, valid, db);

  // Use the real listNewSearchQueryEvents (which owns the trim) via realDeps.
  const run1 = await categorizeProjectQueries(PROJECT_ID, realDeps(db));
  assert.ok(run1.processed <= 500, "run 1 is bounded by the batch limit");
  assert.ok(run1.processed >= 498, "run 1 processed the non-tied prefix");

  const run2 = await categorizeProjectQueries(PROJECT_ID, realDeps(db));
  const run3 = await categorizeProjectQueries(PROJECT_ID, realDeps(db));

  const totalProcessed = run1.processed + run2.processed + run3.processed;
  assert.equal(
    totalProcessed,
    502,
    "every event is categorized across runs — the tied boundary group is never lost",
  );
  assert.equal(run3.processed, 0, "and the watermark converges (final run is a no-op)");
});

test("the occurrence ledger persists each search's end_user_id verbatim", async () => {
  const { db } = await setup();
  const { valid } = parseTraceEvents([
    ev("create a database migration", 10, "search", "u-ada"),
    ev("create a database migration", 9, "search", "u-ada"),
    ev("create a database migration", 8, "search", "u-bob"),
    ev("create a database migration", 6, "search"), // anonymous: no end-user
  ]);
  await insertTraceEvents(PROJECT_ID, valid, db);

  const run = await categorizeProjectQueries(PROJECT_ID, realDeps(db));
  assert.equal(run.processed, 4);

  const [intent] = await ledger(db);
  assert.equal(intent.occurrences, 4, "the canonical stays project-global (all users + anonymous)");

  const occs = await db
    .select({ endUserId: queryIntentOccurrences.endUserId })
    .from(queryIntentOccurrences)
    .where(eq(queryIntentOccurrences.queryIntentId, intent.id));
  assert.deepEqual(
    occs.map((o) => o.endUserId ?? "anonymous").sort(),
    ["anonymous", "u-ada", "u-ada", "u-bob"],
    "each occurrence row carries its source event's end-user, null when there was none",
  );
});

test("BM25 clusterer: a paraphrase in a LATER run merges into the earlier canonical, and member_text accumulates", async () => {
  const { db } = await setup();
  const bm25Deps = (): QueryIntentsDeps => ({ ...realDeps(db), clusterer: new Bm25Clusterer() });

  // Run 1: the ask as Orbitals phrased it the first time.
  await insertTraceEvents(
    PROJECT_ID,
    parseTraceEvents([ev("cancel their plan following the refund request", 10)]).valid,
    db,
  );
  const first = await categorizeProjectQueries(PROJECT_ID, bm25Deps());
  assert.equal(first.intentsCreated, 1);

  // Run 2: two more phrasings of the same ask (observed on staging), plus a different one.
  await insertTraceEvents(
    PROJECT_ID,
    parseTraceEvents([
      ev("cancel their plan after the requested refund is processed", 5),
      ev("cancel their plan after receiving a refund for the double charge", 4),
      ev("write unit tests for the parser", 1),
    ]).valid,
    db,
  );
  const second = await categorizeProjectQueries(PROJECT_ID, bm25Deps());
  assert.equal(second.processed, 3);
  assert.equal(second.intentsCreated, 1, "only the unit-tests ask is new; both paraphrases merged");

  const items = await ledger(db);
  assert.equal(items.length, 2);
  const cancel = items.find((i) => i.text === "cancel their plan following the refund request");
  assert.equal(cancel?.occurrences, 3);

  // The cluster's vocabulary now carries the two absorbed phrasings (not its own text).
  const [row] = await db
    .select({ memberText: queryIntents.memberText })
    .from(queryIntents)
    .where(eq(queryIntents.id, cancel!.id));
  assert.deepEqual(row?.memberText.split("\n"), [
    "cancel their plan after the requested refund is processed",
    "cancel their plan after receiving a refund for the double charge",
  ]);
});
