import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import { round4 } from "@/lib/readings/trace-signals/signals/build";
import { emptyOtelFacts, type OtelFacts } from "@/lib/readings/trace-signals/signals/otel-facts";
import {
  call,
  type OtelWorld,
  otelWorld,
  trace,
} from "@/lib/readings/trace-signals/signals/otel-test-fixtures";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import {
  contextFor,
  fresh,
  signalTurns,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import type {
  AnalysisContext,
  DetectedSignal,
  SignalTurn,
} from "@/lib/readings/trace-signals/signals/types";

const OTEL_KINDS = [
  "tool_switch",
  "empty_result",
  "unknown_tool",
  "unused_tool",
  "long_turn",
] as const;

function run(
  turns: readonly SignalTurn[],
  otel: OtelFacts | null | undefined,
  over: Partial<AnalysisContext> = {},
) {
  return analyzeTurns(turns, contextFor(turns, { otel, ...over }));
}

function analyze(world: OtelWorld, over: Partial<AnalysisContext> = {}) {
  return run(world.turns, world.facts, over);
}

function only(signals: readonly DetectedSignal[], kind: string): DetectedSignal[] {
  return signals.filter((s) => s.kind === kind);
}

/** The step id of the turn's `n`th tool call. */
function callId(t: SignalTurn, n: number): string {
  return t.steps.filter((s) => s.kind === "invoke")[n]!.traceEventId;
}

/* - tool_switch --------------------------------------------------------- */

test("tool_switch fires when a failing tool is followed by another that works, and links each turn to the failed call", () => {
  const world = otelWorld([
    ...times(12, () => trace([call("search_tasks", { error: "timeout" }), call("filter_tasks")])),
    ...times(18, () => trace([call("search_tasks")])),
  ]);
  const [signal, ...rest] = only(analyze(world).signals, "tool_switch");
  assert.equal(rest.length, 0);
  assert.ok(signal);
  assert.equal(signal.subjectKey, "search_tasks>filter_tasks");
  assert.deepEqual(signal.subjectIds, ["search_tasks", "filter_tasks"]);
  assert.equal(signal.lane, "otlp");
  assert.equal(signal.metrics.k, 12);
  assert.equal(signal.metrics.n, 30);
  assert.equal(signal.metrics.byError, 12);
  assert.equal(signal.severity, round4(wilsonLow(12, 30)));
  assert.equal(signal.evidence.totalTurns, 12);
  const byId = new Map(world.turns.map((t) => [t.id, t]));
  signal.evidence.turnIds.forEach((id, i) => {
    const t = byId.get(id)!;
    assert.equal(
      signal.evidence.traceEventIds[i],
      callId(t, 0),
      "the evidence points at the failed call",
    );
  });
});

test("tool_switch counts an empty captured result as a let-down, but not a switch to another empty result", () => {
  const world = otelWorld([
    ...times(10, () => trace([call("a", { empty: true }), call("b", { empty: false })])),
    ...times(10, () => trace([call("a", { empty: true }), call("c", { empty: true })])),
  ]);
  const signals = only(analyze(world).signals, "tool_switch");
  assert.deepEqual(
    signals.map((s) => s.subjectKey),
    ["a>b"],
  );
  assert.equal(signals[0]?.metrics.byEmpty, 10);
});

test("tool_switch stays silent below its floors", () => {
  const rare = otelWorld([
    ...times(12, () => trace([call("a", { error: "boom" }), call("b")])),
    ...times(88, () => trace([call("a")])),
  ]);
  assert.equal(only(analyze(rare).signals, "tool_switch").length, 0, "12 of 100 is under 20%");
  const few = otelWorld(times(9, () => trace([call("a", { error: "boom" }), call("b")])));
  assert.equal(only(analyze(few).signals, "tool_switch").length, 0, "9 turns is under 10");
  const retry = otelWorld(times(12, () => trace([call("a", { error: "boom" }), call("a")])));
  assert.equal(
    only(analyze(retry).signals, "tool_switch").length,
    0,
    "a retry of the same tool is no switch",
  );
});

/* - empty_result -------------------------------------------------------- */

test("empty_result fires on a tool whose captured results are mostly empty", () => {
  const world = otelWorld([
    ...times(15, () => trace([call("search_docs", { empty: true })])),
    ...times(10, () => trace([call("search_docs", { empty: false })])),
  ]);
  const result = analyze(world);
  const [signal] = only(result.signals, "empty_result");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "search_docs");
  assert.equal(signal.metrics.k, 15);
  assert.equal(signal.metrics.n, 25);
  assert.equal(signal.severity, round4(wilsonLow(15, 25)));
  assert.equal(signal.evidence.totalTurns, 15);
  assert.ok(result.measured.has("empty_result"));
});

test("empty_result is silent on a healthy tool and not measured without captured results", () => {
  const healthy = otelWorld([
    ...times(5, () => trace([call("search_docs", { empty: true })])),
    ...times(20, () => trace([call("search_docs", { empty: false })])),
  ]);
  assert.equal(only(analyze(healthy).signals, "empty_result").length, 0);
  const uncaptured = analyze(otelWorld(times(30, () => trace([call("search_docs")]))));
  assert.equal(uncaptured.measured.has("empty_result"), false);
  assert.ok(uncaptured.measured.has("tool_switch"), "errors alone still measure switches");
});

/* - unknown_tool -------------------------------------------------------- */

test("unknown_tool fires on calls failing with a tool-not-found error", () => {
  const world = otelWorld([
    ...times(5, () => trace([call("get_weather", { error: "ToolNotFoundError" }), call("search")])),
    ...times(20, () => trace([call("search")])),
  ]);
  const [signal] = only(analyze(world).signals, "unknown_tool");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "get_weather");
  assert.equal(signal.metrics.unknown, 5);
  assert.equal(signal.metrics.byError, 5);
  assert.equal(signal.evidence.totalTurns, 5);
});

test("unknown_tool ignores a not-found error from a tool that otherwise works", () => {
  const world = otelWorld([
    ...times(6, () => trace([call("get_task", { error: "TaskNotFound" })])),
    ...times(20, () => trace([call("get_task")])),
  ]);
  assert.equal(only(analyze(world).signals, "unknown_tool").length, 0);
  const four = otelWorld(times(4, () => trace([call("ghost", { error: "unknown_tool" })])));
  assert.equal(only(analyze(four).signals, "unknown_tool").length, 0, "4 calls is under 5");
});

test("unknown_tool fires on a called name missing from the captured menu", () => {
  const world = otelWorld(
    times(6, () =>
      trace([call("create_tiket"), call("create_ticket")], {
        modelCalls: 2,
        menu: ["create_ticket"],
      }),
    ),
  );
  const [signal] = only(analyze(world).signals, "unknown_tool");
  assert.equal(signal?.subjectKey, "create_tiket");
  assert.equal(signal?.metrics.byMenu, 6);
  assert.equal(signal?.metrics.byError, 0);
});

/* - unused_tool --------------------------------------------------------- */

const MENU = ["create_ticket", "export_board", "search"];

test("unused_tool is one finding listing every tool offered on each model call and never called", () => {
  const world = otelWorld(times(20, () => trace([call("search")], { modelCalls: 3, menu: MENU })));
  const result = analyze(world);
  const signals = only(result.signals, "unused_tool");
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.subjectKind, "project");
  assert.deepEqual(signals[0]?.subjectIds, ["create_ticket", "export_board"]);
  assert.equal(signals[0]?.metrics.tools, 2);
  assert.equal(signals[0]?.metrics.modelCalls, 60);
  assert.equal(signals[0]?.metrics.turns, 20);
  assert.equal(signals[0]?.route, "retire_tool");
  assert.ok(result.measured.has("unused_tool"));
});

test("unused_tool is silent when the tool was called anywhere, or offered too rarely", () => {
  const world = otelWorld(times(20, () => trace([call("search")], { modelCalls: 3, menu: MENU })));
  const sdk = signalTurns([fresh().search(["export_board"]).invoke("export_board")]);
  const signals = only(run([...world.turns, ...sdk], world.facts).signals, "unused_tool");
  assert.deepEqual(
    signals.flatMap((s) => s.subjectIds),
    ["create_ticket"],
    "export_board ran on the SDK lane",
  );
  const counted = analyze(world, {
    usage: [{ toolId: "create_ticket", calls: 2, lastUsedAt: new Date("2030-01-01T00:00:00Z") }],
  });
  assert.deepEqual(
    only(counted.signals, "unused_tool").flatMap((s) => s.subjectIds),
    ["export_board"],
  );
  const rare = otelWorld(times(19, () => trace([call("search")], { modelCalls: 3, menu: MENU })));
  assert.equal(only(analyze(rare).signals, "unused_tool").length, 0, "19 turns is under 20");
  const noMenus = analyze(otelWorld(times(20, () => trace([call("search")], { modelCalls: 3 }))));
  assert.equal(noMenus.measured.has("unused_tool"), false);
});

/* - long_turn ----------------------------------------------------------- */

test("long_turn fires on turns far above the median and names the tools they lean on", () => {
  const world = otelWorld([
    ...times(90, () => trace([call("search")], { modelCalls: 2, inputTokens: 100 })),
    ...times(10, () =>
      trace([call("search"), call("page_results"), call("page_results")], {
        modelCalls: 12,
        inputTokens: 900,
      }),
    ),
  ]);
  const [signal] = only(analyze(world).signals, "long_turn");
  assert.ok(signal);
  assert.equal(signal.subjectKind, "project");
  assert.deepEqual(
    signal.subjectIds,
    ["page_results"],
    "search runs everywhere, so it is not named",
  );
  assert.equal(signal.metrics.medianCalls, 2);
  assert.equal(signal.metrics.threshold, 8);
  assert.equal(signal.metrics.k, 10);
  assert.equal(signal.metrics.n, 100);
  assert.equal(signal.metrics.longInputTokens, 9_000);
  assert.equal(signal.metrics.inputTokens, 18_000);
  assert.equal(signal.severity, round4(wilsonLow(10, 100)));
  assert.equal(signal.evidence.totalTurns, 10);
});

test("long_turn is silent on too few long turns and without model calls", () => {
  const few = otelWorld([
    ...times(95, () => trace([call("search")], { modelCalls: 2 })),
    ...times(5, () => trace([call("search")], { modelCalls: 12 })),
  ]);
  assert.equal(only(analyze(few).signals, "long_turn").length, 0);
  const noModel = analyze(otelWorld(times(30, () => trace([call("search")]))));
  assert.equal(noModel.measured.has("long_turn"), false);
});

/* - Lanes --------------------------------------------------------------- */

function plantedWorld(): OtelWorld {
  return otelWorld([
    ...times(12, () =>
      trace([call("a", { error: "ToolNotFound" }), call("b", { empty: true })], {
        modelCalls: 12,
        menu: ["b", "x"],
      }),
    ),
    ...times(90, () => trace([call("b", { empty: true })], { modelCalls: 2, menu: ["b", "x"] })),
  ]);
}

test("every OTel kind fires on the planted world and none without OTel facts", () => {
  const world = plantedWorld();
  const fired = new Set(analyze(world).signals.map((s) => s.kind));
  for (const kind of ["empty_result", "unknown_tool", "unused_tool", "long_turn"])
    assert.ok(fired.has(kind as never), kind);
  for (const otel of [undefined, null]) {
    const result = run(world.turns, otel);
    for (const kind of OTEL_KINDS) {
      assert.equal(only(result.signals, kind).length, 0, `${kind} without facts`);
      assert.equal(result.measured.has(kind), false, `${kind} not measured without facts`);
    }
  }
});

test("an SDK-lane project reads exactly as before, with or without (empty) OTel facts", () => {
  const sdk = signalTurns([
    ...times(12, () => fresh().search(["a", "b"]).invoke("a").error("a").invoke("b")),
    ...times(30, () => fresh().search(["a"]).invoke("a")),
  ]);
  const before = run(sdk, undefined);
  const after = run(sdk, emptyOtelFacts());
  assert.deepEqual(after.signals, before.signals);
  assert.deepEqual([...after.measured].sort(), [...before.measured].sort());
  assert.deepEqual(after.summary, before.summary);
  for (const kind of OTEL_KINDS) assert.equal(only(after.signals, kind).length, 0, kind);
});
