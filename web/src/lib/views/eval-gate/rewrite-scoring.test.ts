import assert from "node:assert/strict";
import { test } from "node:test";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import { type ReplayCase, replay } from "@/lib/synthesis/match-quality/replay";
import { toolEffectView } from "@/lib/synthesis/match-quality/tool-effect";
import { emptyChange } from "./change";
import { defaultExpected } from "./defaults";
import { createRanker } from "./ranker";
import { scoreCase, summarize } from "./score";
import { searchFor, simulateRun } from "./simulate";
import type { CaseResult, EvalCase, FixChange, RunRecord } from "./types";

/**
 * RC-77 regression: the `search_hotels` description rewrite (rewrite:338fa66e
 * on the Meridian demo) scored "not in the list" in 17 of the 20 runs that
 * called `search_hotels`, while the fix's own metric (Quality's backtest over
 * the same searches) read +16 pts. Each of those runs opens with a skill lookup
 * (`skill_search`, "weekend trip planner"), and the eval scored the right tool
 * against the run's first search: the skill lookup, ranked again against the
 * tool catalog. The tool search the agent made for the hotel came second.
 */

const tool = (entryId: string, searchable: string): CorpusEntry => ({
  entryId,
  name: entryId,
  searchable,
  source: "runtime",
  matchesAgentDescription: true,
  tags: [],
});

const CORPUS: CorpusEntry[] = [
  tool("search_hotels", "Search the stays inventory by city and dates."),
  tool("search_flights", "Search flights between two airports on a date."),
  tool("find_booking", "Find a booking by its reference."),
  tool("cancel_hotel_booking", "Cancel a hotel booking and say what the hotel keeps."),
  tool("book_disruption_hotel", "IROPS accommodation for disrupted travelers."),
  tool("get_seat_map", "Show the seat map for a flight."),
  tool("rent_car", "Book a rental car at a location."),
];

const REWRITE =
  "Search hotels by city, dates or landmark: find a hotel, a hotel near a place, book me a hotel, a hotel for a few nights.";
const CHANGE: FixChange = { ...emptyChange(), patches: { search_hotels: REWRITE } };

/** What the agent asked, and the three tools it was served (the window it saw). */
const ASKS: { query: string; served: string[] }[] = [
  {
    query: "Find a hotel in Lisbon for 3 nights",
    served: ["cancel_hotel_booking", "book_disruption_hotel", "search_hotels"],
  },
  {
    query: "I need a hotel near the Eiffel Tower",
    served: ["cancel_hotel_booking", "book_disruption_hotel", "find_booking"],
  },
  {
    query: "Book me a hotel in Rome from Friday",
    served: ["cancel_hotel_booking", "find_booking", "book_disruption_hotel"],
  },
  {
    query: "Find a hotel in Madrid for 5 nights",
    served: ["search_hotels", "cancel_hotel_booking", "find_booking"],
  },
  {
    query: "I need a hotel near the Colosseum",
    served: ["cancel_hotel_booking", "book_disruption_hotel", "find_booking"],
  },
  {
    query: "Book me a hotel in Porto from Monday",
    served: ["cancel_hotel_booking", "find_booking", "rent_car"],
  },
];

const turnId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

/** A Meridian hotel run as the turn ledger records it: the skill lookup and load, then the tool search, then the call. */
function hotelRun(n: number, ask: (typeof ASKS)[number]): RunRecord {
  return {
    turnId: turnId(n),
    traceId: `trace-${n}`,
    startedAt: "2026-11-01T00:00:00.000Z",
    taskId: null,
    steps: [
      {
        kind: "search",
        ordinal: 1,
        searchType: "skill_search",
        query: "weekend trip planner",
        hitIds: ["weekend-trip-planner"],
        topK: 3,
      },
      { kind: "invoke", ordinal: 2, targetId: "weekend-trip-planner", outcome: "ok" },
      {
        kind: "search",
        ordinal: 3,
        searchType: "search",
        query: ask.query,
        hitIds: ask.served,
        topK: 3,
      },
      { kind: "invoke", ordinal: 4, targetId: "search_hotels", outcome: "ok" },
      { kind: "invoke", ordinal: 5, targetId: "check_room_availability", outcome: "ok" },
    ],
  };
}

test("a rewrite eval scores the tool against the search it was looked for in, not the run's skill lookup", () => {
  const run = hotelRun(1, ASKS[0]!);
  assert.equal(searchFor(run, "search_hotels")?.ordinal, 3);
  // A run that never called the tool reads its first tool search; a skill lookup is never one.
  assert.equal(searchFor(run, "book_disruption_hotel")?.ordinal, 3);
  assert.equal(searchFor(run)?.ordinal, 3);
});

test("the rewrite eval agrees with the fix's own metric on the same searches (search_hotels, rewrite:338fa66e)", () => {
  const ranker = createRanker(CORPUS, CHANGE);
  assert.ok(ranker);
  const runs = ASKS.map((ask, index) => hotelRun(index + 1, ask));

  const results: CaseResult[] = runs.map((run) => {
    const expected = defaultExpected(run, "rewrite", CHANGE, ["search_hotels"]);
    assert.equal(expected.tool, "search_hotels");
    const item: Pick<EvalCase, "id" | "turnId" | "expected"> = {
      id: run.turnId,
      turnId: run.turnId,
      expected,
    };
    const result = scoreCase(item, simulateRun(run, CHANGE, ranker, expected.tool), CHANGE);
    return { ...result, role: "holdout", method: "rerank" };
  });

  // The fix's metric: Quality's backtest over the same searches, each labelled with the tool invoked from it.
  const cases: ReplayCase[] = ASKS.map((ask, index) => ({
    queryKey: ask.query.toLowerCase(),
    query: ask.query,
    targetEntryId: "search_hotels",
    source: "invoked",
    servedIds: ask.served,
    baselineIds: null,
    occurredAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
  }));
  const metric = toolEffectView(
    replay(CORPUS, cases, [{ entryId: "search_hotels", searchableDescription: REWRITE }]),
    "search_hotels",
  );
  assert.ok(metric);
  assert.ok(
    metric.containedAfter > metric.containedBefore,
    "the fixture is a rewrite that helps, as the fix's metric said",
  );

  const summary = summarize(results, "rc-77");
  assert.equal(summary.nSimulated, ASKS.length);
  // Same searches, same engine, same window: the eval's passes are the metric's in-list counts.
  assert.equal(summary.before.passed, metric.containedBefore);
  assert.equal(summary.after.passed, metric.containedAfter);
  for (const result of results) {
    const reading = result.after?.checks.find((check) => check.kind === "right_tool");
    assert.ok(reading);
    if (!reading.pass) assert.equal(reading.detail, "not in the list");
  }
  assert.ok(
    results.some((result) =>
      result.after?.checks.some((check) => check.kind === "right_tool" && check.pass),
    ),
    "the rewritten tool is found after the fix",
  );
});
