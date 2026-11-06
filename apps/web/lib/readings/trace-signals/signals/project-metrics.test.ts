import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import { flowView } from "@/lib/readings/trace-signals/signals/flow-model";
import {
  captureLevelOf,
  DailyBuckets,
  shapesFor,
  tilesFor,
  totalOver,
  windowDays,
} from "@/lib/readings/trace-signals/signals/project-metrics";
import { wilson } from "@/lib/readings/trace-signals/signals/severity";
import {
  contextFor,
  fresh,
  signalTurns,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import { classifyTurnShape } from "@/lib/readings/trace-signals/signals/turn-facts";
import { TURN_SHAPE_KINDS } from "@/lib/readings/trace-signals/view";

const DAY_MS = 86_400_000;
const END = new Date("2026-09-28T00:00:00Z");

/** Two searches with the same query: a retry of one ask (same salted hash). */
const SAME = { query: "open the pricing doc" };

/** One fixture turn per shape, in shape order. */
function oneOfEach() {
  return signalTurns([
    fresh().search(["a"]).invoke("a"),
    fresh().search(["x"], SAME).search(["a"], SAME).invoke("a"),
    fresh().search(["a"]),
    fresh().search(["a"]).invoke("a").error("a").invoke("a"),
    fresh().invoke("a"),
    fresh().search(["a"]).invoke("a").invoke("a"),
  ]);
}

test("each turn takes exactly one shape, with waste shapes first", () => {
  assert.deepEqual(oneOfEach().map(classifyTurnShape), [
    "direct",
    "detour",
    "dead_end",
    "retry",
    "blind",
    "repeat",
  ]);
  const [retryAndDetour] = signalTurns([
    fresh().search(["x"], SAME).search(["a"], SAME).invoke("a").error("a").invoke("a"),
  ]);
  assert.equal(classifyTurnShape(retryAndDetour!), "retry");
  const [twoNeeds] = signalTurns([fresh().search(["x"]).invoke("x").search(["a"]).invoke("a")]);
  assert.equal(
    classifyTurnShape(twoNeeds!),
    "direct",
    "a fresh search for a new need is not a detour",
  );
});

test("the shapes partition the measurable turns and sort by count", () => {
  const turns = [...oneOfEach(), ...signalTurns(times(3, () => fresh().search(["a"]).invoke("a")))];
  const buckets = new DailyBuckets();
  for (const t of turns) buckets.add(t);
  const total = totalOver(
    buckets.values(),
    buckets.values().map((b) => b.day),
  );
  const shapes = shapesFor(total);
  assert.equal(
    shapes.reduce((sum, s) => sum + s.count, 0),
    turns.length,
  );
  assert.equal(shapes[0]?.shape, "direct");
  assert.equal(shapes[0]?.count, 4);
  assert.deepEqual(new Set(shapes.map((s) => s.shape)), new Set(TURN_SHAPE_KINDS));
  assert.ok(Math.abs(shapes.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9);
});

function bucketsOver(days: number, perDay: (day: number) => { firstTry: number; missed: number }) {
  const buckets = new DailyBuckets();
  for (let d = 0; d < days; d++) {
    const start = new Date(END.getTime() - (d + 1) * DAY_MS + 3_600_000);
    const { firstTry, missed } = perDay(d);
    const turns = signalTurns([
      ...times(firstTry, () => fresh({ start }).search(["a"]).invoke("a")),
      ...times(missed, () => fresh({ start }).search(["x"], SAME).search(["a"], SAME).invoke("a")),
    ]);
    for (const t of turns) buckets.add(t);
  }
  return buckets.values();
}

test("the first-try tile counts a two-step turn with a fresh search per need", () => {
  const buckets = new DailyBuckets();
  for (const t of signalTurns(
    times(4, () => fresh().search(["find"]).invoke("find").search(["assign"]).invoke("assign")),
  ))
    buckets.add(t);
  const total = totalOver(
    buckets.values(),
    buckets.values().map((b) => b.day),
  );
  assert.equal(total.firstTry, 4);
  assert.equal(total.firstTryN, 4);
  assert.equal(total.detours, 0);
});

test("tiles carry the Wilson interval of their share, a 7-day series and a delta", () => {
  // This week: 6 of 10 found first try each day; the week before: 4 of 10.
  const daily = bucketsOver(14, (d) =>
    d < 7 ? { firstTry: 6, missed: 4 } : { firstTry: 4, missed: 6 },
  );
  const tiles = tilesFor(daily, { end: END, days: 7, coveredFrom: daily[0]!.day, floor: 50 });
  const firstTry = tiles.find((t) => t.key === "first_try")!;
  assert.equal(firstTry.value, 0.6);
  assert.deepEqual(firstTry.interval, wilson(42, 70));
  assert.equal(firstTry.n, 70);
  assert.ok(Math.abs((firstTry.delta ?? 0) - 0.2) < 1e-9);
  assert.equal(firstTry.series.length, 7);
  assert.equal(firstTry.series.at(-1)?.value, 0.6);
  assert.equal(firstTry.upIsGood, true);
  const detours = tiles.find((t) => t.key === "detours")!;
  assert.equal(detours.value, 0.4);
  assert.equal(detours.upIsGood, false);
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["first_try", "detours", "junk", "wasted_calls"],
  );
});

test("tiles show no figure under the floor and no delta without a covered previous window", () => {
  const daily = bucketsOver(7, () => ({ firstTry: 1, missed: 1 }));
  const thin = tilesFor(daily, { end: END, days: 7, coveredFrom: daily[0]!.day, floor: 50 });
  assert.ok(thin.every((t) => t.value === null && t.interval === null && t.delta === null));
  const ready = tilesFor(daily, { end: END, days: 7, coveredFrom: daily[0]!.day, floor: 10 });
  assert.ok(
    ready.every((t) => t.delta === null),
    "the week before is outside the scan",
  );
  assert.equal(windowDays(END, 2).join(","), "2026-09-26,2026-09-27");
});

test("capture level: content when most searches carried text, tools with tool ids, else events", () => {
  const buckets = new DailyBuckets();
  for (const t of signalTurns(times(4, () => fresh().search(["a"]).invoke("a")))) buckets.add(t);
  const total = totalOver(
    buckets.values(),
    buckets.values().map((b) => b.day),
  );
  assert.equal(captureLevelOf(total), "content", "fixture searches carry a query");
  assert.equal(captureLevelOf({ ...total, capturedSearches: 0 }), "tools");
  assert.equal(captureLevelOf({ ...total, capturedSearches: 0, toolDetailTurns: 0 }), "events");
});

test("the flow is deterministic and resolves open signals to ids and tints", () => {
  const build = () => {
    const turns = signalTurns([
      ...times(130, () => fresh().search(["magnet", "right"]).invoke("right")),
      ...times(25, () =>
        fresh().search(["find"]).invoke("find").search(["assign"]).invoke("assign"),
      ),
    ]);
    return analyzeTurns(turns, contextFor(turns));
  };
  const first = build();
  const second = build();
  assert.deepEqual(first.summary.flow, second.summary.flow);
  const flow = first.summary.flow;
  assert.equal(flow.nodes[0]?.id, "search");
  assert.deepEqual(
    flow.nodes.map((n) => n.id).slice(1, 4),
    ["right", "assign", "find"],
    "busiest first, ties by id",
  );
  const magnetKey = flow.nodes.find((n) => n.id === "magnet")!.signalKeys[0]!;
  const view = flowView(
    flow,
    [{ key: magnetKey, id: "sig-1", kind: "magnet" }],
    new Map([["magnet", "Create task"]]),
  );
  const magnet = view.nodes.find((n) => n.id === "magnet")!;
  assert.equal(magnet.tint, "magnet");
  assert.equal(magnet.label, "Create task");
  assert.deepEqual(magnet.signalIds, ["sig-1"]);
  assert.equal(view.nodes.find((n) => n.id === "right")?.tint, "healthy");
  assert.ok(
    view.edges.some((e) => e.kind === "sequence" && e.from === "find" && e.to === "assign"),
  );
});
