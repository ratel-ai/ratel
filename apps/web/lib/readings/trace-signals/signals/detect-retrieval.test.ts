import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accumulateTurn,
  createProjectStats,
} from "@/lib/readings/trace-signals/signals/accumulators";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import { round4 } from "@/lib/readings/trace-signals/signals/build";
import { detectRetrieval } from "@/lib/readings/trace-signals/signals/detect-retrieval";
import { wilsonHigh, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import {
  contextFor,
  fresh,
  signalTurns,
  statsOf,
  times,
  withFloors,
} from "@/lib/readings/trace-signals/signals/test-fixtures";

function kinds(result: ReturnType<typeof detectRetrieval>, kind: string) {
  return result.signals.filter((s) => s.kind === kind);
}

/**
 * `direct` turns find `tool` in the first search; `retried` ones ask the same
 * thing twice (same query, so the same salted hash) and only the second list
 * has it. With `lowInFirst`, an older search for the same ask listed it low,
 * the one before the retry did not.
 */
function firstTryTurns(direct: number, retried: number, lowInFirst = false) {
  const ask = { query: "open the pricing doc" };
  return signalTurns([
    ...times(direct, () => fresh().search(["tool", "other"]).invoke("tool")),
    ...times(retried, () =>
      lowInFirst
        ? fresh()
            .search(["x", "y", "z", "tool"], ask)
            .search(["x", "y"], ask)
            .search(["tool"], ask)
            .invoke("tool")
        : fresh().search(["x", "y"], ask).search(["tool"], ask).invoke("tool"),
    ),
  ]);
}

test("first_try_miss fires above its floor with the Wilson lower bound as severity", () => {
  const stats = statsOf(firstTryTurns(5, 5));
  const [signal] = kinds(detectRetrieval(stats), "first_try_miss");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "tool");
  assert.equal(signal.n, 10);
  assert.equal(signal.metrics.k, 5);
  assert.equal(signal.severity, round4(wilsonLow(5, 10)));
  assert.equal(signal.impact, 5);
  assert.equal(signal.route, "rewrite_description");
  assert.equal(signal.evidence.turnIds.length, 5);
});

test("first_try_miss emits nothing below its count floor and fires exactly at a lowered share floor", () => {
  assert.equal(kinds(detectRetrieval(statsOf(firstTryTurns(8, 2))), "first_try_miss").length, 0);
  const atFloor = statsOf(firstTryTurns(7, 3));
  assert.equal(
    kinds(detectRetrieval(atFloor), "first_try_miss").length,
    0,
    "3 of 10 is under the 0.15 bound",
  );
  const floors = withFloors("first_try_miss", { minLow: wilsonLow(3, 10) });
  assert.equal(kinds(detectRetrieval(atFloor, floors), "first_try_miss").length, 1);
});

test("first_try_miss routes to adaptive ranking when an older list for the same ask had the tool, low", () => {
  const [signal] = kinds(detectRetrieval(statsOf(firstTryTurns(5, 5, true))), "first_try_miss");
  assert.equal(signal?.route, "adaptive_ranking");
  assert.equal(signal?.metrics.inFirstSearchLow, 5);
  assert.equal(signal?.impact, 10, "two same-ask searches spent before the one that worked");
});

test("a later search for a new need in a multi-step turn is not a first-try miss", () => {
  // "find the Q3 roadmap review" -> find_task, then "change its priority" -> update_task at #8.
  const twoNeeds = () =>
    fresh()
      .search(["find_task", "search_tasks", "list_projects"], {
        query: "find the Q3 roadmap review",
      })
      .invoke("find_task")
      .search(
        ["search_tasks", "list_task_comments", "create_task", "a", "b", "c", "d", "update_task"],
        {
          query: "change the priority of the Q3 roadmap review",
        },
      )
      .invoke("update_task");
  const stats = statsOf(signalTurns(times(20, twoNeeds)));
  assert.equal(kinds(detectRetrieval(stats), "first_try_miss").length, 0);
  assert.equal(
    kinds(detectRetrieval(stats), "buried_tool")[0]?.subjectKey,
    "update_task",
    "the #8 pick is a buried tool",
  );
});

test("a retry is judged by hit overlap when there is no query text", () => {
  // No query captured: {x,y,z} then {tool,x,y} share 2 of 4 = 0.5, the same-ask bar.
  const retry = () =>
    fresh()
      .search(["x", "y", "z"], { query: "" })
      .search(["tool", "x", "y"], { query: "" })
      .invoke("tool");
  const fresher = () =>
    fresh()
      .search(["x", "y", "z", "w"], { query: "" })
      .search(["tool", "x", "q", "r"], { query: "" })
      .invoke("tool");
  assert.equal(
    kinds(detectRetrieval(statsOf(signalTurns(times(10, retry)))), "first_try_miss").length,
    1,
    "at the bar",
  );
  assert.equal(
    kinds(detectRetrieval(statsOf(signalTurns(times(10, fresher)))), "first_try_miss").length,
    0,
    "1 of 7 shared",
  );
});

test("buried_tool fires when picks sit at #4 or lower often enough", () => {
  const buried = (n: number) =>
    times(n, () => fresh().search(["a", "b", "c", "tool"]).invoke("tool"));
  const top = (n: number) => times(n, () => fresh().search(["tool", "a"]).invoke("tool"));
  const fires = statsOf(signalTurns([...buried(6), ...top(4)]));
  const [signal] = kinds(detectRetrieval(fires), "buried_tool");
  assert.equal(signal?.severity, round4(wilsonLow(6, 10)));
  assert.equal(signal?.metrics.medianRank, 4);
  assert.deepEqual(signal?.metrics.rankBands, [4, 6, 0, 0]);
  const quiet = statsOf(signalTurns([...buried(5), ...top(5)]));
  assert.equal(
    kinds(detectRetrieval(quiet), "buried_tool").length,
    0,
    "5 of 10 is under the 0.3 bound",
  );
});

test("magnet fires only once enough impressions rule out a real pick rate", () => {
  const listedNeverPicked = (n: number) =>
    times(n, () => fresh().search(["magnet", "right"]).invoke("right"));
  const many = statsOf(signalTurns(listedNeverPicked(130)));
  const [signal] = kinds(detectRetrieval(many), "magnet");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "magnet");
  assert.equal(signal.severity, round4(wilsonLow(130, 130)), "every top-3 slot it took was wasted");
  assert.equal(signal.impact, 130, "every impression was in the top 3");
  assert.equal(signal.metrics.listShare, 1);

  const few = statsOf(signalTurns(listedNeverPicked(60)));
  assert.equal(
    kinds(detectRetrieval(few), "magnet").length,
    0,
    "0 of 60 still allows a 6% pick rate",
  );
  const lenient = withFloors("magnet", { maxHigh: wilsonHigh(0, 60) });
  assert.equal(kinds(detectRetrieval(few, lenient), "magnet").length, 1);
});

test("a filler padding ranks 8 to 10 of long lists is not a magnet, however often it is listed", () => {
  const filler = ["a", "b", "c", "d", "e", "f", "g", "filler", "i", "j"];
  const stats = statsOf(signalTurns(times(500, () => fresh().search(filler).invoke("a"))));
  const entry = stats.entries.get("tool:filler");
  assert.equal(entry?.impressions, 500);
  assert.equal(entry?.impressionsTop3, 0);
  const magnets = (floors = withFloors("magnet", {})) =>
    kinds(detectRetrieval(stats, floors), "magnet").map((s) => s.subjectKey);
  // `b` and `c` hold #2 and #3 in every list and are never picked: those are magnets.
  assert.deepEqual(magnets().sort(), ["b", "c"]);
  // Even with every other floor waved through, the top-3 floor keeps the filler out.
  assert.ok(!magnets(withFloors("magnet", { maxHigh: 1, minImpressions: 1 })).includes("filler"));
});

test("magnet severity and impact read top-3 listings, and the top-3 floor is exact", () => {
  // `magnet` sits at #2 in `prominent` lists and #9 in `tail` lists; never picked.
  // The other hits vary per turn so only `magnet` can clear any floor.
  const turns = (prominent: number, tail: number) =>
    signalTurns([
      ...times(prominent, (i) =>
        fresh()
          .search(["right", "magnet", `x${i}`])
          .invoke("right"),
      ),
      ...times(tail, (i) =>
        fresh()
          .search([
            "right",
            ...["a", "b", "c", "d", "e", "f", "g"].map((h) => `${h}${i}`),
            "magnet",
          ])
          .invoke("right"),
      ),
    ]);
  const of = (result: ReturnType<typeof detectRetrieval>) =>
    kinds(result, "magnet").filter((s) => s.subjectKey === "magnet");
  const [signal] = of(detectRetrieval(statsOf(turns(130, 400))));
  assert.ok(signal);
  assert.equal(signal.impact, 130, "impact counts top-3 slots, not the 530 listings");
  assert.equal(
    signal.severity,
    round4(wilsonLow(130, 130)),
    "severity: the share of its top-3 slots that were wasted",
  );
  assert.equal(signal.metrics.impressions, 530);
  assert.equal(signal.metrics.impressionsTop3, 130);

  // Listed in 625 searches, never picked, and in the top three of 25 of them:
  // past the count floor, but too small a share of searches to be a magnet.
  const rare = statsOf(turns(25, 600));
  assert.equal(of(detectRetrieval(rare)).length, 0);
  assert.ok(wilsonLow(25, 625) < 0.05);
  assert.equal(
    of(detectRetrieval(rare, withFloors("magnet", { minTop3Low: 0 }))).length,
    1,
    "it is the share floor",
  );

  const floorOnly = withFloors("magnet", { maxHigh: 1, minTop3Low: 0, minTop3Impressions: 20 });
  assert.equal(
    of(detectRetrieval(statsOf(turns(19, 100)), floorOnly)).length,
    0,
    "19 top-3 slots is under the floor",
  );
  assert.equal(of(detectRetrieval(statsOf(turns(20, 100)), floorOnly)).length, 1, "20 is at it");
});

test("a stray pick lowers a magnet's severity, and crowding shows in its impact", () => {
  // `crowder` holds #2 in 300 of 400 searches and is picked 3 times; `lurker`
  // holds #3 in 247 and is never picked. Both are magnets.
  const turns = signalTurns([
    ...times(3, (i) =>
      fresh()
        .search(["right", "crowder", `a${i}`])
        .invoke("crowder"),
    ),
    ...times(147, (i) =>
      fresh()
        .search(["right", "crowder", "lurker", `b${i}`])
        .invoke("right"),
    ),
    ...times(150, (i) =>
      fresh()
        .search(["right", "crowder", `c${i}`])
        .invoke("right"),
    ),
    ...times(100, (i) =>
      fresh()
        .search(["right", `d${i}`, "lurker"])
        .invoke("right"),
    ),
  ]);
  const magnets = kinds(detectRetrieval(statsOf(turns)), "magnet");
  const crowder = magnets.find((s) => s.subjectKey === "crowder");
  const lurker = magnets.find((s) => s.subjectKey === "lurker");
  assert.ok(crowder && lurker);
  assert.equal(crowder.severity, round4(wilsonLow(297, 300)), "its 3 picks count against it");
  assert.equal(lurker.severity, round4(wilsonLow(247, 247)));
  assert.equal(crowder.metrics.picks, 3);
  assert.equal(crowder.impact, 300);
  assert.equal(lurker.impact, 247);
});

test("padding_share fires on padded lists and stays quiet below the search floor", () => {
  const hits = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const scores = [1, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1];
  const padded = (n: number) =>
    times(n, () => fresh().search(hits, { scores, topK: 10 }).invoke("a"));
  const [signal] = kinds(detectRetrieval(statsOf(signalTurns(padded(100)))), "padding_share");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "project");
  assert.equal(signal.metrics.junkHits, 900);
  assert.equal(signal.metrics.medianTopK, 10);
  assert.equal(signal.metrics.byRank, true);
  assert.equal(signal.route, "lower_top_k");
  assert.equal(signal.severity, round4(Math.max(wilsonLow(900, 1000), wilsonLow(100, 100))));
  assert.equal(kinds(detectRetrieval(statsOf(signalTurns(padded(99)))), "padding_share").length, 0);
});

test("unstable_intent groups turns by their first query and needs three first tools", () => {
  const ask = (tool: string) =>
    fresh().search(["a", "b", "c"], { query: "what is on my plate" }).invoke(tool);
  const unstable = signalTurns([
    ...times(3, () => ask("a")),
    ...times(3, () => ask("b")),
    ...times(2, () => ask("c")),
  ]);
  const [signal] = kinds(detectRetrieval(statsOf(unstable)), "unstable_intent");
  assert.ok(signal);
  assert.match(signal.subjectKey, /^q:[0-9a-f]{32}$/);
  assert.equal(signal.n, 8);
  assert.equal(signal.metrics.distinct, 3);
  assert.equal(signal.severity, round4(wilsonLow(5, 8)));
  assert.deepEqual(signal.subjectIds, ["a", "b", "c"]);

  const short = signalTurns([
    ...times(3, () => ask("a")),
    ...times(2, () => ask("b")),
    ...times(2, () => ask("c")),
  ]);
  assert.equal(kinds(detectRetrieval(statsOf(short)), "unstable_intent").length, 0);
});

test("the query-hash counters are capped, and a hash with n>=8 survives a flood of singletons", () => {
  const ask = (tool: string) =>
    fresh().search(["a", "b", "c"], { query: "what is on my plate" }).invoke(tool);
  const stable = [
    ...times(3, () => ask("a")),
    ...times(3, () => ask("b")),
    ...times(2, () => ask("c")),
  ];
  const flood = times(500, (i) =>
    fresh()
      .search(["a"], { query: `one-off ask ${i}` })
      .invoke("a"),
  );
  const turns = signalTurns([...stable, ...flood, ask("a")]);
  const stats = createProjectStats(50);
  for (const t of turns) accumulateTurn(stats, t);

  assert.ok(stats.queries.size <= 50, "never more than the cap");
  assert.ok(stats.queriesEvicted >= 450);
  const [signal] = kinds(detectRetrieval(stats), "unstable_intent");
  assert.equal(signal?.n, 9, "the busy hash kept every turn, including one after the flood");

  const result = analyzeTurns(turns, contextFor(turns), { maxQueryHashes: 50 });
  assert.equal(result.summary.queriesTruncated, true);
  const plain = signalTurns([ask("a")]);
  assert.equal(analyzeTurns(plain, contextFor(plain)).summary.queriesTruncated, false);
});
