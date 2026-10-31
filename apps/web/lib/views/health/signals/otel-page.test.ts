import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import {
  countJourneyPath,
  countJourneyPositions,
  createJourneyStats,
  finishJourney,
  turnJourney,
} from "@/lib/readings/trace-signals/signals/journey";
import {
  addOtelDays,
  emptyOtelDay,
  otelDayOf,
  otelTurnExtras,
} from "@/lib/readings/trace-signals/signals/otel-day";
import { call, otelWorld, trace } from "@/lib/readings/trace-signals/signals/otel-test-fixtures";
import {
  addBuckets,
  DailyBuckets,
  totalOver,
  turnBucket,
} from "@/lib/readings/trace-signals/signals/project-metrics";
import {
  contextFor,
  fresh,
  signalTurns,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import {
  classifyOtelTurnShape,
  classifyTurnShape,
  usesOtelShapes,
} from "@/lib/readings/trace-signals/signals/turn-facts";
import { OTEL_TURN_SHAPE_KINDS } from "@/lib/readings/trace-signals/view";
import {
  OTEL_UNLOCKS,
  otelCaptureLevel,
  otelCaptureUnlocks,
  otelShapesFor,
  otelTilesFor,
} from "@/lib/views/health/signals/otel-metrics";
import { buildHealthPageModel } from "@/lib/views/health/signals/page-view";

/**
 * The page for a project that only sends OpenTelemetry: the OTel turn shapes,
 * the band it can measure, the options its nudge names, and journeys that
 * start at the agent. SDK turns are checked to read exactly as before.
 */

const shapeOf = (calls: Parameters<typeof trace>[0]) => {
  const [turn] = otelWorld([trace(calls)]).turns;
  return classifyOtelTurnShape(turn!);
};

test("an OpenTelemetry turn takes one of five shapes, failures first", () => {
  assert.equal(shapeOf([call("a")]), "otel_direct", "one call that worked");
  assert.equal(
    shapeOf([call("a"), call("b"), call("c")]),
    "otel_chain",
    "different tools, all worked",
  );
  assert.equal(
    shapeOf([call("a"), call("b"), call("a")]),
    "otel_chain",
    "a tool coming back later is still a chain",
  );
  assert.equal(
    shapeOf([call("a"), call("a")]),
    "otel_chain",
    "the same tool twice with nothing failing is a repeat, not a retry",
  );
  assert.equal(
    shapeOf([call("a", { error: "timeout" }), call("a")]),
    "otel_retry",
    "failed, then the same tool again",
  );
  assert.equal(
    shapeOf([call("a", { error: "timeout" }), call("a"), call("a")]),
    "otel_retry",
    "a retry, then a repeat",
  );
  assert.equal(
    shapeOf([call("a", { error: "timeout" }), call("b")]),
    "otel_switched",
    "failed, then a different tool",
  );
  assert.equal(
    shapeOf([call("a", { error: "x" }), call("a", { error: "x" }), call("b")]),
    "otel_switched",
  );
  assert.equal(
    shapeOf([call("a"), call("b", { error: "boom" })]),
    "otel_failed",
    "the last call failed",
  );
  assert.equal(shapeOf([call("a", { error: "boom" })]), "otel_failed");
});

test("only OTLP turns that called a tool and never searched use the OpenTelemetry shapes", () => {
  const [otel] = otelWorld([trace([call("a")])]).turns;
  assert.equal(usesOtelShapes(otel!), true);
  const [sdkBlind] = signalTurns([fresh().invoke("a")]);
  assert.equal(usesOtelShapes(sdkBlind!), false, "an SDK turn keeps its own vocabulary");
  assert.equal(classifyTurnShape(sdkBlind!), "blind", "and still reads blind there");
  const [otlpSearch] = signalTurns([fresh({ lane: "otlp" }).search(["a"]).invoke("a")]);
  assert.equal(
    usesOtelShapes(otlpSearch!),
    false,
    "a Ratel search exported over OTel keeps the SDK shapes",
  );
});

test("an SDK turn's bucket is unchanged: no otel part at all", () => {
  const [sdk] = signalTurns([fresh().search(["a"]).invoke("a")]);
  const bucket = turnBucket(sdk!);
  assert.equal("otel" in bucket, false);
  assert.equal("otel" in addBuckets(bucket, bucket), false, "adding SDK days never invents one");
});

test("an OpenTelemetry turn adds to otel and takes no SDK shape (never blind)", () => {
  const [otel] = otelWorld([trace([call("a", { error: "x" }), call("b")])]).turns;
  const bucket = turnBucket(otel!);
  assert.equal(bucket.shaped, 0);
  assert.equal(bucket.shapes.blind, 0);
  assert.equal(bucket.otel?.turns, 1);
  assert.equal(bucket.otel?.shapes.otel_switched, 1);
  assert.equal(bucket.otel?.failedCalls, 1);
  assert.equal(bucket.otel?.completed, 1, "it ended on a call that worked");
});

test("a turn's OTel extras read round trips, capture and a real conversation id", () => {
  const world = otelWorld([
    trace([call("a", { empty: true })], { modelCalls: 3, menu: ["a", "b"], session: "conv-1" }),
    trace([call("a")]),
  ]);
  const [rich, bare] = world.turns;
  assert.deepEqual(otelTurnExtras(rich!, world.facts), {
    roundTrips: 3,
    resultsCaptured: true,
    menuCaptured: true,
    hasSession: true,
  });
  assert.deepEqual(otelTurnExtras(bare!, world.facts), {
    roundTrips: null,
    resultsCaptured: false,
    menuCaptured: false,
    hasSession: false,
  });
  assert.equal(
    otelTurnExtras(bare!, null).hasSession,
    false,
    "the session falls back to the trace id",
  );
});

test("otel days add field by field, and one side missing keeps the other", () => {
  const [turn] = otelWorld([trace([call("a", { error: "timeout" }), call("a")])]).turns;
  const one = otelDayOf(turn!, {
    roundTrips: 4,
    resultsCaptured: false,
    menuCaptured: true,
    hasSession: false,
  });
  assert.equal(one.wasted, 1, "the retry is wasted");
  const two = addOtelDays(one, one)!;
  assert.equal(two.turns, 2);
  assert.equal(two.roundTrips, 8);
  assert.equal(two.shapes.otel_retry, 2);
  assert.deepEqual(addOtelDays(undefined, one), one);
  assert.equal(addOtelDays(undefined, undefined), undefined);
  assert.deepEqual(emptyOtelDay().shapes, {
    otel_direct: 0,
    otel_chain: 0,
    otel_retry: 0,
    otel_switched: 0,
    otel_failed: 0,
  });
});

function otelTotal(specs: Parameters<typeof otelWorld>[0]) {
  const world = otelWorld(specs);
  const daily = new DailyBuckets();
  for (const t of world.turns) daily.add(t, undefined, otelTurnExtras(t, world.facts));
  const values = daily.values();
  return {
    world,
    values,
    total: totalOver(
      values,
      values.map((b) => b.day),
    ),
  };
}

test("the OpenTelemetry band reads completed, failed calls, wasted calls and round trips", () => {
  const { values, total, world } = otelTotal([
    ...times(6, () => trace([call("a"), call("b")], { modelCalls: 2 })),
    ...times(2, () => trace([call("a"), call("b", { error: "x" })], { modelCalls: 4 })),
  ]);
  const end = new Date(Math.max(...world.turns.map((t) => t.endedAt.getTime())) + 86_400_000);
  const tiles = otelTilesFor(values, { end, days: 7, coveredFrom: values[0]!.day, floor: 1 });
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["completed", "failed_calls", "wasted_calls", "round_trips"],
  );
  const [completed, failed, , trips] = tiles;
  assert.equal(completed!.value, 6 / 8);
  assert.equal(failed!.value, 2 / 16);
  assert.equal(trips!.value, (6 * 2 + 2 * 4) / 8);
  assert.equal(trips!.unit, "per_turn");
  assert.equal(total.otel?.turns, 8);
});

test("without model calls the band has three tiles, not a tile that only ever reads a dash", () => {
  const { values, world } = otelTotal(times(4, () => trace([call("a")])));
  const end = new Date(Math.max(...world.turns.map((t) => t.endedAt.getTime())) + 86_400_000);
  const tiles = otelTilesFor(values, { end, days: 7, coveredFrom: values[0]!.day, floor: 1 });
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["completed", "failed_calls", "wasted_calls"],
  );
});

test("the five OpenTelemetry shapes partition the runs, most common first", () => {
  const { total } = otelTotal([
    ...times(3, () => trace([call("a"), call("b")])),
    trace([call("a")]),
    trace([call("a", { error: "x" })]),
  ]);
  const shapes = otelShapesFor(total);
  assert.deepEqual(new Set(shapes.map((s) => s.shape)), new Set(OTEL_TURN_SHAPE_KINDS));
  assert.equal(shapes[0]!.shape, "otel_chain");
  assert.equal(shapes[0]!.label, "Chain");
  assert.equal(
    shapes.reduce((sum, s) => sum + s.count, 0),
    5,
  );
  assert.ok(shapes.every((s) => !/blind/i.test(s.label + s.description)));
});

test("the nudge names only the OpenTelemetry options still off", () => {
  const off = otelTotal(times(4, () => trace([call("a")])));
  assert.deepEqual(
    otelCaptureUnlocks(off.total).map((u) => u.key),
    [OTEL_UNLOCKS.content.key, OTEL_UNLOCKS.definitions.key, OTEL_UNLOCKS.conversation.key],
  );
  assert.equal(otelCaptureLevel(off.total), "tools");
  const on = otelTotal(
    times(4, (i) =>
      trace([call("a", { empty: false })], { modelCalls: 1, menu: ["a"], session: `conv-${i}` }),
    ),
  );
  assert.deepEqual(otelCaptureUnlocks(on.total), []);
  assert.equal(otelCaptureLevel(on.total), "content");
});

test("an OpenTelemetry journey starts at the agent, an SDK one still at no search", () => {
  const [otel] = otelWorld([trace([call("a"), call("b")])]).turns;
  assert.equal(turnJourney(otel!)?.start, "agent");
  const [sdk] = signalTurns([fresh().invoke("a")]);
  assert.equal(turnJourney(sdk!)?.start, "none");
  const stats = createJourneyStats();
  countJourneyPositions(stats, otel!);
  countJourneyPath(stats, otel!);
  assert.equal(finishJourney(stats)?.paths[0]?.s, "agent");
});

test("a run from OpenTelemetry only builds the OpenTelemetry page", () => {
  const world = otelWorld(
    times(60, (i) => trace([call("a"), call(i % 4 === 0 ? "c" : "b")], { modelCalls: 2 })),
  );
  const context = contextFor(world.turns, { otel: world.facts });
  const result = analyzeTurns(world.turns, context);
  const model = buildHealthPageModel(
    {
      windowDays: 7,
      run: {
        windowEnd: context.windowEnd,
        windowDays: 7,
        finishedAt: context.windowEnd,
        summary: result.summary,
        turnSourceMix: result.turnSourceMix,
      },
      liveTurns: 0,
      signals: [],
      evidence: new Map(),
      names: new Map(),
    },
    context.windowEnd,
  );
  assert.equal(model.sourceMode, "otel");
  assert.deepEqual(
    model.tiles.map((t) => t.key),
    ["completed", "failed_calls", "wasted_calls", "round_trips"],
  );
  assert.ok(model.shapes.every((s) => s.shape.startsWith("otel_")));
  assert.ok(model.captureUnlocks.some((u) => u.key === OTEL_UNLOCKS.conversation.key));
  assert.ok(model.flow.journey?.paths.every((p) => p.start === "agent"));
  assert.ok(model.workflows, "a run with tool calls stores its workflows");
  assert.ok(model.workflows!.items.length > 0);
  assert.ok(
    model.workflows!.items.every((row) => row.steps.length >= 2 && row.examples.length > 0),
  );
});

test("an SDK run keeps the SDK page, with no source badge and no workflows when none were stored", () => {
  const turns = signalTurns(times(60, () => fresh().search(["a"]).invoke("a")));
  const context = contextFor(turns);
  const result = analyzeTurns(turns, context);
  const model = buildHealthPageModel(
    {
      windowDays: 7,
      run: {
        windowEnd: context.windowEnd,
        windowDays: 7,
        finishedAt: null,
        summary: result.summary,
        turnSourceMix: result.turnSourceMix,
      },
      liveTurns: 0,
      signals: [],
      evidence: new Map(),
      names: new Map(),
    },
    context.windowEnd,
  );
  assert.equal(model.sourceMode, "sdk");
  assert.deepEqual(
    model.tiles.map((t) => t.key),
    ["first_try", "detours", "junk", "wasted_calls"],
  );
  assert.equal(model.shapes.length, 6);
});
