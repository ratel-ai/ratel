import assert from "node:assert/strict";
import { test } from "node:test";
import {
  categorizeProjectQueries,
  type ExistingCanonical,
  type QueryIntentsDeps,
  type RawQueryEvent,
} from "@/lib/readings/query-intents/pipeline";

const PROJECT_ID = "project-1";

/** A tiny in-memory fake of the DB surface, so the pipeline's decisions can be
 * asserted against actual persisted state (including across repeated runs). */
function makeFakeStore() {
  let watermark: Date | null = null;
  const canonicals = new Map<string, ExistingCanonical & { occurrences: number }>(); // by normalizedText
  const seenKeys = new Set<string>(); // `${traceEventId}#${intentIndex}` — the composite key
  const recordCalls: number[] = []; // batch sizes, for call-count assertions

  const liveCanonicals = () => [...canonicals.values()].filter((c) => c.occurrences > 0); // zombie rows (0) are hidden, like the real reads

  const deps: Omit<QueryIntentsDeps, "listNewSearchEvents"> = {
    getWatermark: async () => watermark,
    lookupExactCanonicals: async (_projectId, normalizedTexts) => {
      const wanted = new Set(normalizedTexts);
      return liveCanonicals()
        .filter((c) => wanted.has(c.normalizedText))
        .map(({ id, normalizedText, text }) => ({ id, normalizedText, text }));
    },
    listExistingCanonicals: async () =>
      liveCanonicals().map(({ id, normalizedText, text }) => ({ id, normalizedText, text })),
    recordOccurrences: async (_projectId, occurrences) => {
      recordCalls.push(occurrences.length);
      let intentsCreated = 0;
      let occurrencesAdded = 0;
      for (const o of occurrences) {
        const key = `${o.traceEventId}#${o.intentIndex}`;
        if (seenKeys.has(key)) continue; // idempotent on (trace_event_id, intent_index)
        seenKeys.add(key);
        occurrencesAdded++;
        let c = canonicals.get(o.normalizedText);
        if (!c) {
          c = {
            id: `intent-${canonicals.size + 1}`,
            normalizedText: o.normalizedText,
            text: o.canonicalText,
            occurrences: 0,
          };
          canonicals.set(o.normalizedText, c);
          intentsCreated++;
        }
        c.occurrences++;
      }
      return { intentsCreated, occurrencesAdded };
    },
    advanceWatermark: async (_projectId, through) => {
      // Replicate the real advanceQueryIntentsWatermark's never-rewind guard so a
      // regression in the pipeline's watermark handling would surface here too.
      if (!watermark || through > watermark) watermark = through;
    },
  };

  return { deps, canonicals, recordCalls, getWatermark: () => watermark };
}

function event(
  id: string,
  query: string,
  minutesAgo: number,
  sessionId: string | null = "s1",
): RawQueryEvent {
  return { id, query, occurredAt: new Date(2026, 0, 1, 0, minutesAgo), sessionId, endUserId: null };
}

test("exact repeats collapse via the cheap pass; a genuinely different query stays separate", async () => {
  const store = makeFakeStore();
  const events = [
    event("e1", "generate a changelog", 1),
    event("e2", "generate a changelog", 2),
    event("e3", "generate a changelog", 3),
    event("e4", "review my pull request", 4),
  ];
  const result = await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async () => events,
  });

  assert.equal(result.processed, 4);
  assert.equal(store.canonicals.size, 2);
  const changelog = store.canonicals.get("generate a changelog");
  const pr = store.canonicals.get("review my pull request");
  assert.equal(changelog?.occurrences, 3);
  assert.equal(pr?.occurrences, 1);
});

test("a Jaccard-mergeable phrasing collapses into the existing canonical", async () => {
  const store = makeFakeStore();
  await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async () => [event("e1", "read and update Notion pages", 1)],
  });
  assert.equal(store.canonicals.size, 1);

  const result = await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async (_p, since) =>
      [event("e2", "notion search pages", 2)].filter((e) => !since || e.occurredAt > since),
  });

  assert.equal(result.processed, 1);
  assert.equal(store.canonicals.size, 1);
  const canonical = store.canonicals.get("read and update notion pages");
  assert.equal(canonical?.occurrences, 2);
});

test("a near-duplicate below the Jaccard threshold stands as its own canonical rather than being dropped", async () => {
  const store = makeFakeStore();
  await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async () => [event("e1", "generate a changelog", 1)],
  });

  const result = await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async (_p, since) =>
      [event("e2", "make a changelog file", 2)].filter((e) => !since || e.occurredAt > since),
  });

  // Jaccard("generate a changelog", "make a changelog file") = 0.25 < 0.3, so it does
  // not merge — it stands as its own canonical (never dropped). No LLM is involved.
  assert.equal(result.processed, 1);
  assert.equal(store.canonicals.size, 2);
  assert.equal(store.canonicals.get("make a changelog file")?.occurrences, 1);
});

test("two same-run near-duplicates with no existing canonical cluster together via Jaccard", async () => {
  const store = makeFakeStore();
  const result = await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async () => [
      event("e1", "read and update Notion pages", 1),
      event("e2", "notion search pages", 2),
    ],
  });
  assert.equal(result.processed, 2);
  assert.equal(store.canonicals.size, 1);
  assert.equal([...store.canonicals.values()][0].occurrences, 2);
});

test("no new events since the watermark is a cheap no-op", async () => {
  const store = makeFakeStore();
  let listCalls = 0;
  const result = await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async () => {
      listCalls++;
      return [];
    },
  });
  assert.deepEqual(result, {
    processed: 0,
    intentsCreated: 0,
    occurrencesAdded: 0,
    usedExtractor: false,
  });
  assert.equal(listCalls, 1);
  assert.equal(store.recordCalls.length, 0, "recordOccurrences must not run on an empty batch");
});

test("the watermark advances to the max occurredAt actually processed, not to now", async () => {
  const store = makeFakeStore();
  await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async () => [event("e1", "review my pull request", 5)],
  });
  assert.deepEqual(store.getWatermark(), new Date(2026, 0, 1, 0, 5));
});

test("a failed record does not advance the watermark, so a retry re-reads the same window", async () => {
  const store = makeFakeStore();
  let attempt = 0;
  const deps: QueryIntentsDeps = {
    ...store.deps,
    listNewSearchEvents: async () => [event("e1", "review my pull request", 1)],
    recordOccurrences: async (projectId, occurrences) => {
      attempt++;
      if (attempt === 1) throw new Error("simulated DB failure");
      return store.deps.recordOccurrences(projectId, occurrences);
    },
  };

  await assert.rejects(() => categorizeProjectQueries(PROJECT_ID, deps));
  assert.equal(store.getWatermark(), null);

  const result = await categorizeProjectQueries(PROJECT_ID, deps);
  assert.equal(result.processed, 1);
  assert.equal(store.canonicals.size, 1);
});

test("endUserId flows from the raw event into the recorded occurrence (and null stays null)", async () => {
  const store = makeFakeStore();
  const recorded: Array<{ traceEventId: string; endUserId: string | null }> = [];
  const result = await categorizeProjectQueries(PROJECT_ID, {
    ...store.deps,
    listNewSearchEvents: async () => [
      { ...event("e1", "generate a changelog", 1), endUserId: "u-ada" },
      event("e2", "generate a changelog", 2), // no end-user on this one
    ],
    recordOccurrences: async (projectId, occurrences) => {
      recorded.push(
        ...occurrences.map((o) => ({ traceEventId: o.traceEventId, endUserId: o.endUserId })),
      );
      return store.deps.recordOccurrences(projectId, occurrences);
    },
  });

  assert.equal(result.processed, 2);
  assert.deepEqual(
    recorded.sort((a, b) => a.traceEventId.localeCompare(b.traceEventId)),
    [
      { traceEventId: "e1", endUserId: "u-ada" },
      { traceEventId: "e2", endUserId: null },
    ],
    "the ledger row carries the source event's end-user verbatim",
  );
});
